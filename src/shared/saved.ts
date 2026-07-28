// The panel's "Saved" history: one receipt per completed download.
//
// Enough to RENDER a Saved card after media_<tabId> is wiped (Clear, navigation,
// eviction), never enough to re-download — media URLs carry rotating fbcdn
// signatures, so a stored one would be a download button that lies.
//
// The receipt's `id` is the panel card id (`v:${groupKey}` / `i:${itemId}`):
// content-derived, so replaying the content rebuilds a live card with the same id and
// the receipt re-links to it by itself. That id format is a persisted contract — change
// it only with a migration.
//
// Per-tab keys, not one global ledger. The service worker owns every receipt, so its
// one serial lane orders completions from all panel windows.

import { isFbcdn, MEDIA_KINDS, MEDIA_SOURCES, type MediaKind, type MediaSource } from './media';
import { dataValues, isStorageQuotaError, readKey, serialQueue } from './session-write';

export interface SavedEntry {
  id: string;
  kind: MediaKind;
  source: MediaSource;
  /** Download time — the Saved view's sort key. Frozen on the first save. */
  savedAt: number;
  /** fbcdn poster/self URL. Its signature expires; the card's <img> error path degrades
   *  it to the kind icon. Shed first under quota pressure. */
  thumbUrl?: string;
  resLabel?: string;
  durationSec?: number;
}

const savedKey = (tabId: number): string => `saved_${tabId}`;
// Insertion-ordered, so the cap below evicts the oldest receipts first.
const SAVED_MAX = 2000;
// Soft byte budget for one tab's serialized ledger (Chrome bills key length + JSON
// length against the ~10 MB shared area). Past it, thumbnails are shed oldest-first:
// the history row is the promise, the thumb is decoration whose signature has usually
// expired by then anyway.
const SAVED_BYTE_BUDGET = 262_144;
export const SAVED_THUMB_MAX = 1024; // fbcdn image URLs run 300–500 chars; drop outliers
export const SAVED_LABEL_MAX = 16;
/** The card-id contract: a 2-char 'v:'/'i:' prefix over media.ts's 256-char item-id
 *  bound. Exported so the worker's inbound-receipt validation stays compile-time linked
 *  to this bound instead of carrying its own copy. */
export const SAVED_ID_MAX = 258;
const enqueueSaved = serialQueue();

function isSavedEntry(x: unknown): x is SavedEntry {
  if (x == null || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    typeof e.kind === 'string' &&
    MEDIA_KINDS.has(e.kind) &&
    typeof e.source === 'string' &&
    MEDIA_SOURCES.has(e.source) &&
    typeof e.savedAt === 'number' &&
    Number.isFinite(e.savedAt)
  );
}

/** Clamp one receipt to its stored bounds — applied to every entry that enters the
 *  ledger, whether new or refreshing an existing row. */
function sanitizeEntry(e: SavedEntry): SavedEntry {
  const out: SavedEntry = {
    // Never below SAVED_ID_MAX: a truncated receipt can never re-link to its live card.
    id: e.id.slice(0, SAVED_ID_MAX),
    kind: e.kind,
    source: e.source,
    savedAt: e.savedAt,
  };
  // isSavedEntry does not validate the optional fields, and this runs on every
  // persisted row, so each check carries its own type test: a malformed field from a
  // corrupt or foreign write must degrade to absent, never take the whole read down.
  if (typeof e.thumbUrl === 'string' && e.thumbUrl.length <= SAVED_THUMB_MAX && isFbcdn(e.thumbUrl)) {
    out.thumbUrl = e.thumbUrl;
  }
  if (typeof e.resLabel === 'string') out.resLabel = e.resLabel.slice(0, SAVED_LABEL_MAX);
  if (typeof e.durationSec === 'number' && Number.isFinite(e.durationSec)) out.durationSec = e.durationSec;
  return out;
}

async function readSaved(key: string): Promise<SavedEntry[]> {
  const raw = await readKey<unknown>(key, []);
  return Array.isArray(raw) ? raw.filter(isSavedEntry).map(sanitizeEntry) : [];
}

/** Enforce the byte budget by stripping thumbnails oldest-first — never rows. The
 *  serialized length is computed once and decremented by an estimate of each shed
 *  thumb's JSON footprint instead of re-stringifying per iteration; the budget is
 *  soft, so the estimate is enough. */
function shedThumbs(key: string, entries: SavedEntry[]): void {
  let bytes = key.length + JSON.stringify(entries).length;
  for (const e of entries) {
    if (bytes <= SAVED_BYTE_BUDGET) return;
    if (e.thumbUrl == null) continue;
    bytes -= `"thumbUrl":${JSON.stringify(e.thumbUrl)},`.length;
    delete e.thumbUrl;
  }
}

/** Record one download receipt (each save persists as it lands — see runBulk).
 *  Idempotent: re-saving an id keeps its first position and original savedAt,
 *  refreshing only the display fields, since a re-download carries a newer-signed
 *  thumb that will live longer. */
export function addSaved(tabId: number, entry: SavedEntry): Promise<void> {
  let failure: unknown;
  return enqueueSaved(
    async () => {
      const key = savedKey(tabId);
      const cur = await readSaved(key);
      const e = sanitizeEntry(entry);
      const kept = cur.find((x) => x.id === e.id);
      if (kept) Object.assign(kept, e, { savedAt: kept.savedAt });
      else cur.push(e);
      if (cur.length > SAVED_MAX) cur.splice(0, cur.length - SAVED_MAX);
      shedThumbs(key, cur);
      try {
        await chrome.storage.session.set(dataValues({ [key]: cur }));
      } catch (err) {
        if (!isStorageQuotaError(err)) {
          // Download completion is a one-shot event. A transient backend error must
          // retry the intact ledger, never masquerade as quota and delete half of the
          // user's Saved history.
          await chrome.storage.session.set(dataValues({ [key]: cur }));
          return;
        }
        // The byte budget is an estimate against a SHARED quota another tab may have
        // filled: as a last resort drop the oldest half and retry once. Never the
        // receipt being written — on a short ledger the "oldest half" IS the new entry,
        // and dropping it would resolve as success while losing the row. Re-append the
        // MERGED row when one existed: it carries the original savedAt this function's
        // contract preserves.
        cur.splice(0, Math.ceil(cur.length / 2));
        if (!cur.some((x) => x.id === e.id)) cur.push(kept ?? e);
        await chrome.storage.session.set(dataValues({ [key]: cur }));
      }
    },
    (err) => {
      failure = err;
      console.error('[FaceScrap] saved write failed', err);
    },
  ).then(() => {
    if (failure !== undefined) throw failure;
  });
}

export async function getSaved(tabId: number): Promise<SavedEntry[]> {
  return readSaved(savedKey(tabId));
}

/** Remove one tab's ledger on the same worker-owned lane as addSaved, so a finishing
 *  receipt is ordered before or after this removal rather than racing it. */
export function dropSaved(tabId: number): Promise<void> {
  return enqueueSaved(
    () => chrome.storage.session.remove(savedKey(tabId)),
    (err) => console.error('[FaceScrap] storage clear failed', err),
  );
}
