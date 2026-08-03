// Rubber-band selection over the grid — drag a box, everything it touches is picked.
//
// Purely ADDITIVE: a drag never clears a pick it did not make. A file manager's marquee
// replaces the selection, but the cart here survives view switches and tab switches, and
// one stray drag wiping a queue the user spent a scroll building is not a trade worth
// matching a convention for. Ctrl is therefore not needed to add — every drag adds.
//
// Owns no selection state: the controller is handed each newly covered card and decides.

import { byId } from './format';

/** Below this, the gesture is still a click — and a click toggles exactly one card. */
const DRAG_THRESHOLD_PX = 4;

interface Band {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function intersects(a: DOMRect, b: Band): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function setupMarquee(select: (card: HTMLElement) => void): void {
  const list = byId('list');
  let origin: { x: number; y: number } | undefined;
  let band: HTMLElement | undefined;
  let frame: number | undefined;
  // Cards this drag has already handed over, so crossing one twice does not toggle it
  // back off — the band grows and shrinks as the pointer moves.
  const covered = new Set<HTMLElement>();

  const stop = (): void => {
    origin = undefined;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    band?.remove();
    band = undefined;
    // Cleared: the grid rebuilds whenever a capture lands, so these node references go stale
    // within seconds of the drag ending.
    covered.clear();
  };

  list.addEventListener('pointerdown', (e) => {
    // Mouse only. On a touchscreen a drag across a scrolling list means "scroll", and a
    // band that swallowed it would leave the grid unscrollable.
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.tile-reveal, .pick') != null) return;
    origin = { x: e.clientX, y: e.clientY };
  });

  /** Draw the band and hand over whatever it now covers. Called at most once per frame. */
  function update(x: number, y: number): void {
    if (origin == null || band == null) return;
    // Clamped to the grid, so a drag that runs up into the header or down into the tray
    // paints a box over the cards and not over the chrome.
    const bounds = list.getBoundingClientRect();
    const clampX = (value: number): number => Math.min(bounds.right, Math.max(bounds.left, value));
    const clampY = (value: number): number => Math.min(bounds.bottom, Math.max(bounds.top, value));
    const rect: Band = {
      left: Math.min(clampX(origin.x), clampX(x)),
      right: Math.max(clampX(origin.x), clampX(x)),
      top: Math.min(clampY(origin.y), clampY(y)),
      bottom: Math.max(clampY(origin.y), clampY(y)),
    };

    // Every rect read first, then every write. select() paints the card it is handed, and
    // interleaving reads with paints costs one forced layout per card. Re-measured each frame
    // rather than cached at pointerdown: the wheel still scrolls the list mid-drag.
    const hits: HTMLElement[] = [];
    for (const card of list.querySelectorAll<HTMLElement>('.tile[data-card-id]')) {
      if (!covered.has(card) && intersects(card.getBoundingClientRect(), rect)) hits.push(card);
    }
    band.style.left = `${rect.left}px`;
    band.style.top = `${rect.top}px`;
    band.style.width = `${rect.right - rect.left}px`;
    band.style.height = `${rect.bottom - rect.top}px`;
    for (const card of hits) {
      covered.add(card);
      select(card);
    }
    // The gap left here: no auto-scroll when the pointer sits at an edge. The wheel
    // works during a drag, which covers it; add an edge timer only if that turns out
    // to be awkward.
  }

  // On the window, not the list: a drag that leaves the grid must keep tracking, and its
  // release outside the panel still has to tear the band down.
  window.addEventListener('pointermove', (e) => {
    if (origin == null) return;
    // No button held: the release happened somewhere this listener never saw — outside the
    // window, or taken by a native drag. The drag is over.
    if ((e.buttons & 1) === 0) {
      stop();
      return;
    }
    if (band == null) {
      if (
        Math.abs(e.clientX - origin.x) < DRAG_THRESHOLD_PX &&
        Math.abs(e.clientY - origin.y) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      band = document.createElement('div');
      band.className = 'marquee';
      // On the body: #list scrolls, and a band parented inside it would be clipped by
      // that overflow and would scroll away from the pointer.
      document.body.appendChild(band);
    }
    // One update per frame: a mouse reports moves faster than the screen repaints, and each
    // update measures every card in the grid.
    const { clientX, clientY } = e;
    if (frame === undefined) {
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        update(clientX, clientY);
      });
    }
  });

  window.addEventListener('pointerup', () => {
    const dragged = band != null;
    stop();
    if (!dragged) return;
    // The click that follows the release would toggle whichever card the pointer landed on,
    // undoing one of the picks the drag just made. Swallow exactly that one.
    const swallow = (e: Event): void => e.stopPropagation();
    window.addEventListener('click', swallow, { capture: true, once: true });
    // Dropped again if no click arrives, which is what a release outside the window gives.
    // The timeout runs after the click dispatch of the same input, so it cannot pre-empt the
    // swallow; left armed, it would eat the next unrelated click.
    window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
  });
  window.addEventListener('pointercancel', stop);
}
