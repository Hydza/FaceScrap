// Diagnostic counters and event trace, persisted (see diag.ts for why they exist).
//
// Keep diagnostics in storage.local so evidence survives browser restarts.

import { serialQueue } from './async';
import { sanitizeDiagCounters, type DiagCounters, type DiagReason } from './diag';
import { sanitizeDiagEvents, type DiagEvent } from './diag-log';

const DIAG_KEY = 'diag_counters';
const LOG_KEY = 'diag_log';
const enqueueDiag = serialQueue();
// Its own lane, not the counters': the two keys are independent, and a log append
// under a scroll burst must not make a counter flush wait behind it.
const enqueueLog = serialQueue();

/** How much trace is kept. Both bounds are enforced on every append — the count
 *  keeps the panel's render cheap, and the byte cap is what keeps this off
 *  storage.local's quota, which the settings and the language key share. A
 *  session long enough to need more than this is one where the newest events are
 *  the ones being asked about, so the ring drops from the OLD end. */
export const DIAG_LOG_MAX_EVENTS = 2_000;
const DIAG_LOG_MAX_BYTES = 700 * 1024;

/** Trim to both bounds, oldest first. Exported so the byte bound can be verified
 *  without depending on a real storage quota. */
export function trimDiagLog(events: DiagEvent[]): DiagEvent[] {
  const out = events.length > DIAG_LOG_MAX_EVENTS ? events.slice(events.length - DIAG_LOG_MAX_EVENTS) : events;
  // Serialize each event once, then update the exact JSON array size as old entries drop.
  const sizes = out.map((event) => JSON.stringify(event).length);
  let total = 2;
  for (const size of sizes) total += size + 1;
  if (sizes.length > 0) total -= 1; // n elements carry n-1 commas
  let start = 0;
  while (start < out.length && total > DIAG_LOG_MAX_BYTES) {
    total -= sizes[start] + 1;
    start++;
  }
  return start === 0 ? out : out.slice(start);
}

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

/** Append one context's drained events to the stored trace.
 *
 *  Appends rather than replaces, for the same reason addDiagCounters adds rather
 *  than sets: the worker, the panel and the offscreen document each flush on
 *  their own schedule, and a plain set() would let whichever flushed last erase
 *  the others' trace. Ordering across contexts is by each event's own `at`, not
 *  by arrival — the reader sorts. */
export function addDiagEvents(events: DiagEvent[]): Promise<void> {
  return enqueueLog(
    async () => {
      // Re-sanitized even though the sender already did — the page hook's events
      // cross a world boundary it shares with the page. Doing it here covers
      // every caller at once (same argument as addDiagCounters above).
      const clean = sanitizeDiagEvents(events, DIAG_LOG_MAX_EVENTS);
      if (clean.length === 0) return;
      const stored = sanitizeDiagEvents((await chrome.storage.local.get(LOG_KEY))[LOG_KEY], DIAG_LOG_MAX_EVENTS);
      await chrome.storage.local.set({ [LOG_KEY]: trimDiagLog([...stored, ...clean]) });
    },
    (err) => console.error('[FaceScrap] diag log write failed', err),
  );
}

/** The stored trace, oldest first. */
export async function getDiagEvents(): Promise<DiagEvent[]> {
  try {
    const stored = sanitizeDiagEvents((await chrome.storage.local.get(LOG_KEY))[LOG_KEY], DIAG_LOG_MAX_EVENTS);
    return stored.sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

export function resetDiagLog(): Promise<void> {
  return enqueueLog(
    () => chrome.storage.local.remove(LOG_KEY),
    (err) => console.error('[FaceScrap] diag log clear failed', err),
  );
}
