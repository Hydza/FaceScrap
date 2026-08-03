// In-page download button: save the reel/story/highlight you are watching, at a
// resolution you pick, without opening the side panel.
//
// Three constraints shape everything here:
//
// 1. The host hangs off document.documentElement in a CLOSED shadow root. Facebook
//    re-renders its viewer constantly, so a node parented inside it gets thrown away;
//    an unshadowed node would inherit their CSS and leak ours.
//
// 2. This module never learns a media URL. It asks the worker what the tab could
//    download and gets back resolution LABELS; the worker resolves the URL from its
//    own capture state. A content script shares a process with the page and must not
//    be able to aim the downloader.
//
// 3. Positioning is geometric, never selector-based. Facebook's class names churn
//    monthly (ARCHITECTURE.md); the bounding box of the media under the viewport
//    centre does not.
//
//    Where a foreground viewer draws its own controls over the media — a reel, a
//    video story, a highlight — the button joins that row (mute / play / more) and
//    reads as one more control in it. Everywhere else it takes the media's
//    top-right corner. The split is not cosmetic: in a feed post the only row is
//    the post's header, which leaves the viewport well before the image does, and a
//    button anchored to it hopped from row to corner mid-scroll.

import { t, type MsgKey } from '../shared/i18n';
import { fbcdnBackgroundUrl } from '../shared/media';
import type {
  PlayingDownloadOptionsResponse,
  RequestPlayingDownloadResponse,
} from '../shared/messages';

/** Below this, an <img> is chrome — avatars, reaction icons, story-tray thumbs. */
const MIN_IMAGE_PX = 180;
/** Corner offset, used wherever there is no row for the button to join. */
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
/** Wider ancestors belong to the page, whose top bar also contains icon buttons. */
const CARD_WIDTH_SLACK = 1.8;
/** How long the result glyph stays up before the button returns to idle. */
const RESULT_HOLD_MS = 2_500;
/** Neutral on purpose: this id lands in facebook.com's own DOM, where a product
 *  name is a one-selector test for which extension is installed. */
const HOST_ID = 'vp-actions-root';

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

interface DownloadOverlay {
  /** Re-ask the worker what is playing and show/hide/reposition accordingly.
   *
   *  Pass `mediaChanged` when the caller knows the slide itself moved on. An open
   *  resolution menu belongs to the video that was playing when it opened, so it
   *  has to close — the labels alone cannot detect this, two videos routinely
   *  offer the same ladder. */
  refresh: (options?: { mediaChanged?: boolean }) => Promise<void>;
  /** Show the result of a download this overlay did not start — the global shortcut's. Holds the
   *  glyph the same RESULT_HOLD_MS a click would, so the two read identically. */
  showResult: (ok: boolean) => void;
  dispose: () => void;
}

interface Anchor {
  rect: DOMRect;
  /** The media itself, and the viewer card holding the control row when one was
   *  found — place() hit-tests against them before drawing. */
  el: Element;
  card?: Element;
  /** The leftmost control of Facebook's own row, when one was found. */
  control?: DOMRect;
  /** That control's own computed background — the circle we sit next to. Copied
   *  rather than guessed at: the value differs between the reel viewer, the story
   *  viewer and the two themes, and Facebook re-tunes it. */
  chrome?: string;
}

/** Find Facebook's control row (mute / play / more), which sits in the top-right of the
 *  VIEWER CARD — not of the media. A video story fills its card, so the row lands inside
 *  the video's rect; a photo story is letterboxed, with the row well above the image.
 *  Walking up from the media until an ancestor's top band holds the row finds the card
 *  itself, so both shapes work with no distance constants.
 *
 *  No aria-label match (needs every locale Facebook ships) and no class match (breaks on
 *  the next rebrand). Three filters keep the geometry honest: icon-sized, so a text
 *  button like Follow is out; the right half of the band, because the left half is the
 *  author's avatar; and an ancestor no wider than the media, or we would be reading the
 *  page's own top nav, which is also a row of icon buttons. */
export function pickControlAnchor(
  doc: Document,
  win: Window,
  media: Element,
): { card: Element; control?: { rect: DOMRect; el: Element } } | undefined {
  const mediaRect = media.getBoundingClientRect();
  const icons: { rect: DOMRect; el: Element }[] = [];
  for (const el of doc.querySelectorAll('[role="button"], button')) {
    const r = el.getBoundingClientRect();
    if (r.width < CONTROL_MIN_PX || r.height < CONTROL_MIN_PX) continue;
    if (r.width > CONTROL_MAX_PX || r.height > CONTROL_MAX_PX) continue;
    if (r.bottom < 0 || r.top > win.innerHeight || r.right < 0 || r.left > win.innerWidth) continue;
    icons.push({ rect: r, el });
  }
  // The widest ancestor still narrow enough to be the card rather than the page. Reported even
  // when it holds no control row — Facebook auto-hides the reel controls after a few seconds of
  // stillness, and an empty icon list is normal — because place() hit-tests against the card, and
  // the bare media is the wrong target: the scrim a viewer stacks over a reel is not inside the
  // <video>.
  let card: Element | undefined;
  let node: Element | null = media.parentElement;
  for (let depth = 0; node != null && depth < ANCESTOR_LIMIT; depth++, node = node.parentElement) {
    const box = node.getBoundingClientRect();
    if (box.width > mediaRect.width * CARD_WIDTH_SLACK) break;
    card = node;
    const bandBottom = box.top + Math.min(box.height / 4, 200);
    const centreX = box.left + box.width / 2;
    const row = icons.filter(
      ({ rect: r }) =>
        r.left >= centreX && r.right <= box.right + GAP_PX && r.top >= box.top - 1 && r.bottom <= bandBottom,
    );
    // The ancestor that holds the row IS the viewer card. The control element goes
    // back too — its own computed colour is what our circle copies.
    if (row.length > 0) {
      return { card: node, control: row.reduce((left, r) => (r.rect.left < left.rect.left ? r : left)) };
    }
  }
  return card != null ? { card } : undefined;
}

type Glyph = 'idle' | 'done' | 'failed';

/** Filled shapes on a 24 grid, no stroke: Facebook's viewer controls are filled, and
 *  an outline reads as a graft however well it is placed.
 *
 *  Hold these two numbers if you redraw — 16.3% ink over the grid, 15.5 units tall.
 *  They are what Facebook's own play (16.3%), pause (16.4%) and speaker (16.3%)
 *  measure, by rasterising each path at 10x and counting covered pixels. Ink is what
 *  carries weight at 20px, not extent: a taller, thinner glyph reads SMALLER beside
 *  them.
 *
 *  Build with <path> elements so page Trusted Types policies cannot affect the icon. */
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
 *  video's poster is still in the DOM behind it.
 *
 *  Not centreMedia (content-playing.ts), which answers a similar question with
 *  different rules: it walks the centre stack and reads paused/ended to tell the
 *  active slide from the ones the viewer keeps stacked behind it, while this scores
 *  by area and never looks at playback state. On a stack of slides the two can name
 *  different elements. Left that way on purpose — this one only decides where the
 *  button is DRAWN, and what a click downloads comes from the worker's capture
 *  state, so a disagreement costs a button on the wrong box and nothing else.
 *  Sharing them would mean handing this module the detector's state, which is the
 *  coupling the injected ports exist to avoid. */
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

  // Photo stories may use a background-image div instead of an img. Inspect the
  // elements at the viewport center to find that surface without scanning the tree.
  if (typeof doc.elementsFromPoint !== 'function') return undefined;
  for (const el of doc.elementsFromPoint(cx, cy)) {
    const r = el.getBoundingClientRect();
    if (r.width < MIN_IMAGE_PX || r.height < MIN_IMAGE_PX) continue;
    // Shared with the detector's fbcdnCoverUrl, guards included: an rsrc.php sprite
    // is fbcdn too, and a big one would anchor the button to a banner instead of to
    // the photo.
    if (fbcdnBackgroundUrl(win.getComputedStyle(el).backgroundImage) != null) return el;
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
  /* Match the visual weight of the surrounding viewer controls. */
  width: 80%;
  height: 80%;
  fill: #fff;
  stroke: none;
  /* Facebook's own glyphs carry a shadow; without one a white icon vanishes on a
     bright frame. */
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}
/* The circle Facebook draws behind its own controls, copied off the one we sit
   next to (--chrome, set by place()). The fallback is only for a row whose buttons
   paint no background at all; guessing a value here is how the button ended up a
   pale disc beside their dark ones. */
.trigger { background: var(--chrome, rgba(0, 0, 0, 0.4)); }
/* Lighten whatever that colour turned out to be, without having to know it. */
.trigger:hover,
.trigger[aria-expanded="true"] { box-shadow: inset 0 0 0 999px rgba(255, 255, 255, 0.16); }
.trigger[data-busy] { opacity: 0.55; }
/* A set of options, not a list: a fixed two-column grid, so six resolutions read
   as a small palette instead of a column tall enough to cover the reel. GRID and
   not wrapped flex — flex sizes each chip to its own text, so "2560p" next to
   "720p" left ragged columns and a stray last chip. Every cell is one width now,
   and the backdrop takes the same colour as the controls so the two read as one
   set of chrome. */
.menu {
  display: none;
  grid-template-columns: repeat(2, 1fr);
  gap: 4px;
  width: 164px;
  padding: 5px;
  border-radius: 14px;
  background: var(--chrome, rgba(0, 0, 0, 0.4));
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.14);
}
.menu[data-open="1"] { display: grid; }
.menu button {
  min-height: 28px;
  padding: 5px 4px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  text-align: center;
  white-space: nowrap;
}
/* An odd number of resolutions would leave a half-empty last row; the last chip
   takes the whole width instead of sitting in a ragged gap. */
.menu button:last-child:nth-child(odd) { grid-column: 1 / -1; }
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
  /** Where the control row was last seen for `el`, as an offset from its top-right. */
  let rowSlot: { el: Element; dx: number; dy: number; size: number } | undefined;
  let labels: string[] = [];
  let busy = false;
  let disposed = false;
  let frame: number | undefined;
  let holdUntil = 0;
  // Bumped by every refresh(); `settled` is the newest one that actually wrote. Two refreshes are
  // routinely in flight at once — the 750ms poll and the one a slide change fires — and their
  // promises resolve in either order, because a message to a sleeping worker costs a wake-up.
  //
  // The test is `settled > mine`, NOT `mine !== generation`: a slide's first second fires refreshes
  // faster than the worker answers, so dropping every response that merely has a newer refresh
  // STARTED behind it would leave none of them painting. Only a newer answer that already DECIDED
  // may veto an older one.
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
    const found = pickControlAnchor(doc, win, el);
    return {
      rect: el.getBoundingClientRect(),
      el,
      card: found?.card,
      control: found?.control?.rect,
      chrome: found?.control != null ? controlBackground(found.control.el) : undefined,
    };
  }

  /** The neighbouring control's circle, or nothing if it paints none. A button
   *  Facebook renders with no background of its own leaves CSS's fallback in
   *  charge; anything else and we would be inventing a colour next to theirs. */
  function controlBackground(el: Element): string | undefined {
    if (typeof win.getComputedStyle !== 'function') return undefined;
    const colour = win.getComputedStyle(el).backgroundColor;
    if (!colour || colour === 'transparent' || /,\s*0\s*\)$/.test(colour)) return undefined;
    return colour;
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

  /** Does the media's own card still own the pixel we are about to draw on?
   *
   *  The wrap is position:fixed at a z-index above everything on the page, and it
   *  tracks the control row. Scroll the feed and that row slides under Facebook's
   *  sticky top bar — the row goes under, our button does not, so it ends up drawn
   *  ON the navbar. Hit-testing the point settles it without having to know the
   *  bar's height, or which of Facebook's overlays are sticky this month.
   *
   *  Tested against the CARD, not the media: a letterboxed photo's control row sits
   *  above the image, and the story viewer stacks its own scrim over the video —
   *  both are inside the card, neither is inside the media. */
  function ownsPoint(x: number, y: number): boolean {
    if (!anchor || typeof doc.elementsFromPoint !== 'function') return true;
    const owner = anchor.card ?? anchor.el;
    for (const el of doc.elementsFromPoint(x, y)) {
      // Our own host is the top hit at that point whenever the button is already
      // showing; a closed shadow root reports the host, never its contents.
      if (el === host) continue;
      return el === owner || owner.contains(el);
    }
    return false;
  }

  /** Is Facebook's row a fixed neighbour, or will it scroll off and leave the button
   *  behind? Two shapes qualify. The row is drawn ON the media — every foreground
   *  viewer does this, so the reel, the video story and the highlight all take it. Or
   *  the page cannot scroll at all, which is what the story viewers enforce, so a
   *  letterboxed photo's row above the image stays put too.
   *
   *  A feed post is neither: its row is the post header, out of the viewport while
   *  the image is still centred, and a button following it hopped to the corner
   *  halfway through a scroll. */
  function rowIsFixedNeighbour(media: DOMRect, control: DOMRect): boolean {
    if (control.top >= media.top && control.bottom <= media.bottom) return true;
    return doc.documentElement.scrollHeight <= win.innerHeight;
  }

  /** False when the button must not be drawn where it currently belongs. */
  function place(): boolean {
    if (!wrap || !anchor) return false;
    const { rect, control } = anchor;
    // Left of the row's first control, in the gap Facebook already leaves between
    // them; else the media's own top-right corner.
    const row = control != null && rowIsFixedNeighbour(rect, control) ? control : undefined;
    // The slot is an offset from the media's top-right corner, so it survives scrolling, and it
    // outlives the row itself — Facebook auto-hides the reel controls after a few seconds of
    // stillness. Forgotten as soon as the media changes.
    if (row) {
      rowSlot = { el: anchor.el, dx: rect.right - (row.left - GAP_PX), dy: row.top - rect.top, size: Math.round(row.height) };
    } else if (rowSlot?.el !== anchor.el) {
      rowSlot = undefined;
    }
    const size = rowSlot?.size ?? (control ? Math.round(control.height) : FALLBACK_SIZE_PX);
    const right = Math.round(rowSlot ? rect.right - rowSlot.dx : rect.right - INSET_PX);
    const top = Math.round(rowSlot ? rect.top + rowSlot.dy : rect.top + INSET_PX);
    // The wrap is anchored by its RIGHT edge (translateX below), so its own centre
    // is half a button to the left of `right`.
    if (!ownsPoint(right - size / 2, top + size / 2)) return false;
    wrap.style.left = `${right}px`;
    wrap.style.top = `${top}px`;
    wrap.style.setProperty('--size', `${size}px`);
    if (anchor.chrome != null) wrap.style.setProperty('--chrome', anchor.chrome);
    else wrap.style.removeProperty('--chrome');
    // Anchored by its right edge so the resolution menu, which is wider than the
    // button, opens leftwards over the media instead of off it.
    wrap.style.transform = 'translateX(-100%)';
    return true;
  }

  function show(visible: boolean): void {
    if (!wrap) return;
    if (visible) wrap.setAttribute('data-show', '1');
    else {
      wrap.removeAttribute('data-show');
      closeMenu();
    }
  }

  /** Re-place the button against the media's current position, without re-finding the control row.
   *  A row scan rects every `[role="button"]` in Facebook's tree, which is far more than a scroll
   *  frame can afford; the remembered slot holds the row's offset from the media's corner, and that
   *  offset is unchanged by scrolling. refresh() re-scans on its own 750ms tick, which is when a
   *  row can have moved. */
  function trackGeometry(): void {
    // Reposition only a visible button. refresh() owns showing it.
    if (!wrap || wrap.getAttribute('data-show') !== '1') return;
    if (frame !== undefined) return;
    frame = win.requestAnimationFrame(() => {
      frame = undefined;
      const el = pickAnchorElement(doc, win);
      if (!el) {
        show(false);
        return;
      }
      if (anchor != null && anchor.el === el) {
        anchor = { ...anchor, rect: el.getBoundingClientRect() };
        if (!place()) show(false);
        return;
      }
      anchor = measure(el);
      if (!place()) show(false);
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
    show(place());
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

  return {
    refresh,
    showResult: (ok) => {
      if (disposed || busy || !wrap) return;
      setTriggerState(ok ? 'done' : 'failed', ok ? 'overlayDone' : 'overlayFailed');
      holdUntil = Date.now() + RESULT_HOLD_MS;
    },
    dispose,
  };
}
