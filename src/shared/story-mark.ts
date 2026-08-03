import { isNumericMediaId } from './media-id';

// Profile highlights may omit the card segment.
const STORY_PATH = /\/stories\/([^/?#]+)(?:\/([^/?#]+))?/;
const STORY_DOM_ID = /^Uz[A-Za-z0-9_-]{10,252}={0,2}$/;
const DECODED_STORY_DOM_ID_PREFIXES = ['S:_ISC:', 'S3:'] as const;

function isDecodedStoryDomId(decoded: string): boolean {
  for (const prefix of DECODED_STORY_DOM_ID_PREFIXES) {
    if (decoded.startsWith(prefix) && isNumericMediaId(decoded.slice(prefix.length))) return true;
  }
  return false;
}

/** The opaque card id Facebook places on the active Story container. */
export function isStoryDomId(value: unknown): value is string {
  if (typeof value !== 'string' || !STORY_DOM_ID.test(value)) return false;
  const decoded = decodeStoryDomId(value);
  return decoded != null && isDecodedStoryDomId(decoded);
}

function decodeStoryDomId(value: string): string | null {
  try {
    let encoded = value.replace(/-/g, '+').replace(/_/g, '/');
    while (encoded.length % 4 !== 0) encoded += '=';
    return atob(encoded);
  } catch {
    return null;
  }
}

/**
 * Recognize a real GraphQL Story node and return the same opaque id exposed by
 * its rendered DOM container. Accept `S:_ISC:<story_card_id>` and `S3:<id>` forms.
 * Requiring both fields keeps unrelated `Uz...` node ids from becoming media
 * associations.
 */
export function storyDomIdFromGraphqlNode(value: unknown): string | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const node = value as Record<string, unknown>;
  if (!isStoryDomId(node.id)) return undefined;
  const info = node.story_card_info;
  if (info == null || typeof info !== 'object') return undefined;
  const rawCardId = (info as Record<string, unknown>).story_card_id;
  const cardId = typeof rawCardId === 'number' ? String(rawCardId) : rawCardId;
  if (!isNumericMediaId(cardId)) return undefined;
  const decoded = decodeStoryDomId(node.id);
  return decoded === `S:_ISC:${cardId}` || decoded === `S3:${cardId}` ? node.id : undefined;
}

/** Scope an exact Story association to the card's media attachment branch.
 *  Story nodes also contain feedback, actors, overlays, and link previews; a
 *  playable URL nested under those branches is not the card being watched and
 *  must not inherit DOM-grade evidence. Once inside `attachments`, descendants
 *  retain the context until a nested Story node establishes its own scope. */
export function storyDomIdForGraphqlChild(
  directStoryId: string | undefined,
  inheritedStoryId: string | undefined,
  childKey: string,
): string | undefined {
  if (directStoryId == null) return inheritedStoryId;
  return childKey === 'attachments' ? directStoryId : undefined;
}

/** Cheap pre-check so hot-path callers can skip the DOM work that feeds
 *  storyCardMark when the page cannot yield a story marker at all. */
export function isStoryPath(pathname: string): boolean {
  return STORY_PATH.test(pathname);
}

export function storyCardMark(pathname: string, domId?: string): string {
  const match = pathname.match(STORY_PATH);
  if (!match) return '';
  // A DOM-proven card id makes the URL's second segment irrelevant, which is what
  // lets the one-segment highlight form mint a durable mark at all.
  if (isStoryDomId(domId)) return `u:${match[1]}/${domId}`;
  // Without one, the provisional mark needs the URL to distinguish cards — and on a
  // highlight it cannot, because every slide shares the same path. Minting
  // `p:<set>/undefined` there would hand every slide one identity; no mark is the
  // honest answer, and it is what this surface already produced before.
  return match[2] != null ? `p:${match[1]}/${match[2]}` : '';
}

/** Extract the DOM card id only from the durable story portion of a mark. */
export function storyDomIdFromMark(mark: string | undefined): string | undefined {
  const story = durableStoryMarkPortion(mark);
  if (story == null) return undefined;
  const slash = story.lastIndexOf('/');
  if (slash < 0) return undefined;
  const domId = story.slice(slash + 1);
  return isStoryDomId(domId) ? domId : undefined;
}

/** Stable identity of a DOM-proven Story card, excluding the per-load video
 *  suffix. Facebook may replace an MSE MediaSource while the same card remains
 *  visible; that replacement is lifecycle noise, not a Story transition. */
export function durableStoryMarkPortion(mark: string | undefined): string | undefined {
  if (typeof mark !== 'string' || !mark.startsWith('u:')) return undefined;
  const separator = mark.indexOf('#');
  const story = separator >= 0 ? mark.slice(0, separator) : mark;
  const match = story.match(/^u:([^/#]+)\/([^/#]+)$/);
  if (match == null || !isStoryDomId(match[2])) return undefined;
  // Everything after the separator is an opaque per-load video marker. MSE
  // produces `vm:*`; progressive playback produces a (possibly persistence-
  // bounded) URL. The validated DOM Story id, not that suffix, is the authority.
  return story;
}

/** DOM-proven provenance: safe to persist and to rescue a revisit on. */
export function isDurableStoryMark(mark: string | undefined): mark is string {
  return durableStoryMarkPortion(mark) != null;
}

/**
 * Owner-independent durable KEY for a Story card — for a cache/binding map
 * whose identity must depend ONLY on the DOM-proven card, never on how the
 * viewer got there. `durableStoryMarkPortion` keeps the owner segment from
 * the URL (`match[1]` above) because Facebook pins that segment to whichever
 * card opened the tray, even as the DOM-proven card underneath moves across
 * buckets — so the SAME card yields a DIFFERENT owner-bearing string
 * depending on entry point, and a Map keyed on it misses on a different-tray
 * revisit. This drops that segment and keeps just the validated DOM id, so
 * the same card always mints the same key. `durableStoryMarkPortion` itself
 * is unchanged and remains correct for anywhere the owner-bearing display/
 * compare form is wanted.
 */
export function durableStoryCardKey(mark: string | undefined): string | undefined {
  const domId = storyDomIdFromMark(mark);
  return domId != null ? `u:${domId}` : undefined;
}

/** Tray-pinned URL provenance: compare-only, must never become a binding. */
export function isProvisionalStoryMark(mark: string | undefined): boolean {
  return mark?.startsWith('p:') === true;
}
