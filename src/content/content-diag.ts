// Diagnostic counters and trace on their way to the worker (see diag.ts).
//
// This context forwards both MAIN-world hook reports and its own DOM-scan reports
// to the worker. Diagnostics are always enabled.

import {
  createCounterCoalescer,
  sanitizeDiagCounters,
  type DiagReason,
} from '../shared/diag';
import {
  createEventRing,
  DIAG_EVENT_MAX,
  diagLog,
  diagLogDrain,
  sanitizeDiagEvents,
  setDiagContext,
} from '../shared/diag-log';
import type { ContentRuntime } from './content-runtime';

/** Coalesce reports long enough to avoid keeping the service worker awake on an
 *  active feed while remaining inside its idle window. */
const DIAG_REPORT_INTERVAL_MS = 5_000;
/** Events held between reports. Bounds one flush interval of a page-hook burst;
 *  the worker's observer applies its own, larger bound behind this one. */
const DIAG_EVENT_QUEUE_MAX = 300;

/** Record one traced event. Detector bands share this type and field contract. */
export type NoteFn = (
  ev: string,
  data?: Record<string, string | number | boolean>,
  lvl?: 'warn' | 'error',
) => void;

interface DiagChannel {
  /** Accumulate counts and trace from the page hook or this script. */
  report: (counters: unknown, events?: unknown) => void;
  /** Record one event from THIS script and make sure it gets reported. The bands
   *  cannot just call diagLog: the report timer is armed here, so an event logged
   *  by a band that never reports counters would sit in the ring unsent. */
  note: NoteFn;
}

export function setupDiagChannel(runtime: ContentRuntime): DiagChannel {
  setDiagContext('content');
  const reports = createCounterCoalescer<DiagReason>();
  const queued = createEventRing(DIAG_EVENT_QUEUE_MAX);
  let flushTimer: number | undefined;

  const clearPending = (): void => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    reports.drain();
    queued.clear();
    diagLogDrain();
  };

  const flush = (): void => {
    flushTimer = undefined;
    if (runtime.isDisposed()) {
      clearPending();
      return;
    }
    const counters = reports.drain();
    // This script's OWN events (diagLog calls from the detector bands) join
    // whatever the page hook handed over, in one message.
    // `where` disambiguates the overflow markers: this bundle drains TWO rings
    // into one message, and an unlabelled logOverflow would not say which lost.
    const events = [...queued.drain('content', { where: 'hook' }), ...diagLogDrain()];
    if (Object.keys(counters).length === 0 && events.length === 0) return;
    runtime.send({ type: 'DIAG_REPORT', counters, events, documentToken: runtime.documentToken });
  };

  const armFlush = (): void => {
    if (flushTimer === undefined) flushTimer = window.setTimeout(flush, DIAG_REPORT_INTERVAL_MS);
  };

  diagLog('contentReady', { url: location.pathname });
  // Armed, not just logged. This is the first event of every session and nothing else
  // is guaranteed to report afterwards on an idle tab, so a bare diagLog here leaves
  // the trace looking as if the content script never started.
  armFlush();
  // A page being unloaded is exactly when the last events matter (the navigation
  // that lost the capture), and the report timer would not fire again.
  window.addEventListener('pagehide', flush, { signal: runtime.signal });
  runtime.onTeardown(clearPending);

  return {
    report: (counters, events) => {
      // Everything here arrives on a window the page shares. With no switch left to
      // forge, what a co-resident script can still do is post junk counters and events:
      // bounded by the sanitizer's shape rules, then by this queue's ring, then by the
      // worker observer's, then by the stored trace's caps — and it buys nothing outside
      // diagnostics. Every one of those rings reports the gap it made.
      const clean = sanitizeDiagCounters(counters);
      // Sanitized HERE as well as in the worker: this is the boundary with the
      // page's own process, and the queue below must be bounded by shape before
      // it is bounded by count.
      //
      // The cap passed here is the HOOK's ring size, not this queue's: the hook can
      // legitimately hand over its whole ring plus an overflow marker in one flush,
      // and sanitizeDiagEvents truncates silently. Cutting to the queue's smaller
      // cap here would drop the tail BEFORE the loop below could count it, and the
      // report would then say zero events were lost while up to a hundred were.
      const cleanEvents = sanitizeDiagEvents(events, DIAG_EVENT_MAX + 1);
      if (Object.keys(clean).length === 0 && cleanEvents.length === 0) return;
      if (Object.keys(clean).length > 0) reports.add(clean);
      for (const event of cleanEvents) queued.push(event);
      armFlush();
    },
    note: (ev, data, lvl) => {
      diagLog(ev, data, lvl);
      armFlush();
    },
  };
}
