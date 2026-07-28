// Collapsing a video group's representations into a ranked, deduped option list.
//
// Shared by the panel and the service worker so the two can never disagree about what
// the options are. The worker computes them for the in-page button because only the
// worker may turn a resolution choice into an fbcdn URL — a content script shares a
// process with the page (see the FACESCRAP_DOWNLOAD_DASH handler's sender.tab
// rejection).
//
// Takes every panel-only input as a parameter, so nothing here reaches into a
// module-global or a cache that lives in one process.

import {
  canonicalizeHistoricalMediaId,
  fbAssetKeys,
  historicalAliasOwners,
  isFbcdn,
  matchesActiveMediaId,
  mediaId,
  resolutionOf,
  videoGroupKey,
  type MediaItem,
} from './media';
import type { Settings } from './settings';

interface VideoOptions {
  options: MediaItem[]; // downloadable representations, highest-resolution first
  gkey: string;
  thumbUrl?: string;
  durationSec?: number;
}

interface VideoOptionsContext {
  /** DASH pairs lose their audio track — and with it the remux — when the browser
   *  can't remux at all, or the user asked for direct downloads. It is a setting,
   *  not a property of the item, so it has to be re-applied wherever a stored item
   *  is turned back into a download. */
  stripAudio: boolean;
  /** The on-screen cover learned while the group played, if the caller has one.
   *  The panel wires this to now-playing.ts; the worker leaves it out. */
  groupCover?: (gkey: string) => string | undefined;
}

/**
 * What the tab is playing, as a PURE read of the stored PlayingRef.
 *
 * Must never call selectPlaying(): that is the detector, and it WRITES — it endorses a
 * group as live, learns durable cover/mark bindings, and updates the playing pin.
 * Those writes are correct for one caller on one cadence (the panel's render); a
 * second, faster writer corrupts detection and every download that follows from it.
 *
 * Answers reliably for PHOTOS only. A photo's fbcdn URL is in the DOM, so its id
 * reaches ref.ids and matches here. A video under MSE has a `blob:` src that never
 * becomes an id — identifying one takes the streamed-track evidence in
 * playingVideoGroup.
 */
export function playingItems(
  ref: { ids?: string[]; vid?: string } | null | undefined,
  items: MediaItem[],
): MediaItem[] {
  const active = new Set(ref?.ids ?? []);
  for (const id of [...active]) {
    const canonical = canonicalizeHistoricalMediaId(id);
    if (canonical != null) active.add(canonical);
  }
  const owners = historicalAliasOwners(items);
  // The page URL naming this exact video matches the efg `vid:` key of every one
  // of its representations and nothing else, so it survives fbcdn's prefetching
  // of the neighbouring reel.
  const urlVid = ref?.vid != null ? `vid:${ref.vid}` : undefined;
  return items.filter((i) => {
    if (matchesActiveMediaId(i, active, owners)) return true;
    if (i.thumbUrl != null && active.has(mediaId(i.thumbUrl))) return true;
    return urlVid != null && i.kind === 'video' && fbAssetKeys(i.url).includes(urlVid);
  });
}

/**
 * The playing video's representation group: videos ONLY, as the panel builds it.
 *
 * The audio representation shares the group key — that is what the key is for. Let one
 * through and it is offered as a resolution, and downloaded as an audio file.
 */
export function videoGroupOf(video: MediaItem, items: MediaItem[]): MediaItem[] {
  const key = videoGroupKey(video);
  return items.filter((i) => i.kind === 'video' && videoGroupKey(i) === key);
}

/** Only fbcdn media is downloadable — never a URL that slipped in from the page. */
export function isDownloadable(item: MediaItem): boolean {
  return isFbcdn(item.url);
}

/** Bitrate (bytes/s) parsed from a fbcdn URL's `bitrate=` param, 0 if absent. */
export function bitrate(url: string): number {
  const m = url.match(/[?&]bitrate=(\d+)/);
  return m ? Number(m[1]) : 0;
}

/** Will the download have sound? audioUrl → gets remuxed; non-`dash` → muxed
 *  progressive; a `dash` track without audioUrl is video-only (muted). */
export function willHaveAudio(i: MediaItem): boolean {
  return i.audioUrl != null || !i.dash;
}

/** Collapse a video group's representations into a deduped, ranked option list —
 *  shared by the grid card (which takes one), Now Playing (which keeps them all
 *  for the resolution picker) and the worker (which matches one by label for the
 *  in-page button). */
export function videoOptions(group: MediaItem[], context: VideoOptionsContext): VideoOptions {
  const src = context.stripAudio
    ? group.map((i) => (i.audioUrl != null ? { ...i, audioUrl: undefined } : i))
    : group;
  // Downloadable options: any fbcdn representation — including the network
  // capture, the always-present baseline. Deduplicated by resolution: for each
  // height prefer the one that will produce sound (muxed progressive or DASH pair
  // with audioUrl) over a muted DASH track of the same size.
  const downloadable = src.filter(isDownloadable);
  // Three tiers, and the order between them is what decides which file the user gets when a
  // ladder rung and a progressive baseline collapse under one label — which they do, because
  // Facebook publishes both for the same resolution.
  //
  //   sound        first, always: a silent file is not a smaller version of the same thing.
  //   measured     a representation that DECLARED its width and height came from the DASH
  //                manifest, so it is a real rung of the ladder. One without them is the
  //                progressive baseline, and on Facebook that is the lowest-bitrate encode
  //                of that size. Measured beats it.
  //   already muxed  only as a tie-break, to skip a remux when nothing else separates them.
  //
  // The middle tier is the one that was missing. Without it the baseline outscored the rung it
  // duplicates, so a 720x1280 DASH pair lost its slot to a progressive `tag=..._720p` — the
  // user picked "720p" and got the worse of the two files.
  const score = (i: MediaItem): number =>
    (willHaveAudio(i) ? 4 : 0) +
    (i.width != null && i.width > 0 && i.height != null && i.height > 0 ? 2 : 0) +
    (i.audioUrl == null ? 1 : 0);
  const byRes = new Map<string, MediaItem>();
  for (const i of downloadable) {
    const { label } = resolutionOf(i);
    if (label === 'Video') {
      byRes.set(`Video:${i.id}`, i); // unknown: don't collapse
      continue;
    }
    const prev = byRes.get(label);
    if (!prev) {
      byRes.set(label, i);
      continue;
    }
    const ds = score(i) - score(prev);
    if (ds > 0 || (ds === 0 && bitrate(i.url) > bitrate(prev.url))) byRes.set(label, i);
  }
  const options = [...byRes.values()].sort(
    (a, b) => resolutionOf(b).rank - resolutionOf(a).rank || bitrate(b.url) - bitrate(a.url),
  );
  const gkey = src.length > 0 ? videoGroupKey(src[0]!) : '';
  return {
    options,
    gkey,
    // Captured poster first; else the on-screen cover learned while it played.
    thumbUrl: src.find((i) => i.thumbUrl != null)?.thumbUrl ?? context.groupCover?.(gkey),
    durationSec: src.find((i) => i.durationSec != null)?.durationSec,
  };
}

/** The setting's preselected representation from an option list: 'highest' takes
 *  the top, 'lowest' the bottom, 'ask' the top (it only opens the Save-As dialog). */
export function defaultTarget(
  options: MediaItem[],
  defaultQuality: Settings['defaultQuality'],
): MediaItem | undefined {
  return defaultQuality === 'lowest' ? options[options.length - 1] : options[0];
}

/**
 * Resolve a user-supplied resolution label to one of the group's options.
 *
 * The in-page button sends back a LABEL, never a URL — the page context is never
 * told an fbcdn URL in the first place, so it cannot ask for one. An unknown or
 * missing label falls back to the settings default rather than failing, so a
 * stale menu (the representations changed while it was open) still downloads
 * something sensible instead of nothing.
 */
export function optionForLabel(
  options: MediaItem[],
  label: string | undefined,
  defaultQuality: Settings['defaultQuality'],
): MediaItem | undefined {
  if (label != null) {
    const match = options.find((i) => resolutionOf(i).label === label);
    if (match) return match;
  }
  return defaultTarget(options, defaultQuality);
}
