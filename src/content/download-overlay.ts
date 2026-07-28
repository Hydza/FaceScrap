// In-page download button: save the reel/story/highlight you are watching
// without opening the side panel, picking a resolution first.
//
// Two deliberate constraints shape everything here.
//
// 1. The host element hangs off document.documentElement, NOT off Facebook's
//    tree, and its contents live in a closed shadow root. Facebook re-renders
//    its viewer constantly; a node parented inside it would be thrown away, and
//    an unshadowed node would both inherit their CSS and leak ours.
//
// 2. This module never learns a media URL and never asks for one. It asks the
//    worker "what could the media in my tab be downloaded as?" and gets back
//    resolution LABELS; it sends a label back to start the download. The worker
//    resolves the URL from its own capture state, because a content script
//    shares a process with the page and must not be able to aim the downloader
//    (see the FACESCRAP_DOWNLOAD_DASH handler's sender.tab rejection).
//
// Positioning is geometric, not selector-based: it tracks the bounding box of
// the biggest media element under the viewport centre, then sits immediately
// left of Facebook's own control row (mute / play / more) so it reads as one
// more control in that row instead of covering it. Facebook's class names churn
// roughly monthly (ARCHITECTURE.md); element geometry does not.

import { t, type MsgKey } from '../shared/i18n';
import { isFbcdn, isStaticFbAsset } from '../shared/media';
import type {
  PlayingDownloadOptionsResponse,
  RequestPlayingDownloadResponse,
} from '../shared/messages';

/** Below this, an <img> is chrome — avatars, reaction icons, story-tray thumbs. */
const MIN_IMAGE_PX = 180;
/** Corner offset for the fallback placement, used only when the control row
 *  cannot be found. */
const INSET_PX = 12;
/** Facebook spaces its own viewer controls this far apart. */
const GAP_PX = 4;
/** Matches Facebook's control box when there is no row to measure against. */
const FALLBACK_SIZE_PX = 32;
/** A viewer control is roughly icon-sized. Anything outside this is a label, a
 *  card, or the whole overlay — not a member of the control row. */
const CONTROL_MIN_PX = 16;
const CONTROL_MAX_PX = 56;
/** How far up from the media to look for the viewer card. A story's controls are
 *  a handful of levels above its image; ten is generous and bounded. */
const ANCESTOR_LIMIT = 10;
/** An ancestor wider than this multiple of the media is no longer the viewer card
 *  but the page around it, whose own top bar is also a row of icon buttons. */
const CARD_WIDTH_SLACK = 1.8;
/** How long the result glyph stays up before the button returns to idle. */
const RESULT_HOLD_MS = 2_500;
const HOST_ID = 'facescrap-download-overlay';

interface DownloadOverlayPorts {
  /** Injected so tests can drive the overlay without a live extension context. */
  sendMessage: (message: unknown) => Promise<unknown>;
  /** False once the extension context died; the overlay then removes itself. */
  isAlive: () => boolean;
  onError?: (error: unknown) => void;
  /** The document and window to attach to. Injected only so the unit suite can
   *  exercise the query/hide paths without a DOM — this repo ships no jsdom and
   *  takes no new dependencies. Production callers leave both out. */
  doc?: Document;
  win?: Window;
}

export interface DownloadOverlay {
  /** Re-ask the worker what is playing and show/hide/reposition accordingly.
   *
   *  Pass `mediaChanged` when the caller knows the slide itself moved on. An open
   *  resolution menu belongs to the video that was playing when it opened, so it
   *  has to close — the labels alone cannot detect this, two videos routinely
   *  offer the same ladder. */
  refresh: (options?: { mediaChanged?: boolean }) => Promise<void>;
  dispose: () => void;
}

interface Anchor {
  rect: DOMRect;
  /** The leftmost control of Facebook's own row, when one was found. */
  control?: DOMRect;
}

/** Facebook's viewer controls (mute, play, more) sit in the top-right corner of
 *  the VIEWER CARD — which is not the same box as the media. A video story fills
 *  its card, so the controls land inside the video's own rect; a photo story is a
 *  letterboxed image with the controls well above it. Searching the media's rect
 *  alone therefore worked on videos and failed on photos, where the button fell
 *  back to the photo's corner and drifted with it.
 *
 *  So walk up from the media until an ancestor's top band holds the row. That
 *  ancestor IS the viewer card, by construction — no distance constants, and it
 *  works the same for both shapes.
 *
 *  Geometric on purpose: an aria-label match would need every locale Facebook
 *  ships, and a class match would break on the next rebrand. Three filters keep
 *  it honest: icon-sized (a text button like Follow is wider), the right half of
 *  the band (the left half is the author's avatar and name), and an ancestor no
 *  wider than the media — above that we would be reading the page's own top nav,
 *  which is also a row of icon buttons. */
export function pickControlAnchor(doc: Document, win: Window, media: Element): DOMRect | undefined {
  const mediaRect = media.getBoundingClientRect();
  const icons: DOMRect[] = [];
  for (const el of doc.querySelectorAll('[role="button"], button')) {
    const r = el.getBoundingClientRect();
    if (r.width < CONTROL_MIN_PX || r.height < CONTROL_MIN_PX) continue;
    if (r.width > CONTROL_MAX_PX || r.height > CONTROL_MAX_PX) continue;
    if (r.bottom < 0 || r.top > win.innerHeight || r.right < 0 || r.left > win.innerWidth) continue;
    icons.push(r);
  }
  if (icons.length === 0) return undefined;

  let node: Element | null = media.parentElement;
  for (let depth = 0; node != null && depth < ANCESTOR_LIMIT; depth++, node = node.parentElement) {
    const box = node.getBoundingClientRect();
    if (box.width > mediaRect.width * CARD_WIDTH_SLACK) break;
    const bandBottom = box.top + Math.min(box.height / 4, 200);
    const centreX = box.left + box.width / 2;
    const row = icons.filter(
      (r) => r.left >= centreX && r.right <= box.right + GAP_PX && r.top >= box.top - 1 && r.bottom <= bandBottom,
    );
    if (row.length > 0) return row.reduce((left, r) => (r.left < left.left ? r : left));
  }
  return undefined;
}

type Glyph = 'idle' | 'done' | 'failed';

/** Solid shapes on a 24 grid, no stroke — Facebook's viewer controls are filled
 *  glyphs, so an outlined one reads as a graft however well it is placed.
 *
 *  The size was matched by MEASUREMENT, not by eye, because eyeing it got it wrong
 *  twice. Rasterising each path at 10x and counting covered pixels puts Facebook's
 *  play, pause and speaker glyphs at 16.3%, 16.4% and 16.3% ink over the 24 grid,
 *  all ~15 units tall — a tight family. The first attempt here was 13.6% ink at
 *  16.2 units: TALLER than theirs and still reading smaller, because what carries
 *  weight at 20px is ink, not extent. These are 16.3% at 15.5 units, which is the
 *  family's own number. Keep them there if you redraw: thin the stem or stretch
 *  the glyph and it goes back to looking like someone else's icon.
 *
 *  Drawn as <path> elements rather than assigned as innerHTML: an isolated world
 *  is exempt from the page's Trusted Types policy today, but a TypeError there
 *  would silently cost the button its icon. */
const GLYPHS: Record<Glyph, string[]> = {
  // Arrow (stem 4.0 wide, head 11.6) over its tray. 16.3% ink, 15.5 tall.
  idle: [
    'M10 4.4h4v5.2h3.8L12 15.4 6.2 9.6h3.8z',
    'M6.5 16.9h11a1.5 1.5 0 0 1 0 3H6.5a1.5 1.5 0 0 1 0-3z',
  ],
  // The two result glyphs are single strokes, so they need more thickness to
  // carry the same weight: 15.6% and 16.5% ink.
  done: ['M9.45 19.4 3.1 13.05l3.05-3.05 3.3 3.3 8.35-8.35 3.05 3.05z'],
  failed: [
    'M18.8 7.6 16.4 5.2 12 9.6 7.6 5.2 5.2 7.6 9.6 12 5.2 16.4 7.6 18.8 12 14.4 16.4 18.8 18.8 16.4 14.4 12z',
  ],
};
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The media the button should sit on: the element covering the viewport centre
 *  if there is one, else the largest candidate. Videos win over images — a story
 *  video's poster is still in the DOM behind it. */
export function pickAnchorElement(doc: Document, win: Window): Element | undefined {
  const cx = win.innerWidth / 2;
  const cy = win.innerHeight / 2;
  const score = (el: Element): number | undefined => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return undefined;
    if (r.bottom < 0 || r.top > win.innerHeight || r.right < 0 || r.left > win.innerWidth) return undefined;
    const covers = r.left <= cx && r.right >= cx && r.top <= cy && r.bottom >= cy;
    return (covers ? 1e9 : 0) + r.width * r.height;
  };

  let best: Element | undefined;
  let bestScore = 0;
  for (const el of doc.querySelectorAll('video')) {
    const s = score(el);
    if (s != null && s > bestScore) {
      best = el;
      bestScore = s;
    }
  }
  if (best) return best;
  for (const el of doc.querySelectorAll('img')) {
    const r = el.getBoundingClientRect();
    if (r.width < MIN_IMAGE_PX || r.height < MIN_IMAGE_PX) continue;
    const s = score(el);
    if (s != null && s > bestScore) {
      best = el;
      bestScore = s;
    }
  }
  if (best) return best;

  // Facebook paints some photo stories as a <div> with a CSS background-image
  // rather than an <img> — the exact case fbcdnCoverUrl in content.ts was written
  // to cover. Those reach the worker (the detector reads the same cover URL either
  // way) and come back offered for download, so a button that can only anchor to
  // <img> is not intermittently missing on them, it is permanently missing.
  //
  // elementsFromPoint, not a tree walk: "a div with a background-image" has no tag
  // selector, so the alternative is querySelectorAll('*') plus a style recalc per
  // node, over Facebook's tree, on every scroll frame. This reads the handful of
  // elements stacked over one point — the technique centreMedia already uses for
  // this same problem, and the reason its comment calls itself cheap.
  if (typeof doc.elementsFromPoint !== 'function') return undefined;
  for (const el of doc.elementsFromPoint(cx, cy)) {
    const r = el.getBoundingClientRect();
    if (r.width < MIN_IMAGE_PX || r.height < MIN_IMAGE_PX) continue;
    const bg = win.getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') continue;
    const m = bg.match(/url\(["']?(https?:[^"')]+)["']?\)/);
    // The same pair of guards fbcdnCoverUrl applies: fbcdn-hosted, and not an
    // rsrc.php sprite — those are fbcdn too, and a big one would anchor the button
    // to a banner instead of to the photo.
    if (m && isFbcdn(m[1]) && !isStaticFbAsset(m[1])) return el;
  }
  return undefined;
}

const CSS = `
:host { all: initial; }
.wrap {
  position: fixed;
  z-index: 2147483000;
  display: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  font: 700 12.5px/1.2 -apple-system, "Segoe UI", system-ui, sans-serif;
}
.wrap[data-show="1"] { display: flex; }
button {
  font: inherit;
  color: #fff;
  border: 0;
  border-radius: 999px;
  background: transparent;
  cursor: pointer;
}
/* Sized from the measured control so it matches the row it joins; 28px floors it
   at the 24px WCAG 2.5.8 target minimum when the fallback placement is used. */
.trigger {
  width: max(28px, var(--size, 32px));
  height: max(28px, var(--size, 32px));
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.trigger svg {
  /* Was 62%, derived from Facebook's documented 20px-glyph-in-a-32px-control. Their
     real play glyph renders larger than that, so this is set from the ask instead:
     level with play, a touch over. 80% of the measured control with the glyph
     filling 15.5 of its 24 units puts our ink at ~16.5px in a 32px control. */
  width: 80%;
  height: 80%;
  fill: #fff;
  stroke: none;
  /* Facebook's own glyphs carry a shadow; without one a white icon vanishes on a
     bright frame. */
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}
.trigger:hover,
.trigger[aria-expanded="true"] { background: rgba(255, 255, 255, 0.18); }
.trigger[data-busy] { opacity: 0.55; }
/* A set of options, not a list: they wrap into rows of chips, so six
   resolutions read as a small palette instead of a column tall enough to cover
   the story. The backdrop stays light enough to see the frame through it. */
.menu {
  display: none;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  max-width: 168px;
  padding: 5px;
  border-radius: 14px;
  background: rgba(15, 17, 20, 0.42);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.14);
}
.menu[data-open="1"] { display: flex; }
.menu button {
  min-height: 28px;
  padding: 5px 11px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  text-align: center;
  white-space: nowrap;
}
.menu button:hover { background: rgba(255, 255, 255, 0.28); }
:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

export function createDownloadOverlay(ports: DownloadOverlayPorts): DownloadOverlay {
  const doc = ports.doc ?? document;
  const win = ports.win ?? window;
  let host: HTMLElement | undefined;
  let root: ShadowRoot | undefined;
  let wrap: HTMLElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLElement | undefined;
  let anchor: Anchor | undefined;
  let labels: string[] = [];
  let busy = false;
  let disposed = false;
  let frame: number | undefined;
  let holdUntil = 0;
  // Bumped by every refresh(); `settled` is the newest one that actually wrote.
  // Two refreshes are routinely in flight at once — the 750ms poll and the one a
  // slide change fires — and their promises resolve in either order, because a
  // message to a sleeping service worker costs a wake-up and one to a warm worker
  // does not. The loser used to write show/place/labels anyway.
  //
  // The test is `settled > mine`, NOT `mine !== generation`: a slide's first second
  // fires refreshes faster than the worker answers, and dropping every response
  // that merely had a newer refresh START behind it means none of them ever paints.
  // Only a newer answer that already DECIDED may veto an older one.
  let generation = 0;
  let settled = 0;

  function build(): void {
    if (host || disposed) return;
    host = doc.createElement('div');
    host.id = HOST_ID;
    // Nothing about the host may participate in Facebook's layout.
    host.style.cssText = 'all: initial; position: static;';
    root = host.attachShadow({ mode: 'closed' });
    const style = doc.createElement('style');
    style.textContent = CSS;
    wrap = doc.createElement('div');
    wrap.className = 'wrap';
    trigger = doc.createElement('button');
    trigger.className = 'trigger';
    trigger.type = 'button';
    trigger.setAttribute('aria-expanded', 'false');
    menu = doc.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    wrap.append(trigger, menu);
    root.append(style, wrap);
    doc.documentElement.appendChild(host);

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      // An image has no resolutions to choose from: one click saves it.
      if (labels.length === 0) void start(undefined);
      else toggleMenu();
    });
    // Keep clicks inside the overlay away from Facebook's own handlers, or
    // picking a resolution also advances the story.
    for (const type of ['pointerdown', 'mousedown', 'click'] as const) {
      wrap.addEventListener(type, (e) => e.stopPropagation());
    }
    root.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') closeMenu();
    });
  }

  function measure(el: Element): Anchor {
    return { rect: el.getBoundingClientRect(), control: pickControlAnchor(doc, win, el) };
  }

  function toggleMenu(): void {
    if (!menu || !trigger) return;
    const open = menu.getAttribute('data-open') === '1';
    if (open) closeMenu();
    else {
      menu.setAttribute('data-open', '1');
      trigger.setAttribute('aria-expanded', 'true');
      menu.querySelector<HTMLButtonElement>('button')?.focus();
    }
  }

  function closeMenu(): void {
    menu?.removeAttribute('data-open');
    trigger?.setAttribute('aria-expanded', 'false');
  }

  function renderMenu(): void {
    if (!menu) return;
    menu.textContent = '';
    for (const label of labels) {
      const item = doc.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.textContent = label;
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void start(label);
      });
      menu.appendChild(item);
    }
    menu.setAttribute('aria-label', t('overlayPickQuality'));
  }

  /** The button carries no text — it is one more icon in Facebook's control row —
   *  so its state lives in the glyph, and its name in aria-label plus the tooltip. */
  function setTriggerState(glyph: Glyph, key: MsgKey): void {
    if (!trigger) return;
    trigger.textContent = '';
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of GLYPHS[glyph]) {
      const path = doc.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    trigger.appendChild(svg);
    const label = t(key);
    trigger.setAttribute('aria-label', label);
    trigger.title = label;
    trigger.toggleAttribute('data-busy', key === 'overlayWorking');
  }

  async function start(label: string | undefined): Promise<void> {
    if (busy || !ports.isAlive()) return;
    busy = true;
    closeMenu();
    setTriggerState('idle', 'overlayWorking');
    try {
      const response = (await ports.sendMessage({
        type: 'FACESCRAP_REQUEST_PLAYING_DOWNLOAD',
        label,
      })) as RequestPlayingDownloadResponse | undefined;
      if (response?.ok) setTriggerState('done', 'overlayDone');
      else setTriggerState('failed', 'overlayFailed');
    } catch (error) {
      ports.onError?.(error);
      setTriggerState('failed', 'overlayFailed');
    } finally {
      busy = false;
      // Settle back to the download glyph on a later refresh tick rather than on
      // a timer of our own: the caller already polls, and a timer would have to
      // be torn down separately. The hold is what makes the result readable — the
      // poll is faster than a glance.
      holdUntil = Date.now() + RESULT_HOLD_MS;
    }
  }

  function place(): void {
    if (!wrap || !anchor) return;
    const { rect, control } = anchor;
    if (control) {
      // Left of the row's first control, at its size, so the button lands in the
      // gap Facebook already leaves between controls.
      wrap.style.left = `${Math.round(control.left - GAP_PX)}px`;
      wrap.style.top = `${Math.round(control.top)}px`;
      wrap.style.setProperty('--size', `${Math.round(control.height)}px`);
    } else {
      wrap.style.left = `${Math.round(rect.right - INSET_PX)}px`;
      wrap.style.top = `${Math.round(rect.top + INSET_PX)}px`;
      wrap.style.setProperty('--size', `${FALLBACK_SIZE_PX}px`);
    }
    // Anchored by its right edge so the resolution menu, which is wider than the
    // button, opens leftwards over the media instead of off it.
    wrap.style.transform = 'translateX(-100%)';
  }

  function show(visible: boolean): void {
    if (!wrap) return;
    if (visible) wrap.setAttribute('data-show', '1');
    else {
      wrap.removeAttribute('data-show');
      closeMenu();
    }
  }

  function trackGeometry(): void {
    if (frame !== undefined) return;
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      const el = pickAnchorElement(doc, win);
      if (!el) {
        show(false);
        return;
      }
      anchor = measure(el);
      place();
    });
  }

  const onScrollOrResize = (): void => trackGeometry();

  async function refresh(options?: { mediaChanged?: boolean }): Promise<void> {
    if (disposed) return;
    if (!ports.isAlive()) {
      dispose();
      return;
    }
    if (options?.mediaChanged === true) {
      // Both belong to the video that just left: a menu whose labels now name
      // another video's ladder, and a result glyph reporting that download.
      closeMenu();
      holdUntil = 0;
    }
    const myGeneration = ++generation;
    // Hiding must not wait on a round trip. Once the local DOM has nothing left to
    // anchor to, the media is gone and the answer is already known here — asking
    // the worker only delays acting on it by a message and a possible wake-up,
    // which is the second or two the button hangs around after a viewer closes.
    // It also stops the poll from messaging at all while nothing is on screen.
    //
    // This counts as a decision, so it settles: an older query still in flight must
    // not come back and put the button up again over media that is already gone.
    if (!pickAnchorElement(doc, win)) {
      settled = myGeneration;
      show(false);
      return;
    }
    let response: PlayingDownloadOptionsResponse | undefined;
    try {
      response = (await ports.sendMessage({
        type: 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS',
      })) as PlayingDownloadOptionsResponse | undefined;
    } catch (error) {
      if (settled > myGeneration) return;
      settled = myGeneration;
      ports.onError?.(error);
      show(false);
      return;
    }
    // Covers the three remaining exits below — no media, no anchor, and the show —
    // in one place, so a late answer can neither hide a button a newer refresh just
    // placed nor show one it just took down.
    if (settled > myGeneration) return;
    settled = myGeneration;
    const media = response?.ok ? response.media : undefined;
    if (!media) {
      show(false);
      return;
    }
    build();
    const el = pickAnchorElement(doc, win);
    if (!el) {
      show(false);
      return;
    }
    anchor = measure(el);
    const nextLabels = media.kind === 'video' ? media.labels : [];
    if (nextLabels.join('|') !== labels.join('|')) {
      labels = nextLabels;
      renderMenu();
    }
    if (!busy && Date.now() >= holdUntil) setTriggerState('idle', 'overlayDownload');
    place();
    show(true);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (frame !== undefined) win.cancelAnimationFrame(frame);
    win.removeEventListener('scroll', onScrollOrResize, true);
    win.removeEventListener('resize', onScrollOrResize);
    host?.remove();
    host = undefined;
    root = undefined;
    wrap = undefined;
    trigger = undefined;
    menu = undefined;
  }

  win.addEventListener('scroll', onScrollOrResize, true);
  win.addEventListener('resize', onScrollOrResize);

  return { refresh, dispose };
}
