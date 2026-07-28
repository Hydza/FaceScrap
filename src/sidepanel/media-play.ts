// Where the play glyph sits on a thumbnail, and the blurred/sharp image pair every
// preview surface uses.
//
// Reads no panel state; imports only the pure geometry in ./play-position.

import { computePlayCenterY, createPlayPositionBatcher } from './play-position';

const PORTRAIT_COVER_MAX_ASPECT = 0.7;
const PREVIEW_PLAY_SIZE = 50;
const CARD_PLAY_SIZE = 30;
const PLAY_CLEARANCE = 12;

interface MediaPlayTarget {
  container: HTMLElement;
  image: HTMLImageElement | null;
  obstruction: HTMLElement | null;
  badgeSize: number;
}

/** The two surfaces that carry a play badge: the Now Playing preview and a video
 *  card's thumb. Null for anything else, or for a node already detached. */
function describeMediaPlay(container: HTMLElement): MediaPlayTarget | null {
  if (!container.isConnected) return null;
  const isPreview = container.id === 'now-preview';
  if (!isPreview && !container.matches('.card-thumb.is-video')) return null;
  return {
    container,
    image: container.querySelector<HTMLImageElement>(':scope > img:not(.thumb-bg)'),
    obstruction: isPreview
      ? document.getElementById('now-title')
      : (container.closest('.card')?.querySelector<HTMLElement>('.card-title') ?? null),
    badgeSize: isPreview ? PREVIEW_PLAY_SIZE : CARD_PLAY_SIZE,
  };
}

function measurePlayCenterY({ container, image, obstruction, badgeSize }: MediaPlayTarget): number | null {
  const frame = container.getBoundingClientRect();
  const obstructionRect = obstruction?.getBoundingClientRect();
  return computePlayCenterY({
    frameWidth: frame.width,
    frameHeight: frame.height,
    mediaWidth: image?.naturalWidth,
    mediaHeight: image?.naturalHeight,
    fit: image == null || image.classList.contains('media-fit-cover') ? 'cover' : 'contain',
    unobscuredBottom:
      obstructionRect != null && obstructionRect.height > 0 ? obstructionRect.top - frame.top : undefined,
    badgeSize,
    clearance: PLAY_CLEARANCE,
  });
}

function updatePlayPositions(requested: readonly HTMLElement[] | null): void {
  const containers =
    requested ??
    [
      document.getElementById('now-preview'),
      ...document.querySelectorAll<HTMLElement>('.card-thumb.is-video'),
    ].filter((element): element is HTMLElement => element instanceof HTMLElement);
  // Every geometry read completes before the first style write: interleaving them
  // forces one layout per thumbnail during a global resize pass.
  const measured = containers
    .map(describeMediaPlay)
    .filter((target): target is MediaPlayTarget => target != null)
    .map((target) => [target.container, measurePlayCenterY(target)] as const);
  for (const [container, centerY] of measured) {
    container.classList.toggle('play-obstructed', centerY == null);
    if (centerY == null) container.style.removeProperty('--play-y');
    else container.style.setProperty('--play-y', `${centerY.toFixed(2)}px`);
  }
}

const playPositionBatcher = createPlayPositionBatcher<HTMLElement>(
  (callback) => window.requestAnimationFrame(callback),
  updatePlayPositions,
);

export function schedulePlayPositions(container?: HTMLElement): void {
  playPositionBatcher.schedule(container);
}

export function setupPlayPositioning(): void {
  const observer = new ResizeObserver(() => schedulePlayPositions());
  for (const element of [
    document.getElementById('now-preview'),
    document.querySelector('.now-overlay'),
    document.getElementById('list'),
  ]) {
    if (element instanceof Element) observer.observe(element);
  }
  window.addEventListener('resize', () => schedulePlayPositions());
  void document.fonts.ready.then(() => schedulePlayPositions());
  schedulePlayPositions();
}

/** Keep Story-like portrait art immersive, but preserve the full composition of
 *  square, 4:5 and landscape posts. The blurred sibling fills any bars. */
function applyMediaFit(image: HTMLImageElement, container: HTMLElement): void {
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
  const aspect = image.naturalWidth / image.naturalHeight;
  image.classList.toggle('media-fit-cover', aspect <= PORTRAIT_COVER_MAX_ASPECT);
  schedulePlayPositions(container);
}

/**
 * Blurred cover-fit underlay + sharp contain-fit image, so a vertical story shows
 * whole instead of cropped. The one builder for every preview surface.
 *
 * `container` is what applyMediaFit measures against once the sharp image loads.
 * `onLoad`/`onError` layer a call site's own behaviour on the shared wiring — the
 * grid's icon fallback, Now Playing's live resolution readout.
 */
export function buildThumbPair(
  url: string,
  container: HTMLElement,
  options: { lazy?: boolean; onLoad?: (img: HTMLImageElement) => void; onError?: () => void } = {},
): { bg: HTMLImageElement; img: HTMLImageElement } {
  const bg = document.createElement('img');
  bg.className = 'thumb-bg';
  bg.alt = '';
  if (options.lazy) bg.loading = 'lazy';
  bg.addEventListener('error', () => bg.remove());

  const img = document.createElement('img');
  img.alt = '';
  if (options.lazy) img.loading = 'lazy';
  img.addEventListener('load', () => {
    applyMediaFit(img, container);
    options.onLoad?.(img);
  });
  img.addEventListener('error', () => {
    img.remove();
    bg.remove();
    options.onError?.();
  });
  bg.src = url;
  img.src = url;
  return { bg, img };
}
