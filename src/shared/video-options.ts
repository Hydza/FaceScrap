// Collapsing a video group's representations into a ranked, deduped option list.
//
// This used to live inside sidepanel.ts, where only the panel could reach it.
// The in-page download button needs the same list — but it must be computed by
// the SERVICE WORKER, never by the content script: the worker is the only side
// that may turn a resolution choice into a real fbcdn URL (see the
// FACESCRAP_DOWNLOAD_DASH handler's sender.tab rejection). Shared here so the
// panel and the worker can never disagree about what the options are.
//
// Deliberately free of any panel-only dependency: the two settings it used to
// read off a module-global, and the on-screen cover lookup it used to call into
// now-playing.ts for, are all parameters now. The worker only wants labels, and
// would have got nothing useful from a binding cache that lives in the panel's
// process anyway.

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
 * Deliberately NOT selectPlaying(). That function is the detector: it endorses a
 * group as live, LEARNS durable cover/mark bindings and writes the playing pin.
 * Those writes are correct for exactly one caller on one cadence — the panel's
 * render. Calling it from the in-page button's polling handler as well put a
 * second, faster writer on the same state and on the same storage keys, which is
 * what made detection and the downloads that follow from it go wrong.
 *
 * Still weaker than selectPlaying, and deliberately so — but it is no longer blind
 * to what the panel learned. A story or reel plays under MSE, so its <video> has a
 * `blob:` currentSrc that content.ts refuses to turn into an id: the ONLY thing
 * naming the video in `ref.ids` is its cover. Match that cover against a captured
 * item's thumbUrl and the button appears; miss (a different rendition, a capture
 * with no preview at all, a replay that fetched nothing) and there is no second
 * chance — which is a button that never appears on video at all, not one that
 * appears sometimes. The learned cover↔group bindings ARE that second chance, and
 * they are persisted under `bind_<tabId>`, so reading them here is a pure read of
 * storage exactly like the ref and the items themselves. Passed in rather than
 * fetched, so this function stays pure and the caller keeps owning the I/O.
 */
export function playingItems(
  ref: { ids?: string[]; vid?: string; hasVideo?: boolean } | null | undefined,
  items: MediaItem[],
  bindings?: { coverBind: [string, string][] } | null,
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
  const matched = items.filter((i) => {
    if (matchesActiveMediaId(i, active, owners)) return true;
    if (i.thumbUrl != null && active.has(mediaId(i.thumbUrl))) return true;
    return urlVid != null && i.kind === 'video' && fbAssetKeys(i.url).includes(urlVid);
  });
  // Only as a fallback, and only for video: a photo that matched nothing matched
  // nothing, and forcing a cover binding on it would offer the wrong media.
  if (bindings == null || ref?.hasVideo !== true || matched.some((i) => i.kind === 'video')) {
    return matched;
  }
  const bound = new Map(bindings.coverBind);
  for (const id of active) {
    const group = bound.get(id);
    if (group == null) continue;
    const groupItems = items.filter((i) => i.kind === 'video' && videoGroupKey(i) === group);
    if (groupItems.length > 0) return groupItems;
  }
  return matched;
}

/**
 * The playing video's representation group, built exactly as the panel builds it:
 * videos ONLY.
 *
 * An audio representation of the same video shares its group key — that is the
 * point of the key. Letting one into the option list is how the button came to
 * offer, and download, an audio file as if it were a resolution.
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
 *  for the quality selector) and the worker (which matches one by label for the
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
  const score = (i: MediaItem): number => (willHaveAudio(i) ? 2 : 0) + (i.audioUrl == null ? 1 : 0);
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
