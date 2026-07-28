// The Now Playing surface: the live post, in focus, with its resolution picker and one
// Save button.
//
// Takes what it paints as arguments and calls back on click, like card-view. The one
// exception is qualityChoice, which it both reads and writes — the pick is per tab and
// per video group, and it must survive the re-render that follows.

import {
  fileExtensionFor,
  imageDimensionsLabel,
  resolutionOf,
  type MediaItem,
  type MediaKind,
  type MediaSource,
} from '../shared/media';
import { fmt, t } from '../shared/i18n';
import { defaultTarget, willHaveAudio } from '../shared/video-options';
import type { Settings } from '../shared/settings';
import { buildThumbPair, schedulePlayPositions } from './media-play';
import { cardBusy, failReason, qualityChoice, tabKey } from './tab-state';
import {
  byId,
  COMPOSE_KEY,
  estimatedBytes,
  formatBytes,
  formatDuration,
  presentationKey,
} from './format';

export interface NowState {
  id: string; // the card id (v:gkey / i:id), so a Now Playing save shows in the grid
  kind: MediaKind;
  source: MediaSource;
  thumbUrl?: string;
  durationSec?: number;
  pieces: number; // total captured pieces in this post
  options: MediaItem[]; // quality options (video); a single entry for image/audio
  gkey: string; // qualityChoice key
}

interface NowControls {
  tid: number | undefined;
  defaultQuality: Settings['defaultQuality'];
  /** Where the file lands, for the line under the button. */
  subfolder: boolean;
  /** Any download in flight disables the button — the same gate as the grid. */
  downloadsDisabled: boolean;
  /** `saveAs` forces Chrome's Save-As dialog for this one download. */
  onDownload: (cardId: string, target: MediaItem, saveAs?: boolean) => void;
  /** A committed resolution pick ends the render hold the open picker was holding. */
  onQualityCommitted: () => void;
}

/** The ratios Facebook actually publishes. A raw w:h reduction prints 683:384 for a
 *  video that is 16:9 in every way that matters, so snap to the nearest of these
 *  instead — the overlay line is a description, not a measurement. */
const RATIOS: ReadonlyArray<[string, number]> = [
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['4:5', 4 / 5],
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['2:3', 2 / 3],
  ['3:2', 3 / 2],
];

function aspectLabel(item: MediaItem): string | undefined {
  const { width, height } = item;
  if (width == null || height == null || width <= 0 || height <= 0) return undefined;
  const value = width / height;
  let best = RATIOS[0]!;
  for (const entry of RATIOS) {
    if (Math.abs(entry[1] - value) < Math.abs(best[1] - value)) best = entry;
  }
  // Past 12% away from every named ratio it is not one of them, and naming it anyway
  // would be worse than saying nothing.
  return Math.abs(best[1] - value) / value <= 0.12 ? best[0] : undefined;
}

/** "MP4 · 16:9" for a video, "JPG · 944×1088" for a photo. The codec is deliberately
 *  absent: `stsd` is copied verbatim and never parsed (see ARCHITECTURE.md), so the
 *  panel genuinely does not know it.
 *
 *  A photo has no resolution ladder, so its picker row is hidden and its dimensions come
 *  here instead — every fact still stated exactly once. */
function formatLine(target: MediaItem, imageDimensions: string | undefined): string {
  const detail = target.kind === 'video' ? aspectLabel(target) : imageDimensions;
  return [fileExtensionFor(target).toUpperCase(), detail].filter((part) => part).join(' · ');
}

/** "1920×1080", when the representation declared both. */
function dimsLabel(item: MediaItem): string {
  const { width, height } = item;
  return width != null && height != null && width > 0 && height > 0 ? `${width}×${height}` : '';
}

/** The picker's third column. Empty when there is nothing honest to put in it. */
function sizeLabel(item: MediaItem, durationSec: number | undefined): string {
  return formatBytes(estimatedBytes(item, durationSec));
}

// ── The picker ────────────────────────────────────────────────────────────────
// Flat 38px whatever the option count, listing only the representations the manifest
// actually offers, and floating OVER the media so the frame never resizes.

let closePicker: (() => void) | undefined;

export function isResolutionPickerOpen(): boolean {
  return !byId('now-qlist').hidden;
}

/** Shut the list without committing. Safe to call when it is already closed. */
export function closeResolutionPicker(): void {
  closePicker?.();
}

function setPickerOpen(open: boolean): void {
  byId('now-qlist').hidden = !open;
  byId('now-qtrigger').setAttribute('aria-expanded', String(open));
}

/** Paint the view from a NowState. The resolution picker and the Save button repaint
 *  the metadata in place, without going through render(). */
export function paintNow(now: NowState | null, controls: NowControls): void {
  byId('now-empty').hidden = now != null;
  byId('now-content').hidden = now == null;
  if (now == null) {
    setPickerOpen(false);
    return;
  }

  const isImage = now.kind === 'image';
  const nowKey = tabKey(controls.tid, now.id);
  const groupKey = tabKey(controls.tid, now.gkey);
  const name = t(presentationKey(now.kind, now.source));
  const duration = now.durationSec != null ? formatDuration(now.durationSec) : '';
  const singleOption = now.options.length <= 1;
  // Chosen representation: the user's pick for this video in this tab, else the setting.
  let target =
    now.options.find((o) => o.id === qualityChoice.get(groupKey)) ??
    defaultTarget(now.options, controls.defaultQuality)!;
  let imageResolutionLabel = imageDimensionsLabel(target);
  const paintImageResolution = (image: HTMLImageElement): void => {
    if (!isImage || !image.isConnected || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
    imageResolutionLabel = `${image.naturalWidth}×${image.naturalHeight}`;
    byId('now-format').textContent = formatLine(target, imageResolutionLabel);
  };

  const preview = byId('now-preview');
  preview.classList.toggle('is-video', now.kind === 'video');
  // Rebuilt each paint. An expired or blocked fbcdn URL falls back to the gradient wash.
  preview.querySelectorAll('img').forEach((el) => el.remove());
  if (now.thumbUrl != null) {
    const { bg, img } = buildThumbPair(now.thumbUrl, preview, { onLoad: paintImageResolution });
    preview.prepend(bg, img);
    if (img.complete) paintImageResolution(img);
  }
  byId('now-badge').textContent = name;
  byId('now-dur').textContent = isImage ? '' : duration;
  byId('now-pieces').textContent = fmt(now.pieces === 1 ? 'piecesInPostOne' : 'piecesInPost', { n: now.pieces });

  const dl = byId<HTMLButtonElement>('now-download');
  const quality = byId('now-quality');
  const trigger = byId<HTMLButtonElement>('now-qtrigger');
  const list = byId('now-qlist');

  /** Everything that follows from WHICH representation is chosen — the overlay line,
   *  the audio pill, the trigger's three columns and the button's own state. */
  const paintTarget = (): void => {
    byId('now-format').textContent = formatLine(target, imageResolutionLabel);

    const audio = byId('now-audio');
    const hasAudio = willHaveAudio(target);
    audio.hidden = now.kind !== 'video';
    audio.classList.toggle('is-muted', !hasAudio);
    audio.textContent = t(hasAudio ? 'mediaAudioOk' : 'mediaAudioMuted');

    byId('now-qlabel').textContent = resolutionOf(target).label;
    byId('now-qdims').textContent = dimsLabel(target);
    byId('now-qsize').textContent = sizeLabel(target, now.durationSec);

    dl.disabled = controls.downloadsDisabled;
    dl.textContent = cardBusy.has(nowKey)
      ? target.audioUrl != null
        ? t('downloadMerging')
        : t('downloadSaving')
      : failReason.has(nowKey)
        ? t('downloadRetry')
        : fmt('nowSave', { kind: t(COMPOSE_KEY[now.kind]) });
  };

  // Videos only: a photo has no ladder to choose from, and its dimensions are on the
  // overlay line instead. A video with a single representation still shows the row — it
  // is where the resolution is stated — but the trigger is inert and loses its caret.
  quality.hidden = now.kind !== 'video';
  const qcount = byId('now-qcount');
  const top = now.options[0];
  const upTo = top != null ? dimsLabel(top) : '';
  qcount.textContent = singleOption
    ? ''
    : [
        fmt(now.options.length === 1 ? 'resAvailableOne' : 'resAvailable', { n: now.options.length }),
        upTo === '' ? undefined : fmt('resUpTo', { dims: upTo }),
      ]
        .filter((part) => part != null)
        .join(' · ');
  trigger.disabled = singleOption;

  const commit = (option: MediaItem): void => {
    target = option;
    qualityChoice.set(groupKey, option.id);
    setPickerOpen(false);
    paintRows();
    paintTarget();
    trigger.focus();
    controls.onQualityCommitted();
  };

  /** One row per offered representation. Rebuilt on commit rather than reconciled:
   *  six rows is cheaper to redraw than to diff, and the edge light is a sibling that
   *  survives because only the rows are replaced. */
  function paintRows(): void {
    list.querySelectorAll('.picker-row').forEach((row) => row.remove());
    for (const option of now!.options) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'picker-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.id === target.id));
      row.dataset.optionId = option.id;

      const tick = document.createElement('span');
      tick.className = 'picker-tick';
      tick.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'picker-label';
      label.textContent = resolutionOf(option).label;
      const dims = document.createElement('span');
      dims.className = 'picker-dims';
      dims.textContent = dimsLabel(option);
      const size = document.createElement('span');
      size.className = 'picker-size';
      size.textContent = sizeLabel(option, now!.durationSec);

      row.append(tick, label, dims, size);
      row.addEventListener('click', () => commit(option));
      list.appendChild(row);
    }
  }

  paintRows();
  setPickerOpen(false);

  trigger.onclick = (): void => {
    if (trigger.disabled) return;
    const open = !isResolutionPickerOpen();
    setPickerOpen(open);
    if (open) list.querySelector<HTMLElement>('.picker-row[aria-selected="true"]')?.focus();
    else controls.onQualityCommitted();
  };
  closePicker = (): void => {
    if (!isResolutionPickerOpen()) return;
    setPickerOpen(false);
    controls.onQualityCommitted();
  };

  byId('now-dest').textContent = t(controls.subfolder ? 'savesToFolder' : 'savesToRoot');
  byId<HTMLButtonElement>('now-saveas').onclick = (): void => controls.onDownload(now.id, target, true);
  dl.onclick = (): void => controls.onDownload(now.id, target);
  paintTarget();
  schedulePlayPositions();
}

/** Close the list on anything that means "not here any more": a click outside it,
 *  Escape, or the keyboard leaving it. Wired once at startup — the picker's own DOM is
 *  rebuilt on every paint, so per-paint listeners would stack up. */
export function setupResolutionPicker(): void {
  const list = byId('now-qlist');
  const trigger = byId('now-qtrigger');

  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Node;
    if (list.contains(target) || trigger.contains(target)) return;
    closeResolutionPicker();
  });
  document.addEventListener('keydown', (e) => {
    if (!isResolutionPickerOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // Escape also closes the Settings sheet; one meaning per press
      closeResolutionPicker();
      byId('now-qtrigger').focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...list.querySelectorAll<HTMLElement>('.picker-row')];
    if (rows.length === 0) return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    // Wraps, and an unfocused list starts from whichever end the arrow points at.
    rows[(at + step + rows.length) % rows.length]!.focus();
  });
}
