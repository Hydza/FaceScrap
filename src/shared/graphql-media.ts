import {
  isFbcdn,
  isProfilePicCrop,
  mediaKindFromUrl,
  MAX_MEDIA_DIMENSION,
  MIN_MEDIA_DIMENSION_PX,
} from './media';

export const GRAPHQL_DIRECT_URL_KEYS = ['uri', 'url', 'src', 'base_url'] as const;

function directFbcdnUrl(value: unknown, keys: readonly string[]): string | undefined {
  if (typeof value === 'string') return isFbcdn(value) ? value : undefined;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && isFbcdn(candidate)) return candidate;
  }
  return undefined;
}

/**
 * A VIDEO_KEYS field is already strong type context; Facebook sometimes changes
 * only its value from a string to a one-level {uri|url|src|base_url} wrapper.
 * Keep this deliberately shallow so an unrelated nested image cannot be
 * promoted to a video merely because it shares a large parent object.
 */
export function graphqlVideoUrl(value: unknown): string | undefined {
  return directFbcdnUrl(value, GRAPHQL_DIRECT_URL_KEYS);
}

// The string-tolerant variant of media.ts's normalizeMediaDimension, not a second
// rule: GraphQL serves these as numbers or as digit strings, so only the parse differs.
function graphqlDimension(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d{1,6}$/.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_MEDIA_DIMENSION
    ? parsed
    : undefined;
}

interface GraphqlImageCandidate {
  url: string;
  width?: number;
  height?: number;
}

/**
 * Read Facebook's common {uri|url,width,height} image node. Outside an exact Story
 * media branch, require a dimension of at least 200 px to reject avatars and tray
 * previews. Story images may defer dimension verification to the visible DOM.
 */
export function graphqlImageCandidate(
  value: unknown,
  storyMediaBranch: boolean,
): GraphqlImageCandidate | undefined {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const node = value as Record<string, unknown>;
  const url = directFbcdnUrl(node, ['uri', 'url']);
  if (url == null || isProfilePicCrop(url)) return undefined;
  const explicitKind = mediaKindFromUrl(url);
  if (explicitKind === 'video' || explicitKind === 'audio') return undefined;

  const width = graphqlDimension(node.width);
  const height = graphqlDimension(node.height);
  // A supplied-but-invalid value is not the same as omitted metadata.
  if (node.width != null && width == null) return undefined;
  if (node.height != null && height == null) return undefined;
  if (
    (width != null && width < MIN_MEDIA_DIMENSION_PX) ||
    (height != null && height < MIN_MEDIA_DIMENSION_PX)
  ) {
    return undefined;
  }
  if (width == null && height == null && !storyMediaBranch) return undefined;

  return {
    url,
    ...(width == null ? {} : { width }),
    ...(height == null ? {} : { height }),
  };
}
