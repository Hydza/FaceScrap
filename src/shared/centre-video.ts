// Which <video> on screen is the one being watched — the scoring half of
// centreMedia(), split out so it can be tested without a DOM.
//
// The geometry stays in content.ts; this file only decides. No chrome.*, no DOM.

export interface VideoCandidate {
  /** Visible width/height in px, already clipped to the viewport. */
  vw: number;
  vh: number;
  paused: boolean;
  ended: boolean;
  /** Whether the element's box covers the viewport centre point. */
  containsCentre: boolean;
}

/**
 * Remove the hit-tested cover that sat above a video we subsequently proved is already
 * playing. Facebook leaves blur-up/previous-card placeholders in the hit-test stack during
 * transitions; keeping that cover would mix two cards in one PlayingRef and teach the panel
 * a durable false association.
 *
 * `coverSharesCard` is what separates that placeholder from a cover this must NOT touch.
 * The viewer sets `pointer-events: none` on its `<video>`, so hit-testing the centre
 * returns the slide's own poster sitting behind it and never the video — which arrives
 * through the fallback scan with the same signature a real placeholder produces. Discarding
 * the poster there threw away the ONLY id that can name an MSE video, whose `blob:`
 * currentSrc never becomes one: the button then had nothing but streamed-track anchoring,
 * and stayed hidden on the surfaces it exists for while the panel showed the piece.
 *
 * A placeholder left over from another card lives in another card's subtree; the slide's own
 * poster is inside the same one. That containment is the discriminator, and it is the only
 * evidence available once the video is out of the hit-test stack.
 */
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

/**
 * Do the playing video and the hit-tested cover belong to the same viewer card?
 *
 * The video's own parent has to hold the cover. Deliberately NOT a walk up the tree:
 * climbing even one extra level reaches an ancestor that contains every card on the page,
 * which answers "yes" for any placeholder at all and destroys the distinction. The viewer
 * stacks a slide's poster and its video as siblings in the card, so one level is where the
 * answer is; a layout that nests them further reports no shared card and falls back to
 * discarding, which is the behaviour this replaced — a missing button, not a wrong one.
 *
 * Kept here beside the decision it feeds rather than in the DOM code, so the rule is
 * testable without a browser.
 */
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

/** Index of the video being watched, or undefined if none qualifies.
 *
 *  `gotCover` means the hit-test at the centre found a large fbcdn cover. That
 *  used to skip this fallback entirely, on the theory that a cover means a photo
 *  slide and any video under it is the previous slide buried beneath. True for a
 *  PAUSED video — the viewer keeps old slides stacked and pauses them. Not true
 *  for a playing one: a residual blur-up placeholder still fading out over a reel
 *  that has already started leaves the same hit-test signature, and suppressing
 *  the fallback there adopted no video at all while one played in plain sight.
 *  So the cover only excludes paused candidates.
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
