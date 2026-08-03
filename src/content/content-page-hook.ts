// The trust boundary with the MAIN-world hook.
//
// The hook posts on the shared window, so `e.source === window` cannot prove the sender
// is ours: a co-resident page script can forge every message below. Nothing here is
// believed — items are sanitized and charged against an ingress budget, diagnostics are
// re-sanitized and bounded by rings that report their own gaps, and the only side effect
// a forged message can buy is work the page could already do to itself.

import { diagBump } from '../shared/diag';
import { MAX_ITEMS_PER_MESSAGE, mediaItemWeight, sanitizeIncomingItems, type MediaItem } from '../shared/media';
import { createDiagIngressBudget, createMediaIngressBudget, createNavIngressBudget } from './content-ingress-limits';
import { MEDIA_QUEUE_MAX_BYTES } from './content-media-relay';
import type { ContentRuntime } from './content-runtime';

interface PageHookDeps {
  relay: (items: MediaItem[]) => void;
  reportDiag: (counters: unknown, events?: unknown) => void;
  /** An SPA navigation: re-detect now instead of waiting for a poller tick. */
  onNavigation: () => void;
}

export function setupPageHookIngress(runtime: ContentRuntime, deps: PageHookDeps): void {
  const mediaBudget = createMediaIngressBudget(performance.now());
  const navBudget = createNavIngressBudget(performance.now());
  const diagBudget = createDiagIngressBudget(performance.now());

  window.addEventListener(
    'message',
    (e) => {
      if (e.source !== window) return;
      const data = e.data;
      if (!data || data.__vpData !== true) return;
      if (data.diag !== undefined || data.log !== undefined) {
        // Charge diagnostics against their own budget so co-resident scripts cannot
        // fill the persistent event ring with forged reports.
        if (diagBudget.tryTake(1, 1, performance.now())) deps.reportDiag(data.diag, data.log);
        return;
      }
      if (data.nav === true) {
        // Forgeable, but the worst it buys is a call that only reads already-visible
        // DOM — the same reach a synthetic scroll event would have.
        if (navBudget.tryTake(1, 1, performance.now())) deps.onNavigation();
        return;
      }
      // The real hook chunks at this exact bound. Reject an oversized forged array
      // before sanitization so even calculating its charge stays bounded.
      if (!Array.isArray(data.items) || data.items.length > MAX_ITEMS_PER_MESSAGE) return;
      const items = sanitizeIncomingItems(data.items, MEDIA_QUEUE_MAX_BYTES);
      if (items.length === 0) return;
      let bytes = 0;
      for (const item of items) bytes += mediaItemWeight(item);
      if (!mediaBudget.tryTake(items.length, bytes, performance.now())) {
        // The budget rejects the whole already-sanitized batch, not one item — count the
        // drop so it shows up in diagnostics instead of vanishing.
        diagBump('mediaIngressRejected');
        return;
      }
      deps.relay(items);
    },
    { signal: runtime.signal },
  );
}
