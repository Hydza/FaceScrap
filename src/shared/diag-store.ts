// Diagnostic counters (opt-in; see diag.ts for why they exist).
//
// storage.LOCAL, unlike every capture key: these answer "what has this install been
// dropping?", a question asked across sessions. In storage.session the evidence would
// be wiped at the exact moment a maintainer restarts the browser to reproduce a bug.

import { sanitizeDiagCounters, type DiagCounters, type DiagReason } from './diag';
import { serialQueue } from './session-write';

const DIAG_KEY = 'diag_counters';
const enqueueDiag = serialQueue();

/** Merge one context's drained counts into the running totals. Contexts report
 *  independently (page hook via the content script, worker, panel), so this ADDS
 *  rather than replaces — a plain set() would let whichever context flushed last
 *  erase the others' counts. */
export function addDiagCounters(delta: DiagCounters): Promise<void> {
  return enqueueDiag(
    async () => {
      // Re-sanitized even though the sender already did: the page hook's counts cross a
      // world boundary it shares with the page, same threat model as
      // sanitizeIncomingItems. Doing it here covers every caller at once.
      const clean = sanitizeDiagCounters(delta);
      if (Object.keys(clean).length === 0) return;
      const stored = sanitizeDiagCounters((await chrome.storage.local.get(DIAG_KEY))[DIAG_KEY]);
      for (const [reason, n] of Object.entries(clean)) {
        const key = reason as DiagReason;
        stored[key] = (stored[key] ?? 0) + n;
      }
      await chrome.storage.local.set({ [DIAG_KEY]: stored });
    },
    (err) => console.error('[FaceScrap] diag write failed', err),
  );
}

export async function getDiagCounters(): Promise<DiagCounters> {
  try {
    return sanitizeDiagCounters((await chrome.storage.local.get(DIAG_KEY))[DIAG_KEY]);
  } catch {
    return {};
  }
}

export function resetDiagCounters(): Promise<void> {
  return enqueueDiag(
    () => chrome.storage.local.remove(DIAG_KEY),
    (err) => console.error('[FaceScrap] diag clear failed', err),
  );
}
