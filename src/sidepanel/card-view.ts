// One grid card, as a model shape and as DOM.
//
// renderCard paints from the CardControls it is handed and calls back on click, so it
// reads no panel state: the caller owns the cart, the busy set and what a click means.

import type { MediaItem, MediaKind, MediaSource } from '../shared/media';
import { t } from '../shared/i18n';
import type { SavedEntry } from '../shared/saved';
import { buildThumbPair } from './media-play';
import { appendTag, formatDuration, KIND_ICON, presentationKey } from './format';

/** An image/audio item, or a whole video collapsed to the single representation the
 *  quality setting picks. */
export interface Card {
  /** The card's identity in the cart, the busy set, the failure tags and the saved
   *  list. For a video this is the GROUP key, never `target.id`: the winning
   *  representation is recomputed every render, so a pick or a failure tag keyed to it
   *  would evaporate under a card still on screen. Prefixed (`v:`/`i:`) because group
   *  keys and item ids must never collide. A persisted format — saved_ receipts store
   *  these, so changing it needs a migration (see SavedEntry in storage.ts). */
  id: string;
  /** Newest capture in the card, for the list order. */
  at: number;
  kind: MediaKind;
  source: MediaSource;
  /** Absent when nothing here is downloadable (an MSE blob:, a non-fbcdn URL). */
  target?: MediaItem;
  thumbUrl?: string;
  /** mediaId of thumbUrl — lets doRender drop an image card that is only a shown
   *  video's cover. */
  thumbId?: string;
  resLabel?: string;
  durationSec?: number;
  /** The target is a video-only DASH track: it will download muted. */
  mayLackAudio: boolean;
  /** This card is what the tab is playing right now. */
  live: boolean;
  /** Hidden from the LIBRARY grid by a declutter setting (videosOnly, minResolution).
   *  A flag, not a drop: the Saved history and the cart must keep seeing the card. */
  libraryHidden?: boolean;
  /** This image is the cover of a Library-visible video: a dupe under "All", but the
   *  real, downloadable item under the explicit "Images" sub-filter, where hiding it
   *  would make a captured cover unreachable in every view. */
  coverOfShown?: boolean;
  /** A Saved receipt with no live capture behind it (media_ was wiped). Renders with
   *  honest disabled controls; revives when a replay re-captures the same id. */
  stale?: boolean;
}

interface CardControls {
  picked: boolean;
  busy: boolean;
  /** Any download in flight disables every button, not just this card's. */
  downloadsDisabled: boolean;
  /** Why the last attempt failed, shown as a tooltip on the tag. */
  failure?: string;
  /** Toggle the pick and return the new state, so the button can repaint in place. */
  onPick: () => boolean;
  onDownload: (target: MediaItem) => void;
}

/** A Saved card rendered from its receipt alone — the live capture is gone. No target
 *  on purpose: receipts store no media URLs (fbcdn signatures rotate), so there is
 *  nothing truthful for a download button to fetch. */
export function stubCard(e: SavedEntry): Card {
  return {
    id: e.id,
    at: e.savedAt,
    kind: e.kind,
    source: e.source,
    target: undefined,
    thumbUrl: e.thumbUrl,
    resLabel: e.resLabel,
    durationSec: e.durationSec,
    mayLackAudio: false,
    live: false,
    stale: true,
  };
}

/** Paint one card's picked state in place — never a re-render: a rebuild would tear the
 *  clicked button out from under the click and drop the keyboard cursor with it.
 *
 *  Exported because three surfaces toggle a pick and only one of them has renderCard's
 *  closure: the checkbox and the card body do, the keyboard and the marquee do not. */
export function paintCardPicked(card: HTMLElement, picked: boolean): void {
  card.classList.toggle('is-picked', picked);
  card.querySelector('.pick')?.setAttribute('aria-pressed', String(picked));
}

/** The card's second line: "0:14 · 720p" for a video, "Photo" for an image, plus any
 *  tag it has earned. */
function cardMeta(card: Card, failure: string | undefined): HTMLElement {
  const meta = document.createElement('p');
  meta.className = 'card-meta';
  if (card.kind === 'video') {
    const parts = [card.durationSec != null ? formatDuration(card.durationSec) : null, card.resLabel].filter(
      (p): p is string => p != null,
    );
    meta.textContent = parts.length > 0 ? parts.join(' · ') : t('kindVideo');
  } else {
    meta.textContent = t(card.kind === 'image' ? 'cardPhoto' : 'kindAudio');
  }

  if (card.target == null) appendTag(meta, t(card.stale ? 'tagSavedGone' : 'unavailable'));
  if (card.kind === 'audio') appendTag(meta, t('tagAudioTrack'));
  if (card.mayLackAudio) appendTag(meta, t('tagMayLackAudio'));
  // The grid has no retry button, so a dead download would vanish silently; the card's
  // own Download button re-tries.
  if (failure != null) appendTag(meta, t('tagFailed'), 'tag-fail', failure);
  return meta;
}

export function renderCard(card: Card, controls: CardControls): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  if (card.live) el.classList.add('is-live');
  el.classList.toggle('is-picked', controls.picked);
  // The id the marquee and the keyboard cursor read back off the DOM, and the tabindex
  // that lets the cursor land here. -1, not 0: arrows move the cursor, so putting every
  // card in the Tab order would bury the tray and the nav behind a whole grid of stops.
  el.dataset.cardId = card.id;
  el.tabIndex = -1;

  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';
  if (card.kind === 'video') thumb.classList.add('is-video');

  // The fallback is an external SVG mask, never `thumb.textContent`: the pick and
  // download controls live inside the thumb and must survive a broken preview.
  const icon = document.createElement('span');
  icon.className = 'kind-fallback';
  icon.style.setProperty('--kind-icon', `url("${KIND_ICON[card.kind]}")`);
  const showIcon = (): void => {
    thumb.classList.remove('is-video'); // the play badge is ::after on .is-video
    thumb.prepend(icon);
  };

  if (card.thumbUrl != null) {
    const { bg, img } = buildThumbPair(card.thumbUrl, thumb, { lazy: true, onError: showIcon });
    thumb.append(bg, img);
  } else {
    showIcon();
  }

  // Two distinct honest excuses when nothing is downloadable: a stub is a receipt
  // whose capture is gone (a replay revives it); anything else is unreachable media.
  const why = t(card.stale ? 'titleSavedGone' : 'titleBlobUnavailable');

  // Selection check (top-right) — feeds the tray.
  const pick = document.createElement('button');
  pick.className = 'pick';
  pick.type = 'button';
  pick.setAttribute('aria-pressed', String(controls.picked));
  if (card.target != null) {
    pick.title = t('selectItem');
    pick.setAttribute('aria-label', t('selectItem'));
    pick.addEventListener('click', () => paintCardPicked(el, controls.onPick()));
    // The whole card is a selection target, not just the 28px checkbox — at three
    // columns that circle is most of what there is to aim at. The download button is the
    // one exception: it is the other thing a card does.
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.card-dl, .pick') != null) return;
      paintCardPicked(el, controls.onPick());
    });
  } else {
    pick.disabled = true;
    pick.title = why;
    pick.setAttribute('aria-label', why);
    el.classList.add('is-inert');
  }
  thumb.appendChild(pick);

  // Per-card download (bottom-right) — downloads this one immediately.
  const dl = document.createElement('button');
  dl.className = 'card-dl';
  dl.type = 'button';
  if (card.target != null) {
    const target = card.target;
    dl.title = t('downloadItem');
    dl.setAttribute('aria-label', t('downloadItem'));
    dl.classList.toggle('busy', controls.busy);
    dl.disabled = controls.downloadsDisabled;
    dl.addEventListener('click', () => controls.onDownload(target));
  } else {
    dl.disabled = true;
    dl.title = why;
    dl.setAttribute('aria-label', t(card.stale ? 'tagSavedGone' : 'unavailable'));
  }
  thumb.appendChild(dl);

  const title = document.createElement('h3');
  title.className = 'card-title';
  title.textContent = t(presentationKey(card.kind, card.source));

  el.append(thumb, title, cardMeta(card, controls.failure));
  return el;
}
