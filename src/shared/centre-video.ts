// Which <video> on screen is the one being watched — the scoring half of
// centreMedia(), split out so it can be tested without a DOM.
//
// The geometry stays in content-playing.ts; this file only decides. No chrome.*, no DOM.

export interface VideoCandidate {
  /** Visible width/height in px, already clipped to the viewport. */
  vw: number;
  vh: number;
  paused: boolean;
  ended: boolean;
  /** Whether the element's box covers the viewport centre point. */
  containsCentre: boolean;
}

/** Remove cover evidence from another card after a video is proven active. Preserve
 *  same-card posters because they may be the only stable id for an MSE `blob:` video. */
export function discardPlaceholderCoverEvidence(
  ids: Set<string>,
  covers: string[],
  coverIds: Iterable<string>,
  coverSharesCard = false,
): void {
  if (coverSharesCard) return;
  for (const id of coverIds) ids.delete(id);
  covers.length = 0;
}

/** Whether the video and cover share the video's direct parent. Do not walk higher:
 *  broader ancestors can contain several cards and create false associations. */
export function coverSharesVideoCard(
  video: { parentElement: unknown } | null | undefined,
  cover: unknown,
  contains: (ancestor: unknown, node: unknown) => boolean,
): boolean {
  const parent = video?.parentElement;
  if (parent == null || cover == null) return false;
  return contains(parent, cover);
}

/** Must be substantially on screen to count at all. */
const MIN_VISIBLE_PX = 100;

/** Index of the video being watched, or undefined if none qualifies. A large
 *  hit-tested cover excludes paused candidates but not an actively playing video.
 *
 *  Ranking: playing beats paused, then holding the centre, then visible area.
 *  Area maxes around ~2e6 px², so the boosts always dominate it — the centre
 *  point often lands beside a left-offset reel in a comments/profile panel, and
 *  ranking that by geometry alone picks the wrong video. */
export function pickBestVideoIndex(candidates: VideoCandidate[], gotCover: boolean): number | undefined {
  let best: number | undefined;
  let bestScore = -1;
  candidates.forEach((c, i) => {
    // Only `ended` disqualifies outright. readyState is a lie under Facebook's
    // MSE-in-Workers (permanently 0), so it cannot gate anything here.
    if (c.ended) return;
    // A centre cover can only be a transient placeholder for a video whose box
    // also contains the centre. A playing reel elsewhere on the page (feed,
    // background carousel, adjacent Story) must not displace the photo card.
    if (gotCover && (c.paused || !c.containsCentre)) return;
    if (c.vw < MIN_VISIBLE_PX || c.vh < MIN_VISIBLE_PX) return;
    const score = c.vw * c.vh + (c.paused ? 0 : 4e9) + (c.containsCentre ? 2e9 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
