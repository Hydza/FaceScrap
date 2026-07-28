// Diagnostic counters, opt-in at both trust boundaries (see diag.ts).
//
// This script is the only capture context that can both read settings and talk to the
// worker, so it owns the flag for the MAIN-world hook as well as for its own DOM scan.

import { sanitizeDiagCounters, setDiagEnabled, type DiagReason } from '../shared/diag';
import {
  diagLog,
  diagLogDrain,
  sanitizeDiagEvents,
  setDiagContext,
  setDiagLogEnabled,
  type DiagEvent,
} from '../shared/diag-log';
import { loadSettings } from '../shared/settings';
import { createCounterCoalescer } from './content-ingress-limits';
import type { ContentRuntime } from './content-runtime';

const DIAG_REPORT_INTERVAL_MS = 1_000;
/** Events held between reports. Bounds one flush interval of a page-hook burst;
 *  the worker's observer applies its own, larger bound behind this one. */
const DIAG_EVENT_QUEUE_MAX = 300;

interface DiagChannel {
  /** Accumulate counts and trace from the page hook or this script. Dropped while
   *  disabled. */
  report: (counters: unknown, events?: unknown) => void;
  /** Record one event from THIS script and make sure it gets reported. The bands
   *  cannot just call diagLog: the report timer is armed here, so an event logged
   *  by a band that never reports counters would sit in the ring unsent. */
  note: (ev: string, data?: Record<string, string | number | boolean>, lvl?: 'warn' | 'error') => void;
  /** Tell the MAIN-world hook the current flag, from cache — never a storage read. */
  announce: () => void;
  enabled: () => boolean;
}

export function setupDiagChannel(runtime: ContentRuntime): DiagChannel {
  setDiagContext('content');
  const reports = createCounterCoalescer<DiagReason>();
  let queued: DiagEvent[] = [];
  let dropped = 0;
  let enabled = false;
  let flushTimer: number | undefined;

  const clearPending = (): void => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    reports.drain();
    queued = [];
    dropped = 0;
    diagLogDrain();
  };

  const flush = (): void => {
    flushTimer = undefined;
    if (!enabled || runtime.isDisposed()) {
      clearPending();
      return;
    }
    const counters = reports.drain();
    // This script's OWN events (diagLog calls from the detector bands) join
    // whatever the page hook handed over, in one message.
    const events = [...queued, ...diagLogDrain()];
    queued = [];
    if (dropped > 0) {
      events.unshift({ at: Date.now(), ctx: 'content', ev: 'logOverflow', lvl: 'warn', data: { dropped } });
      dropped = 0;
    }
    if (Object.keys(counters).length === 0 && events.length === 0) return;
    runtime.send({ type: 'DIAG_REPORT', counters, events, documentToken: runtime.documentToken });
  };

  const armFlush = (): void => {
    if (flushTimer === undefined) flushTimer = window.setTimeout(flush, DIAG_REPORT_INTERVAL_MS);
  };

  const announce = (): void => {
    if (!runtime.alive()) return;
    window.postMessage({ __facescrapCtl: true, diag: enabled }, '*');
  };

  const publish = (): void => {
    if (!runtime.alive()) return;
    void loadSettings()
      .then((s) => {
        if (runtime.isDisposed()) return;
        enabled = s.diagEnabled;
        setDiagEnabled(s.diagEnabled);
        setDiagLogEnabled(s.diagEnabled);
        if (!s.diagEnabled) clearPending();
        else {
          diagLog('contentReady', { url: location.pathname });
          // Armed, not just logged. This is the first event of every session and
          // nothing else is guaranteed to report afterwards on an idle tab, so a
          // bare diagLog here leaves the trace looking as if the content script
          // never started.
          armFlush();
        }
        window.postMessage({ __facescrapCtl: true, diag: s.diagEnabled }, '*');
      })
      .catch(() => {
        enabled = false;
        setDiagEnabled(false);
        setDiagLogEnabled(false);
        clearPending();
      });
  };

  publish();
  // A page being unloaded is exactly when the last events matter (the navigation
  // that lost the capture), and the report timer would not fire again.
  window.addEventListener('pagehide', flush, { signal: runtime.signal });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'settings' in changes) publish();
    });
  } catch {
    /* context gone — the flag stays off */
  }
  runtime.onTeardown(clearPending);

  return {
    report: (counters, events) => {
      // window.postMessage is shared with the page. Never let a co-resident page script
      // turn this opt-in maintenance channel on by forging hook messages.
      if (!enabled) return;
      const clean = sanitizeDiagCounters(counters);
      // Sanitized HERE as well as in the worker: this is the boundary with the
      // page's own process, and the queue below must be bounded by shape before
      // it is bounded by count.
      const cleanEvents = sanitizeDiagEvents(events, DIAG_EVENT_QUEUE_MAX);
      if (Object.keys(clean).length === 0 && cleanEvents.length === 0) return;
      if (Object.keys(clean).length > 0) reports.add(clean);
      for (const event of cleanEvents) {
        queued.push(event);
        if (queued.length > DIAG_EVENT_QUEUE_MAX) {
          queued.shift();
          dropped += 1;
        }
      }
      armFlush();
    },
    note: (ev, data, lvl) => {
      if (!enabled) return;
      diagLog(ev, data, lvl);
      armFlush();
    },
    announce,
    enabled: () => enabled,
  };
}
