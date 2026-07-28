// What the user is actually watching, and the in-page download button that follows it.
//
// Heuristic: the topmost fbcdn media element at the viewport centre is what is on
// screen. elementsFromPoint returns hits top-first, so the viewer's active slide wins
// over buried previous ones. Works for photo stories too, and is independent of
// Facebook's generated class names.

import { withTimeout } from '../shared/async';
import { createAckedLatest, type AckedLatestOutcome } from '../shared/acked-latest';
import { diagBump } from '../shared/diag';
import type { NoteFn } from './content-diag';
import {
  fbcdnBackgroundUrl,
  isFbcdn,
  isNumericMediaId,
  isStaticFbAsset,
  mediaId,
  NUMERIC_MEDIA_ID_SOURCE,
  type MediaItem,
} from '../shared/media';
import type {
  NowPlayingAck,
  NowPlayingMsg,
  ShortcutResultMsg,
} from '../shared/messages';
import { nextPlayingDetectedAt } from '../shared/playing-clock';
import {
  isDurableStoryMark,
  isStoryDomId,
  isStoryPath,
  storyCardMark as formatStoryCardMark,
} from '../shared/story-mark';
import {
  coverSharesVideoCard,
  discardPlaceholderCoverEvidence,
  pickBestVideoIndex,
  type VideoCandidate,
} from '../shared/centre-video';
import { combineVideoMark, createVideoMarkFactory } from '../shared/video-mark';
import { createFrameCoalescer } from './detection-frame';
import { loadSettings } from '../shared/settings';
import { createDownloadOverlay } from './download-overlay';
import { currentMediaSource } from './content-dom-scan';
import type { ContentRuntime } from './content-runtime';
import { visibleMediaCandidate } from './visible-media';

const PLAYING_ACK_TIMEOUT_MS = 5_000;
// 300ms, not a lazy 1s: media events fire DURING slide transitions, when the viewport
// centre still shows the OUTGOING slide, so the change-guard swallows that emission and
// the poller is what detects the settled new slide. Every ms of lag also shifts
// PlayingRef.at late, which misclassifies the new video's first tracks as pre-slide
// evidence. centreMedia is one elementsFromPoint walk plus a <video> scan — cheap here.
const POLL_MS = 300;
// Slide changes drive their own refresh, so this only has to catch what this process
// cannot see: the worker learning the representations a beat AFTER the slide started.
// That lands right when the button is expected to already be there, so it stays under a
// second.
const OVERLAY_REFRESH_MS = 750;
const SCROLL_SETTLE_MS = 200;
// The worker's 1200ms debounce tolerates a slide transition blinking empty. The button
// does not: it is a local element whose own DOM check hides it without asking anyone.
const OVERLAY_EMPTY_MS = 300;
const EMPTY_DEBOUNCE_MS = 1200;
// Lookahead, not consume: the id may be followed by /, ?query, #hash or end. Built from
// the shared numeric-id source so it can never drift from isNumericMediaId's bounds.
const URL_VIDEO_ID_RE = new RegExp(`\\/(?:reel|videos?)\\/(${NUMERIC_MEDIA_ID_SOURCE})(?=[/?#]|$)`);

/** An fbcdn cover URL from an <img> src or a CSS background-image. */
function fbcdnCoverUrl(el: Element): string | undefined {
  if (el instanceof HTMLImageElement) {
    const s = el.currentSrc || el.src;
    return s && isFbcdn(s) && !isStaticFbAsset(s) ? s : undefined;
  }
  if (el instanceof HTMLElement) return fbcdnBackgroundUrl(getComputedStyle(el).backgroundImage);
  return undefined;
}

/** Is any reasonably-sized <video> playing and visible? No readyState gate: under
 *  Facebook's MSE-in-Workers the buffer lives in the worker and the main-thread element
 *  reports readyState 0 FOREVER, even mid-playback. `!paused && !ended` is the only
 *  signal it still tells the truth about. */
function anyVideoPlaying(): boolean {
  for (const v of document.querySelectorAll('video')) {
    if (v.paused || v.ended) continue;
    const r = v.getBoundingClientRect();
    if (
      r.width >= 100 &&
      r.height >= 100 &&
      r.bottom > 0 &&
      r.right > 0 &&
      r.top < window.innerHeight &&
      r.left < window.innerWidth
    ) {
      return true;
    }
  }
  return false;
}

function closestAttrValue(start: Element, attr: string, ok: (v: string) => boolean): string | undefined {
  let el: Element | null = start;
  for (let d = 0; el != null && d < 12; d++, el = el.parentElement) {
    const v = el.getAttribute(attr);
    if (v != null && ok(v)) return v;
  }
  return undefined;
}

/** The current story card's own id. The viewer tags each card container with
 *  data-id=<base64 story id>; unlike the URL path — pinned to the card the tray was
 *  opened on — this advances as you move through the tray. The anchor may be ANY element
 *  inside the card: the playing video, or the topmost centre element when the card has no
 *  video at all (a photo card, or a dead "no longer available" bucket). */
function storyCardDomId(anchor: Element): string | undefined {
  return closestAttrValue(anchor, 'data-id', isStoryDomId);
}

/** A DOM-proven id is durable (`u:`), the URL fallback provisional (`p:`). The URL stays
 *  pinned to the card that opened the tray even across BUCKETS, so its value may
 *  distinguish a video load but must never become a durable cover/video binding. */
function storyCardMark(anchor?: Element): string {
  // Pathname gate BEFORE the ancestor walk: this runs several times a second on every
  // facebook.com surface, and off /stories the walk's result is discarded anyway.
  if (!isStoryPath(location.pathname)) return '';
  const domId = anchor ? storyCardDomId(anchor) : undefined;
  return formatStoryCardMark(location.pathname, domId);
}

/** The played reel's real numeric video id. The reels feed tags each container with
 *  data-video-id — per-reel and accurate, unlike the page URL's /reel/<id>, which lags
 *  the scroll. It equals the efg `vid:` key of the reel's captured representations. */
function reelVideoId(video: HTMLVideoElement): string | undefined {
  return closestAttrValue(video, 'data-video-id', isNumericMediaId);
}

/** Video id from the page URL — an exact anchor, immune to fbcdn prefetch noise.
 *  Absent on feed/stories. */
function urlVideoId(): string | undefined {
  const m = location.pathname.match(URL_VIDEO_ID_RE);
  if (m) return m[1];
  try {
    const v = new URLSearchParams(location.search).get('v');
    if (isNumericMediaId(v)) return v;
  } catch {
    /* ignore */
  }
  return undefined;
}

interface CentreMedia {
  ids: string[];
  hasVideo: boolean;
  covers: string[];
  mark: string;
  videoEl?: HTMLVideoElement;
  coverEl?: Element;
  centreEl?: Element;
}

interface PlayingDeps {
  relay: (items: MediaItem[]) => void;
  scheduleTheme: () => void;
  note: NoteFn;
}

interface PlayingDetector {
  /** Coalesced into one frame — for callers reacting to a DOM event, not a poll. */
  requestDetect: () => void;
  detect: () => void;
  /** Clear the change-guard and re-emit: returning to the tab fires no media event. */
  reassert: () => void;
}

export function setupPlayingDetection(
  runtime: ContentRuntime,
  usesAnimation: boolean,
  deps: PlayingDeps,
): PlayingDetector {
  const delivery = createAckedLatest<NowPlayingMsg>();
  const markVideoLoad = createVideoMarkFactory(runtime.documentToken);
  let lastDetectedAt = 0;
  let lastVisibleCaptureKey = '';
  let lastOverlaySlideKey = '';
  let emptySince: number | undefined;
  let emptyOverlayChecked = false;
  let scrollTimer: number | undefined;

  const deliver = async (message: NowPlayingMsg): Promise<AckedLatestOutcome> => {
    if (runtime.isDisposed()) return 'retry';
    if (!runtime.alive()) {
      runtime.teardown();
      return 'retry';
    }
    try {
      const response = (await withTimeout(
        chrome.runtime.sendMessage(message),
        PLAYING_ACK_TIMEOUT_MS,
        'NOW_PLAYING acknowledgement timed out.',
      )) as NowPlayingAck | undefined;
      if (response?.ok === true) return 'accepted';
      return response?.ok === false && response.retryable === false ? 'refresh' : 'retry';
    } catch {
      // A sleeping worker or a busy storage lane is recoverable. The next poll reuses
      // this message and its original detectedAt.
      if (!runtime.alive()) runtime.teardown();
      return 'retry';
    }
  };

  /** Per-video-load marker. Under MSE-in-Workers the <video> streams via a
   *  MediaSourceHandle on srcObject, so currentSrc/src stay empty: key a WeakMap by the
   *  per-load handle (element as fallback) and mint one synthetic id per handle — stable
   *  while a slide plays, new on the next. Progressive videos expose a real src. */
  const videoMark = (v: HTMLVideoElement): string => {
    const src = v.currentSrc || v.src;
    const key: object = (v.srcObject as object | null) ?? v;
    // Fold in the reel id: the WeakMap keys on object identity, which Facebook may reuse
    // across slides — see combineVideoMark for what that broke.
    return combineVideoMark(markVideoLoad(key, src), reelVideoId(v));
  };

  // The button's own anchor search (pickAnchorElement, download-overlay.ts) answers a
  // similar question with different rules — largest covering box, playback state
  // ignored — so on a stack of slides the two can disagree. That is cosmetic: it only
  // decides where the button is drawn, while what a click downloads is resolved by the
  // worker from its capture state, never from the anchor.
  function centreMedia(): CentreMedia {
    const ids = new Set<string>();
    const covers: string[] = [];
    const coverIds = new Set<string>();
    let mark = '';
    let hasVideo = false;
    let videoEl: HTMLVideoElement | undefined;
    let coverEl: Element | undefined;
    // Topmost element at the centre — the card-id anchor of last resort for slides with
    // NO video (photo cards, dead buckets): the viewer URL never advances, so without a
    // DOM anchor those slides would be indistinguishable from the previous one and the
    // panel would keep the previous story endorsed.
    let centreEl: Element | undefined;
    const cx = Math.round(window.innerWidth / 2);
    const cy = Math.round(window.innerHeight / 2);

    // `overCover`: adopted DESPITE a cover hit-tested at the centre, so that cover
    // belongs to a placeholder, not to what is playing. The panel learns groupCover from
    // covers[0], so the adopted video's own poster has to lead.
    const adoptVideo = (el: HTMLVideoElement, overCover = false): void => {
      hasVideo = true;
      videoEl = el;
      const src = el.currentSrc || el.src;
      mark = videoMark(el);
      if (overCover) {
        discardPlaceholderCoverEvidence(
          ids,
          covers,
          coverIds,
          coverSharesVideoCard(el, coverEl, (ancestor, node) => (ancestor as Element).contains(node as Node)),
        );
      }
      if (src && !src.startsWith('blob:') && isFbcdn(src)) ids.add(mediaId(src));
      if (el.poster && isFbcdn(el.poster)) {
        ids.add(mediaId(el.poster));
        if (overCover) covers.unshift(el.poster);
        else covers.push(el.poster);
      }
    };

    // Walk the centre stack top-first: the topmost <video> AND the topmost large fbcdn
    // cover behind it (an <img> OR a background-image div — Facebook uses both). The
    // cover's asset id links the unreadable blob: video to its captured item via that
    // item's thumbnail; its URL is also sent so the panel can display it and LEARN the
    // cover↔video binding.
    let gotVideo = false;
    let gotCover = false;
    for (const el of document.elementsFromPoint(cx, cy)) {
      centreEl ??= el;
      if (!gotVideo && el instanceof HTMLVideoElement) {
        // A PAUSED video below the topmost large cover is the previous slide buried
        // under the active photo (the viewer keeps old slides stacked and paused). A
        // PLAYING one is the opposite: the new slide's video with a residual blur-up
        // placeholder still fading out on top of it. Distinguish by playback state, not
        // by stacking order.
        if (gotCover && (el.paused || el.ended)) break;
        gotVideo = true;
        adoptVideo(el, gotCover);
        continue;
      }
      if (!gotCover) {
        const r = el.getBoundingClientRect();
        if (r.width >= 160 && r.height >= 160) {
          const url = fbcdnCoverUrl(el);
          if (url) {
            const id = mediaId(url);
            ids.add(id);
            coverIds.add(id);
            covers.push(url);
            gotCover = true;
            coverEl = el;
          }
        }
      }
      if (gotVideo && gotCover) break;
    }

    // elementsFromPoint only returns hit-testable elements, and the viewer sets
    // pointer-events:none on the <video> (taps go to the nav overlay), so the walk can
    // miss video slides. Fall back to scoring every video on screen. A cover only
    // suppresses PAUSED candidates (see pickBestVideoIndex) — geometry here, decision
    // there, because the decision is the part worth testing without a browser.
    if (!gotVideo) {
      const els: HTMLVideoElement[] = [];
      const candidates: VideoCandidate[] = [];
      for (const v of document.querySelectorAll('video')) {
        const r = v.getBoundingClientRect();
        els.push(v);
        candidates.push({
          vw: Math.min(r.right, window.innerWidth) - Math.max(r.left, 0),
          vh: Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0),
          paused: v.paused,
          ended: v.ended,
          containsCentre: cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom,
        });
      }
      const best = pickBestVideoIndex(candidates, gotCover);
      if (best !== undefined) adoptVideo(els[best], gotCover);
    }
    return { ids: [...ids], hasVideo: hasVideo || anyVideoPlaying(), covers: covers.slice(0, 3), mark, videoEl, coverEl, centreEl };
  }

  const overlay = createDownloadOverlay({
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    isAlive: () => !runtime.isDisposed() && runtime.alive(),
    onError: () => diagBump('overlayQueryFailed'),
  });

  function detect(): void {
    if (runtime.isDisposed()) return;
    // A hidden tab has nothing to detect and nobody to show it to: the centre of a
    // background viewport still holds whatever was there when the tab left, and every
    // emission is a service-worker wake-up for a video nobody is watching. The
    // visibilitychange listener below reasserts on return, which is what re-syncs the
    // panel — so this costs only the sleep it buys.
    if (document.hidden) return;
    const { ids, hasVideo, covers, mark: videoMk, videoEl, coverEl, centreEl } = centreMedia();
    const now = Date.now();
    // `hasVideo` also covers any playing video elsewhere in the viewport, for
    // conservative Now Playing inference. Visible CAPTURE must use only the video
    // selected at the centre, or an off-centre player suppresses the centred photo.
    const visible = visibleMediaCandidate(
      {
        hasVideo: videoEl != null,
        videoUrl: videoEl?.currentSrc || videoEl?.src,
        videoHeight: videoEl?.videoHeight,
        imageUrl: covers[0],
        imageWidth: coverEl instanceof HTMLImageElement ? coverEl.naturalWidth : undefined,
        imageHeight: coverEl instanceof HTMLImageElement ? coverEl.naturalHeight : undefined,
      },
      currentMediaSource(),
      now,
    );
    const visibleKey =
      visible == null ? '' : `${visible.kind}|${visible.url}|${visible.width ?? ''}x${visible.height ?? ''}`;
    if (visibleKey !== lastVisibleCaptureKey) {
      lastVisibleCaptureKey = visibleKey;
      // What is centred changed, so the button may have to move or appear even when the
      // slide identity below does not — scrolling from photo to photo in the feed keeps
      // the same empty mark and the same absent vid.
      resetOverlayCadence();
      if (visible != null) deps.relay([visible]);
    }
    const detectedAt = nextPlayingDetectedAt(lastDetectedAt, now);
    lastDetectedAt = detectedAt;
    // Combine the story-card signal with the per-load marker so the mark changes if
    // either does. The card anchor prefers the playing video, else the topmost centre
    // element — a photo card or dead bucket can still advance the mark.
    const mark = [storyCardMark(videoEl ?? centreEl), videoMk].filter(Boolean).join('#');
    // Debounce transient empties during slide transitions to avoid flicker.
    if (ids.length === 0 && !hasVideo) {
      const monotonicNow = performance.now();
      if (emptySince === undefined) {
        emptySince = monotonicNow;
      } else if (!emptyOverlayChecked && monotonicNow - emptySince >= OVERLAY_EMPTY_MS) {
        // One poll tick is enough to tell a closed viewer from a transition blink, and
        // the flag keeps this to one call per empty run rather than one per tick.
        emptyOverlayChecked = true;
        void overlay.refresh({ mediaChanged: true });
      }
      if (monotonicNow - emptySince < EMPTY_DEBOUNCE_MS) return;
    } else {
      emptySince = undefined;
      emptyOverlayChecked = false;
    }
    // Prefer the feed's DOM data-video-id (accurate, per-reel) over location's
    // /reel/<id>, which lags the scroll; fall back to the URL on watch pages.
    const vid = (videoEl != null ? reelVideoId(videoEl) : undefined) ?? (hasVideo ? urlVideoId() : undefined);
    const key = `${hasVideo ? 'v' : '-'}|${vid ?? ''}|${mark}|${ids.slice().sort().join(',')}`;
    const message = {
      type: 'NOW_PLAYING',
      ids,
      hasVideo,
      vid,
      covers,
      mark,
      detectedAt,
      documentToken: runtime.documentToken,
    } satisfies NowPlayingMsg;
    if (!delivery.offer(key, message)) return;
    // Only accepted boundaries reach here (offer() dedupes on `key`), so this is one
    // line per real slide change, not per poll tick. It is the answer to the most
    // common report of all — "Now Playing is showing the wrong video": the id this
    // detector believed, and whether it came from the DOM or the URL.
    // `mark` is recorded by PROVENANCE, never by value — the value carries the story
    // card id. Provenance is what a trace needs: on the story viewer the detector
    // reports a video with no cover and no id, so whether the card yielded a DOM-proven
    // `u:` mark is the difference between "Now Playing has one anchor left" and "it has
    // none", and nothing else in the trace distinguishes those two.
    const markKind = mark === '' ? 'none' : isDurableStoryMark(mark) ? 'durable' : 'provisional';
    deps.note('playing', { vid: vid ?? '', ids: ids.length, hasVideo, covers: covers.length, mark: markKind });
    // The slide identity WITHOUT the id set: ids keep growing as more representations of
    // the same video are captured, and closing an open resolution menu on that would
    // fight the user mid-pick. mark and vid move only on a real slide.
    const slideKey = `${hasVideo ? 'v' : '-'}|${vid ?? ''}|${mark}`;
    const mediaChanged = slideKey !== lastOverlaySlideKey;
    lastOverlaySlideKey = slideKey;
    if (mediaChanged) resetOverlayCadence();
    // Refresh the button only AFTER the new state lands: it asks the worker what is
    // playing, and until this delivery commits the worker still holds the previous
    // slide. Refreshing first would offer the resolutions of the video that just left —
    // and a click would download that one.
    void delivery.pump(deliver).then(() => overlay.refresh({ mediaChanged }));
  }

  const frame = createFrameCoalescer(
    detect,
    (callback) => (usesAnimation ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 0)),
    (handle) => {
      if (usesAnimation && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
      else clearTimeout(handle);
    },
  );

  const reassert = (): void => {
    if (runtime.isDisposed()) return;
    delivery.invalidateCommitted();
    resetOverlayCadence();
    detect();
  };

  for (const evt of ['play', 'playing', 'pause', 'seeked', 'loadeddata'] as const) {
    document.addEventListener(evt, detect, { capture: true, signal: runtime.signal });
  }
  // Trailing edge, re-armed on every event: firing on the FIRST scroll of a burst
  // sampled a slide mid-transition, and every such emission restamps PlayingRef.at. An
  // `at` that keeps moving stops any track from ever counting as anchored.
  document.addEventListener(
    'scroll',
    () => {
      if (scrollTimer !== undefined) clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => {
        scrollTimer = undefined;
        detect();
      }, SCROLL_SETTLE_MS);
    },
    { capture: true, signal: runtime.signal },
  );
  // The browser knows when momentum and scroll-snap actually settled; a fixed delay only
  // guesses. Chrome 114+, and the manifest requires 116.
  document.addEventListener(
    'scrollend',
    () => {
      if (scrollTimer !== undefined) {
        clearTimeout(scrollTimer);
        scrollTimer = undefined;
      }
      detect(); // idempotent via the change-guard, so racing the debounce is harmless
    },
    { capture: true, signal: runtime.signal },
  );
  document.addEventListener(
    'visibilitychange',
    () => {
      if (!document.hidden) {
        reassert();
        deps.scheduleTheme();
      }
    },
    { signal: runtime.signal },
  );
  window.addEventListener('focus', reassert, { signal: runtime.signal });
  window.addEventListener(
    'pageshow',
    () => {
      reassert();
      deps.scheduleTheme();
    },
    { signal: runtime.signal },
  );

  const poller = window.setInterval(detect, POLL_MS);

  // The overlay's poll is the only thing on this page that talks to the worker on a timer, so the
  // in-page-button setting stops it outright: off means no message and no worker wake-up. The final
  // refresh takes the button down, since with the setting off the worker answers "nothing".
  let overlayTimer: number | undefined;
  // Stride, not a rearmed timer: the interval keeps its 750ms tick and simply SKIPS ticks
  // once the screen has been settled for a while, so a tab parked on a finished reel stops
  // waking the worker twice a second. Anything that moves — a new slide, a different
  // centred photo, coming back to the tab — puts the stride back to every tick via
  // resetOverlayCadence(), so the catch-up right after a slide change is still under a
  // second. A hidden tab skips outright: no button to place, nobody to see it, and it is
  // the case that kept the worker awake once per open Facebook tab.
  const OVERLAY_STEADY_TICKS = 4;
  const OVERLAY_MAX_STRIDE = 7; // 7 * 750ms ~ 5s between refreshes on a settled screen
  let overlayStride = 1;
  let overlayTicks = 0;
  let overlaySteady = 0;
  // A declaration, not a const: detect() and reassert() above call this, and both run only
  // from a timer or an event, long after this line has been reached.
  function resetOverlayCadence(): void {
    overlayStride = 1;
    overlayTicks = 0;
    overlaySteady = 0;
  }
  function overlayTick(): void {
    if (document.hidden) return;
    if (++overlayTicks < overlayStride) return;
    overlayTicks = 0;
    if (++overlaySteady >= OVERLAY_STEADY_TICKS && overlayStride < OVERLAY_MAX_STRIDE) {
      overlayStride++;
      overlaySteady = 0;
    }
    void overlay.refresh();
  }
  const setOverlayPolling = (on: boolean): void => {
    if (runtime.isDisposed() || on === (overlayTimer !== undefined)) return;
    if (on) {
      resetOverlayCadence();
      void overlay.refresh();
      overlayTimer = window.setInterval(overlayTick, OVERLAY_REFRESH_MS);
      return;
    }
    clearInterval(overlayTimer);
    overlayTimer = undefined;
    void overlay.refresh();
  };

  void loadSettings().then((settings) => setOverlayPolling(settings.inPageButton));

  // The global shortcut downloads without touching the button, so the worker reports the outcome
  // here and the button shows it on the glyph it already has.
  const onShortcutResult = (message: unknown): void => {
    const m = message as Partial<ShortcutResultMsg> | undefined;
    if (m?.type !== 'FACESCRAP_SHORTCUT_RESULT') return;
    overlay.showResult(m.ok === true);
  };
  try {
    chrome.runtime.onMessage.addListener(onShortcutResult);
  } catch {
    /* extension context already invalidated */
  }

  const onSettingsChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== 'local' || !('settings' in changes)) return;
    void loadSettings().then((settings) => setOverlayPolling(settings.inPageButton));
  };
  try {
    chrome.storage.onChanged.addListener(onSettingsChanged);
  } catch {
    /* extension context already invalidated */
  }

  runtime.onTeardown(() => {
    clearInterval(poller);
    if (overlayTimer !== undefined) clearInterval(overlayTimer);
    if (scrollTimer !== undefined) clearTimeout(scrollTimer);
    try {
      chrome.storage.onChanged.removeListener(onSettingsChanged);
      chrome.runtime.onMessage.removeListener(onShortcutResult);
    } catch {
      /* extension context already invalidated */
    }
    frame.cancel();
    overlay.dispose();
  });

  return { requestDetect: () => frame.request(), detect, reassert };
}
