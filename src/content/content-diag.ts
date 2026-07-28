// Diagnostic counters, opt-in at both trust boundaries (see diag.ts).
//
// This script is the only capture context that can both read settings and talk to the
// worker, so it owns the flag for the MAIN-world hook as well as for its own DOM scan.

import { sanitizeDiagCounters, setDiagEnabled, type DiagReason } from '../shared/diag';
import { loadSettings } from '../shared/settings';
import { createCounterCoalescer } from './content-ingress-limits';
import type { ContentRuntime } from './content-runtime';

const DIAG_REPORT_INTERVAL_MS = 1_000;

interface DiagChannel {
  /** Accumulate counts from the page hook or this script. Dropped while disabled. */
  report: (counters: unknown) => void;
  /** Tell the MAIN-world hook the current flag, from cache — never a storage read. */
  announce: () => void;
  enabled: () => boolean;
}

export function setupDiagChannel(runtime: ContentRuntime): DiagChannel {
  const reports = createCounterCoalescer<DiagReason>();
  let enabled = false;
  let flushTimer: number | undefined;

  const clearPending = (): void => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    reports.drain();
  };

  const flush = (): void => {
    flushTimer = undefined;
    if (!enabled || runtime.isDisposed()) {
      reports.drain();
      return;
    }
    const counters = reports.drain();
    if (Object.keys(counters).length > 0) {
      runtime.send({ type: 'DIAG_REPORT', counters, documentToken: runtime.documentToken });
    }
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
        if (!s.diagEnabled) clearPending();
        window.postMessage({ __facescrapCtl: true, diag: s.diagEnabled }, '*');
      })
      .catch(() => {
        enabled = false;
        setDiagEnabled(false);
        clearPending();
      });
  };

  publish();
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'settings' in changes) publish();
    });
  } catch {
    /* context gone — the flag stays off */
  }
  runtime.onTeardown(clearPending);

  return {
    report: (counters) => {
      // window.postMessage is shared with the page. Never let a co-resident page script
      // turn this opt-in maintenance channel on by forging hook messages.
      if (!enabled) return;
      const clean = sanitizeDiagCounters(counters);
      if (Object.keys(clean).length === 0) return;
      reports.add(clean);
      if (flushTimer === undefined) flushTimer = window.setTimeout(flush, DIAG_REPORT_INTERVAL_MS);
    },
    announce,
    enabled: () => enabled,
  };
}
