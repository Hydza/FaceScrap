// One grid tile, as a model shape and as DOM.
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
  /** The tile's identity in the cart, the busy set, the failure tags and the saved
   *  list. For a video this is the GROUP key, never `target.id`: the winning
   *  representation is recomputed every render, so a pick or a failure tag keyed to it
   *  would evaporate under a tile still on screen. Prefixed (`v:`/`i:`) because group
   *  keys and item ids must never collide. A persisted format — saved_ receipts store
   *  these, so changing it needs a migration (see SavedEntry in storage.ts). */
  id: string;
  /** Newest capture in the tile, for the list order. */
  at: number;
  kind: MediaKind;
  source: MediaSource;
  /** Absent when nothing here is downloadable (an MSE blob:, a non-fbcdn URL). */
  target?: MediaItem;
  thumbUrl?: string;
  /** mediaId of thumbUrl — lets doRender drop an image tile that is only a shown
   *  video's cover. */
  thumbId?: string;
  resLabel?: string;
  durationSec?: number;
  /** The target is a video-only DASH track: it will download muted. */
  mayLackAudio: boolean;
  /** This tile is what the tab is playing right now. */
  live: boolean;
  /** Hidden from the LIBRARY grid by a declutter setting (videosOnly, minResolution).
   *  A flag, not a drop: the Saved history and the cart must keep seeing the tile. */
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
  /** The Saved grid: the top-left corner states that the file is already on disk and the
   *  top-right one reveals it, where Library puts the selection dot. */
  saved: boolean;
  /** Why the last attempt failed, shown as a tooltip on the tag. */
  failure?: string;
  /** Toggle the pick and return the new state, so the tile can repaint in place. */
  onPick: () => boolean;
  onReveal: () => void;
}

/** A Saved tile rendered from its receipt alone — the live capture is gone. No target
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

/** Paint one tile's picked state in place — never a re-render: a rebuild would tear the
 *  clicked button out from under the click and drop the keyboard cursor with it.
 *
 *  Exported because three surfaces toggle a pick and only one of them has renderCard's
 *  closure: the dot and the tile body do, the keyboard and the marquee do not. */
export function paintCardPicked(card: HTMLElement, picked: boolean): void {
  card.classList.toggle('is-picked', picked);
  card.querySelector('.pick')?.setAttribute('aria-pressed', String(picked));
}

/** The tile's caption meta: "0:34 · 1080p" for a video, "Photo" for an image, plus any
 *  tag it has earned. */
function cardMeta(card: Card, failure: string | undefined): HTMLElement {
  const meta = document.createElement('p');
  meta.className = 'tile-meta';
  if (card.kind === 'video') {
    const parts = [card.durationSec != null ? formatDuration(card.durationSec) : null, card.resLabel].filter(
      (p): p is string => p != null,
    );
    meta.textContent = parts.length > 0 ? parts.join(' · ') : t('kindVideo');
  } else {
    meta.textContent = t(card.kind === 'image' ? 'cardPhoto' : 'kindAudio');
  }

  if (card.target == null && !card.stale) appendTag(meta, t('unavailable'));
  if (card.kind === 'audio') appendTag(meta, t('tagAudioTrack'));
  if (card.mayLackAudio) appendTag(meta, t('tagMayLackAudio'));
  // The grid has no retry button, so a dead download would vanish silently; the tile's
  // own download button re-tries.
  if (failure != null) appendTag(meta, t('tagFailed'), 'tag-fail', failure);
  return meta;
}

/** Saved's top-left corner: the accent pill when the file is on disk and its post is
 *  still reachable, the neutral one when the capture behind it is gone. */
function savedBadge(card: Card): HTMLElement {
  const badge = document.createElement('span');
  badge.className = card.stale ? 'tile-badge is-gone' : 'tile-badge';
  badge.textContent = t(card.stale ? 'badgeCaptureGone' : 'badgeOnDisk');
  if (card.stale) badge.title = t('titleSavedGone');
  return badge;
}

export function renderCard(card: Card, controls: CardControls): HTMLElement {
  const el = document.createElement('article');
  el.className = 'tile';
  // Not the accent outline alone: "this is what the tab is playing" was carried by colour
  // only, which no screen reader reads.
  if (card.live) {
    el.classList.add('is-live');
    el.setAttribute('aria-current', 'true');
  }
  el.classList.toggle('is-picked', controls.picked);
  // The id the marquee and the keyboard cursor read back off the DOM, and the tabindex
  // that lets the cursor land here. -1, not 0: arrows move the cursor, so putting every
  // tile in the Tab order would bury the tray and the nav behind a whole grid of stops.
  el.dataset.cardId = card.id;
  el.tabIndex = -1;

  const thumb = document.createElement('div');
  thumb.className = 'tile-thumb';
  if (card.kind === 'video') thumb.classList.add('is-video');

  // The fallback is an external SVG mask, never `thumb.textContent`: the tile's corner
  // controls live outside the thumb and must survive a broken preview.
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

  const scrim = document.createElement('div');
  scrim.className = 'tile-scrim';
  scrim.setAttribute('aria-hidden', 'true');

  // Two distinct honest excuses when nothing is downloadable: a stub is a receipt
  // whose capture is gone (a replay revives it); anything else is unreachable media.
  const why = t(card.stale ? 'titleSavedGone' : 'titleBlobUnavailable');

  // The whole tile is a selection target, not just the 22px dot — at three columns that
  // circle is a fraction of what there is to aim at. Selecting is ALL a tile does now:
  // the design gave the grid one verb and moved downloading to the tray that selecting
  // raises, so there is no second control here to exclude but Saved's reveal button.
  //
  // Selectable means DOWNLOADABLE, in both grids. A stale receipt has no target, so
  // letting it into the cart would put an id in the tray that the bulk run then skips —
  // a count that promises more than it can save.
  if (card.target != null) {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.tile-reveal, .pick') != null) return;
      paintCardPicked(el, controls.onPick());
    });
  } else {
    el.classList.add('is-inert');
  }

  el.append(thumb, scrim);

  // Built before the corner controls so the selection dot can borrow its words: N buttons
  // all named "Select" say nothing about WHICH tile is being selected.
  const caption = document.createElement('div');
  caption.className = 'tile-caption';
  const title = document.createElement('h3');
  title.className = 'tile-title';
  title.textContent = t(presentationKey(card.kind, card.source));
  const meta = cardMeta(card, controls.failure);
  caption.append(title, meta);

  if (controls.saved) {
    el.appendChild(savedBadge(card));

    const reveal = document.createElement('button');
    reveal.className = 'tile-reveal';
    reveal.type = 'button';
    reveal.textContent = '↗';
    reveal.title = t('titleRevealFolder');
    reveal.setAttribute('aria-label', t('titleRevealFolder'));
    reveal.addEventListener('click', controls.onReveal);
    el.appendChild(reveal);
  } else {
    // Selection dot (top-left) — feeds the tray.
    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.type = 'button';
    pick.setAttribute('aria-pressed', String(controls.picked));
    if (card.target != null) {
      // The tile's own title and meta, not a bare "Select": with a screen reader the N
      // dots were otherwise indistinguishable from one another.
      const name = [t('selectItem'), title.textContent, meta.textContent]
        .filter((part): part is string => part != null && part !== '')
        .join(' · ');
      pick.title = t('selectItem');
      pick.setAttribute('aria-label', name);
      pick.addEventListener('click', () => paintCardPicked(el, controls.onPick()));
    } else {
      pick.disabled = true;
      pick.title = why;
      pick.setAttribute('aria-label', why);
    }
    el.appendChild(pick);
  }

  // The failure reason travelled only as a `title` on a non-focusable <span>. The tile is
  // what takes the keyboard cursor, so it is what describes itself with the reason.
  const failTag = meta.querySelector<HTMLElement>('.tag-fail');
  if (failTag != null) {
    failTag.id = `fail-${card.id}`;
    el.setAttribute('aria-describedby', failTag.id);
  }
  el.appendChild(caption);
  return el;
}
