// The Now Playing surface: the live post, in focus, with its quality picker and one
// Download button.
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
import { defaultTarget } from '../shared/video-options';
import type { Settings } from '../shared/settings';
import { buildThumbPair, schedulePlayPositions } from './media-play';
import { cardBusy, failReason, qualityChoice, tabKey } from './tab-state';
import { byId, formatDuration, KIND_KEY, presentationKey, tn } from './format';

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
  /** Any download in flight disables the button — the same gate as the grid. */
  downloadsDisabled: boolean;
  onDownload: (cardId: string, target: MediaItem) => void;
  /** A committed quality pick ends the render hold the open picker was holding. */
  onQualityCommitted: () => void;
}

/** e.g. "Download MP4 · 1080p". */
function downloadLabel(target: MediaItem): string {
  const ext = fileExtensionFor(target).toUpperCase();
  const res = resolutionOf(target).label;
  return fmt('downloadKind', { label: target.kind === 'video' && res !== 'Video' ? `${ext} · ${res}` : ext });
}

/** Paint the view from a NowState. The quality selector and the Download button
 *  repaint the metadata in place, without going through render(). */
export function paintNow(now: NowState | null, controls: NowControls): void {
  byId('now-empty').hidden = now != null;
  byId('now-content').hidden = now == null;
  byId('now-live').hidden = now == null;
  if (now == null) return;

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
    byId('m-resolution').textContent = imageResolutionLabel;
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

  byId('now-title').textContent = name;
  // The post-piece count belongs to the view heading; the line under the title
  // describes the media itself ("Video · downloadable").
  byId('now-pieces').textContent = tn('piecesInPostOne', 'piecesInPost', now.pieces);
  byId('now-sub').textContent = `${t(KIND_KEY[now.kind])} · ${t('nowDownloadable')}`;

  byId('m-format').textContent = fileExtensionFor(target).toUpperCase();
  byId('m-duration-metric').hidden = isImage;
  // Hiding a cell does not remove its grid column, so the track count has to follow
  // the visible cells or images keep an empty third and an off-centre divider.
  byId('metrics').classList.toggle('is-two-up', isImage);
  byId('m-duration').textContent = isImage ? '' : duration || '—';

  const dl = byId<HTMLButtonElement>('now-download');
  const paintMeta = (): void => {
    byId('m-resolution').textContent =
      target.kind === 'video' ? resolutionOf(target).label : (imageResolutionLabel ?? '—');
    dl.disabled = controls.downloadsDisabled;
    dl.textContent = cardBusy.has(nowKey)
      ? target.audioUrl != null
        ? t('downloadMerging')
        : t('downloadSaving')
      : failReason.has(nowKey)
        ? t('downloadRetry')
        : downloadLabel(target);
  };

  // Quality selector — a native select, present for every video (disabled with a
  // single representation) and hidden for images/audio.
  const quality = byId('now-quality');
  const select = byId<HTMLSelectElement>('now-qselect');
  quality.hidden = now.kind !== 'video';
  if (now.kind === 'video') {
    const qcount = byId('now-qcount');
    qcount.textContent = singleOption ? '' : tn('qualityOptionsOne', 'qualityOptions', now.options.length);
    qcount.hidden = singleOption;
    quality.classList.toggle('is-single-option', singleOption);
    select.classList.toggle('is-single-option', singleOption);
    select.textContent = '';
    for (const opt of now.options) {
      const o = document.createElement('option');
      o.value = opt.id;
      o.textContent = resolutionOf(opt).label;
      select.appendChild(o);
    }
    select.value = target.id;
    select.disabled = singleOption;
    select.onchange = (): void => {
      target = now.options.find((o) => o.id === select.value) ?? now.options[0];
      qualityChoice.set(groupKey, target.id);
      paintMeta();
      controls.onQualityCommitted();
    };
  }

  dl.onclick = (): void => controls.onDownload(now.id, target);
  paintMeta();
  schedulePlayPositions();
}
