// DOM-scan fallback for media already rendered on the page.
//
// The GraphQL hook sees the complete quality ladders; this sees whatever survived into
// the DOM, which is what covers a page the hook was injected too late for.

import { diagBump, diagDrain } from '../shared/diag';
import type { NoteFn } from './content-diag';
import {
  isFbcdn,
  isStaticFbAsset,
  makeItem,
  MIN_MEDIA_DIMENSION_PX,
  mediaSourceFromLocation,
  type MediaItem,
  type MediaSource,
} from '../shared/media';
import { MEDIA_QUEUE_MAX_ITEMS } from './content-media-relay';
import type { ContentRuntime } from './content-runtime';

const SCAN_THROTTLE_MS = 1200;
const INITIAL_SCAN_DELAY_MS = 1500;

/** Delegates to the classifier shared with page-hook.ts's pageSource() and the worker's
 *  surfaceOf(), so the highlight/stories/reel precedence cannot drift between them. */
export function currentMediaSource(): MediaSource {
  return mediaSourceFromLocation(location.pathname, location.search);
}

function domCaptureSignature(item: MediaItem): string {
  return `${item.kind}|${item.source}|${item.url}|${item.width ?? ''}x${item.height ?? ''}|${item.thumbUrl ?? ''}`;
}

interface DomScanDeps {
  relay: (items: MediaItem[]) => void;
  scheduleTheme: () => void;
  reportDiag: (counters: unknown) => void;
  note: NoteFn;
  /** A fresh image load can also change what is playing. */
  onImageLoaded: () => void;
}

export function setupDomScan(runtime: ContentRuntime, deps: DomScanDeps): () => void {
  // scanDom re-walks the WHOLE document on every throttled pass: it has to, because a
  // <video> whose src only resolves once buffering completes, or an <img> whose
  // naturalWidth only clears the minimum once decoded, changes with no childList
  // mutation of its own for the observer to scope a rescan to.
  //
  // Left unfiltered that re-relayed every still-qualifying item on every pass —
  // AckedBatch's key dedupe only merges items still WAITING in its queue, so one
  // already acknowledged is simply re-added as new. Track the last-relayed observable
  // state per id and relay again only when it actually differs. FIFO-bounded at the
  // same scale as the outgoing queue so an hours-long scroll cannot grow it forever.
  const signatures = new Map<string, string>();
  let scanTimer: number | undefined;
  let initialScanTimer: number | undefined;

  const changedOnly = (items: MediaItem[]): MediaItem[] => {
    const changed: MediaItem[] = [];
    for (const item of items) {
      const signature = domCaptureSignature(item);
      if (signatures.get(item.id) === signature) continue;
      if (!signatures.has(item.id) && signatures.size >= MEDIA_QUEUE_MAX_ITEMS) {
        signatures.delete(signatures.keys().next().value as string);
      }
      signatures.set(item.id, signature);
      changed.push(item);
    }
    return changed;
  };

  const usableImage = (img: HTMLImageElement, src: string): boolean =>
    // isStaticFbAsset: rsrc.php sprites/emoji are fbcdn-hosted UI chrome, not media.
    Boolean(src) &&
    isFbcdn(src) &&
    !isStaticFbAsset(src) &&
    img.naturalWidth >= MIN_MEDIA_DIMENSION_PX &&
    img.naturalHeight >= MIN_MEDIA_DIMENSION_PX;

  const scan = (): void => {
    deps.scheduleTheme();
    const out: MediaItem[] = [];
    const now = Date.now();
    const source = currentMediaSource();

    document.querySelectorAll('video').forEach((v) => {
      const src = v.currentSrc || v.src;
      const poster = v.poster && isFbcdn(v.poster) ? v.poster : undefined;
      // blob: URLs from MSE cannot be saved — skip them (see README limitations).
      if (src && !src.startsWith('blob:') && isFbcdn(src)) {
        const item = makeItem(src, 'video', source, 'dom', now);
        if (poster) item.thumbUrl = poster;
        out.push(item);
      }
      if (poster) out.push(makeItem(poster, 'image', source, 'dom', now));
    });

    document.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.src;
      if (!usableImage(img, src)) return;
      const item = makeItem(src, 'image', source, 'dom', now);
      item.width = img.naturalWidth;
      item.height = img.naturalHeight;
      out.push(item);
    });

    diagBump('captureDom', out.length);
    const relayed = changedOnly(out);
    // Only when the scan found something, and only the two counts: this runs on
    // every mutation burst, and a line per empty scan would be the loudest and
    // least informative thing in the trace. `relayed` below `found` is the normal
    // steady state (the dedupe is doing its job); `found` high with `relayed`
    // always 0 is what a stuck scan looks like.
    if (out.length > 0) deps.note('domScan', { found: out.length, relayed: relayed.length });
    deps.reportDiag(diagDrain());
    deps.relay(relayed);
  };

  const throttledScan = (): void => {
    if (scanTimer !== undefined) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = undefined;
      scan();
    }, SCAN_THROTTLE_MS);
  };

  // A slow or responsive image can finish after the mutation-triggered scan ran. Capture
  // its final currentSrc at load time so opening Facebook's larger viewer rendition
  // enriches the thumbnail without polling or fetches.
  document.addEventListener(
    'load',
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      const src = img.currentSrc || img.src;
      if (!usableImage(img, src)) return;
      const item = makeItem(src, 'image', currentMediaSource(), 'dom', Date.now());
      item.width = img.naturalWidth;
      item.height = img.naturalHeight;
      deps.relay([item]);
      deps.onImageLoaded();
    },
    { capture: true, signal: runtime.signal },
  );

  const observer = new MutationObserver(throttledScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', scan, { signal: runtime.signal });
  window.addEventListener(
    'load',
    () => {
      initialScanTimer = window.setTimeout(() => {
        initialScanTimer = undefined;
        scan();
      }, INITIAL_SCAN_DELAY_MS);
    },
    { signal: runtime.signal },
  );

  runtime.onTeardown(() => {
    if (scanTimer !== undefined) clearTimeout(scanTimer);
    if (initialScanTimer !== undefined) clearTimeout(initialScanTimer);
    observer.disconnect();
  });

  return scan;
}
