// Shared media model + pure helpers (no chrome.* here — this file is also
// bundled into the MAIN-world page hook, which has no extension APIs).

import { isStoryDomId } from './story-mark';

export type MediaKind = 'video' | 'image' | 'audio';
export type MediaSource = 'reel' | 'story' | 'highlight' | 'video' | 'page';
type MediaOrigin = 'network' | 'graphql' | 'dom';

export interface MediaItem {
  /** Stable dedupe key derived from the fbcdn asset id. */
  id: string;
  url: string;
  kind: MediaKind;
  source: MediaSource;
  /** True for a DASH track that may lack audio (or be audio-only). */
  dash?: boolean;
  /**
   * Linked DASH audio-track URL. When present, `url` (video-only) and this
   * are remuxed into one MP4 with audio (see offscreen document).
   */
  audioUrl?: string;
  /** Poster/thumbnail image URL, for previewing a video in the side panel. */
  thumbUrl?: string;
  /** Natural pixel width for images. */
  width?: number;
  /** Natural pixel height for images, or representation height for video. */
  height?: number;
  /**
   * trackKey() of every DASH representation (all qualities + audio). The player's
   * ABR pick rarely matches the top-bitrate track in `url`, so the side panel
   * matches the currently-fetched track against this set. DASH-harvested items only.
   */
  trackIds?: string[];
  /** Total video duration in seconds, from the DASH manifest. Videos only. */
  durationSec?: number;
  /**
   * Opaque DOM Story card ids whose GraphQL nodes contained this video. One
   * underlying Facebook video may be reposted by several cards, so this is a
   * small bounded set rather than one last-writer-wins value.
   */
  storyIds?: string[];
  origin: MediaOrigin;
  addedAt: number;
}

export function isFbcdn(url: string): boolean {
  // Match the PARSED hostname, not the raw string: fetch/new URL/chrome.downloads all
  // resolve the host with the WHATWG parser, which normalizes backslashes to slashes —
  // a raw-string regex would accept `https://evil.com\a.fbcdn.net/` while the real
  // request hits evil.com. The (case-insensitive) substring gate keeps the hot
  // harvest path cheap; the parsed hostname is the authority.
  if (!/fbcdn\.net/i.test(url)) return false;
  try {
    const u = new URL(url);
    // https only: everything passing this gate may be fetched or downloaded,
    // and fbcdn never serves media over cleartext anyway.
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'fbcdn.net' || h.endsWith('.fbcdn.net');
  } catch {
    return false;
  }
}

/**
 * True for Facebook's static UI assets (sprites, emoji, icons) served off
 * `static.*.fbcdn.net/rsrc.php/…` — they pass isFbcdn but are chrome, not content.
 * The `/rsrc.php/` prefix is the reliable signal (content lives under `/v/…`,
 * `/o1/…`, hashed paths); the `static.` host is a secondary hint.
 */
export function isStaticFbAsset(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.startsWith('/rsrc.php/') || u.hostname.startsWith('static.');
  } catch {
    return false;
  }
}

/**
 * True for profile-picture crop renditions: the fbcdn path type token with the
 * `-1` suffix (`/t39.30808-1/`, `/t1.6435-1/`, …). Facebook serves every
 * avatar and profile-photo crop under it — including the viewer's own face on
 * the stories tray's Create-story tile — while post/story media use other
 * suffixes (`-6` photos, `-10` video thumbs, `-15` …). Chrome, not content,
 * for the incidental GraphQL image harvest; the deliberate on-screen DOM scan
 * stays permissive so a full-size profile photo opened in the viewer can still
 * be captured.
 */
export function isProfilePicCrop(url: string): boolean {
  try {
    return /\/t[\d.]+-1\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// --- Cross-file invariants ---------------------------------------------
// These constants have no internal use in this module. They exist so other
// files that independently re-derive the same numbers — content.ts's DOM
// image floor, graphql-media.ts's candidate floor, playing-handler.ts's and
// story-mark.ts's numeric-id checks, service-worker.ts's DASH byte-range
// check — read from one source instead of drifting apart from it (and from
// each other).

/** Minimum natural pixel width/height for a DOM- or GraphQL-observed image to
 *  count as real content rather than an avatar/UI thumbnail/tray preview. */
export const MIN_MEDIA_DIMENSION_PX = 200;

/** Unanchored source for a plausible Facebook numeric id (video id, story
 *  card id, …): long enough to exclude small UI counters, short enough to
 *  stay a safe string length. Splice this into a larger pattern when the id
 *  sits alongside other context (e.g. a URL path segment); use
 *  NUMERIC_MEDIA_ID_RE (or isNumericMediaId) to test that a whole string is
 *  exactly one. */
export const NUMERIC_MEDIA_ID_SOURCE = '\\d{5,20}';
export const NUMERIC_MEDIA_ID_RE = new RegExp(`^${NUMERIC_MEDIA_ID_SOURCE}$`);

/** True for a string that is exactly a plausible Facebook numeric id. */
export function isNumericMediaId(value: unknown): value is string {
  return typeof value === 'string' && NUMERIC_MEDIA_ID_RE.test(value);
}

/** DASH byte-range segment query param names. widenDashUrl strips them below
 *  to recover the full-track URL; classifyNetworkRequest's isDash check tests
 *  for them too. The comment here used to say service-worker.ts re-spelled the
 *  pair as an inline regex and that the export existed for that copy to reference
 *  — it imports DASH_BYTE_RANGE_RE now, so there is no second literal to keep in
 *  lockstep. */
export const DASH_BYTE_RANGE_PARAMS = ['bytestart', 'byteend'] as const;
export const DASH_BYTE_RANGE_RE = new RegExp(`[?&](?:${DASH_BYTE_RANGE_PARAMS.join('|')})=`);

/** Widen a DASH byte-range segment URL into the full-track URL. */
export function widenDashUrl(url: string): string {
  try {
    const u = new URL(url);
    const wasSegment = DASH_BYTE_RANGE_PARAMS.some((param) => u.searchParams.has(param));
    for (const param of DASH_BYTE_RANGE_PARAMS) u.searchParams.delete(param);
    return wasSegment ? u.toString() : url;
  } catch {
    return url;
  }
}

// The stories/reel checks below already require slashes on BOTH sides
// ("/stories/…", "/reel/…"), so they anchor to a whole path segment. The
// highlight check must match the same way: a bare substring test would also
// accept "highlight" spelled out inside an unrelated slug — e.g. a vanity
// page path like "/football.highlights.daily/videos/123" — which then
// mislabels that tab's card labels and the {source} token of its download
// filenames. Slash- or string-boundary on both sides (plural allowed).
const HIGHLIGHT_SEGMENT_RE = /(?:^|\/)highlights?(?:\/|$)/i;

// Opening a profile's highlights does NOT produce a highlight path: Facebook
// reuses the plain story permalink and marks the surface only in the query —
// /stories/976731645401448/?source=profile_highlight. The path test above sees
// just "/stories/", so on its own it labelled every profile highlight an
// ordinary story, which then showed the wrong badge and title in Now Playing
// and wrote "story" into the {source} token of the download filename.
// Anchored on "_" or a string boundary so a longer unrelated value can't match.
const HIGHLIGHT_SOURCE_PARAM_RE = /(?:^|_)highlights?(?:_|$)/i;

function isHighlightQuery(search: string): boolean {
  const source = new URLSearchParams(search).get('source');
  return source != null && HIGHLIGHT_SOURCE_PARAM_RE.test(source);
}

/**
 * Classify a Facebook location into the capture surface FaceScrap labels media
 * with. One copy shared by the service worker (tab surface, from a navigated
 * URL), the page hook (GraphQL capture source, from `location`) and the content
 * script (DOM-scan fallback, from `location`), so their precedence — highlight,
 * then stories, then reel, then a plain watch/video page — can never drift
 * apart between the three call sites.
 *
 * `search` is required on purpose. It used to be a pathname-only classifier,
 * and all three callers duly passed only the pathname — which is exactly how
 * the profile-highlight query signal went unread. Making it required means the
 * compiler, not a reviewer, catches a caller that forgets it.
 */
export function mediaSourceFromLocation(pathname: string, search: string): MediaSource {
  if (HIGHLIGHT_SEGMENT_RE.test(pathname) || isHighlightQuery(search)) return 'highlight';
  if (/\/stories\//.test(pathname)) return 'story';
  if (/\/reel\//.test(pathname)) return 'reel';
  return 'video';
}

// One source of truth for the media file extensions FaceScrap recognizes, so
// kind classification (mediaKindFromUrl) and identity stability (mediaId) can
// never drift apart — a mismatch there splits or merges distinct media rows.
const IMAGE_EXTENSIONS = 'avif|gif|jpe?g|png|webp';
const AUDIO_EXTENSIONS = 'aac|m4a|mp3|ogg|opus|wav';
const VIDEO_EXTENSIONS = 'm4v|mov|mp4|webm';
const IMAGE_EXTENSION_RE = new RegExp(`\\.(?:${IMAGE_EXTENSIONS})$`, 'i');
const AUDIO_EXTENSION_RE = new RegExp(`\\.(?:${AUDIO_EXTENSIONS})$`, 'i');
const VIDEO_EXTENSION_RE = new RegExp(`\\.(?:${VIDEO_EXTENSIONS})$`, 'i');
/** Any path whose filename already pins a unique fbcdn object: resize/signature
 *  params rotate freely without changing identity, so mediaId keys it by path.
 *  Paths outside this set fall to genericEndpointId's semantic keying. Kept as
 *  the union of the three per-kind lists above. */
const KNOWN_MEDIA_EXTENSION_RE = new RegExp(
  `\\.(?:${IMAGE_EXTENSIONS}|${AUDIO_EXTENSIONS}|${VIDEO_EXTENSIONS})$`,
  'i',
);

/**
 * File extensions are stronger evidence than the capture channel. Chromium can
 * occasionally surface a Facebook image through a request classified as
 * `media`, while GraphQL keys can also be broader than their values. Correct
 * those contradictions at the shared model boundary so a JPG can never become
 * a video merely because that observer won the race.
 */
export function mediaKindFromUrl(url: string, hint?: MediaKind): MediaKind | undefined {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    if (IMAGE_EXTENSION_RE.test(path) || /\/safe_image\.php$/i.test(path)) return 'image';
    if (AUDIO_EXTENSION_RE.test(path)) return 'audio';

    const mime = parsed.searchParams.get('mime') ?? parsed.searchParams.get('mime_type');
    const mimeKind =
      mime?.toLowerCase().startsWith('image/') ? 'image'
        : mime?.toLowerCase().startsWith('audio/') ? 'audio'
          : mime?.toLowerCase().startsWith('video/') ? 'video'
            : undefined;
    let efgKind: MediaKind | undefined;
    const encodedEfg = decodeEfg(url);
    if (encodedEfg != null) {
      try {
        const efg = JSON.parse(encodedEfg) as Record<string, unknown>;
        const efgMime = typeof efg.mime === 'string'
          ? efg.mime
          : typeof efg.mime_type === 'string'
            ? efg.mime_type
            : undefined;
        if (efgMime?.toLowerCase().startsWith('image/')) efgKind = 'image';
        else if (efgMime?.toLowerCase().startsWith('audio/')) efgKind = 'audio';
        else if (efgMime?.toLowerCase().startsWith('video/')) efgKind = 'video';
        if (efg.is_audio === true || efg.is_audio === 1 || efg.is_audio === 'true' || efg.is_audio === '1') {
          efgKind = 'audio';
        }
      } catch {
        /* malformed efg cannot override the URL shape or capture hint */
      }
    }

    // Facebook commonly carries an audio-only DASH track in an MP4 container.
    // Preserve explicit audio evidence, but never let a contradictory image
    // MIME turn a concrete video container into a photo (or vice versa).
    if (VIDEO_EXTENSION_RE.test(path)) {
      return hint === 'audio' || mimeKind === 'audio' || efgKind === 'audio' ? 'audio' : 'video';
    }
    return mimeKind ?? efgKind;
  } catch {
    return undefined;
  }
}

/** Per-kind fallback extension: what every kind was hardcoded to before this
 *  function existed, still used when the URL carries no extension the item's
 *  kind recognizes (or the URL fails to parse). */
const DEFAULT_EXTENSION: Record<MediaKind, string> = { image: 'jpg', audio: 'm4a', video: 'mp4' };
const KIND_EXTENSION_RE: Record<MediaKind, RegExp> = {
  image: IMAGE_EXTENSION_RE,
  audio: AUDIO_EXTENSION_RE,
  video: VIDEO_EXTENSION_RE,
};

/**
 * On-disk file extension for a captured MediaItem's download. Every kind
 * covers several real container/codec extensions (png/webp/gif/avif for
 * images, …), so keying the extension off `kind` alone — as the download path
 * once did — saves every non-JPEG image as a lying .jpg. Prefer the URL's own
 * extension when it's one FaceScrap recognizes for THIS item's kind; fall back
 * to the kind's historical default for a missing/unrecognized extension, an
 * extension that belongs to a different kind (e.g. a video URL ending in
 * .jpg), or an unparseable URL. Always lowercase; never throws.
 */
export function fileExtensionFor(item: Pick<MediaItem, 'url' | 'kind'>): string {
  try {
    const path = new URL(item.url).pathname.toLowerCase();
    if (KIND_EXTENSION_RE[item.kind].test(path)) {
      const ext = /\.([a-z0-9]+)$/.exec(path)?.[1];
      if (ext != null) return ext;
    }
  } catch {
    /* unparseable URL — fall back to the kind default below */
  }
  return DEFAULT_EXTENSION[item.kind];
}

/** Small synchronous hash for bounded, non-secret identity strings. */
function identityHash(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * prime);
  }
  return hash.toString(16).padStart(16, '0');
}

const REPRESENTATION_FIELDS = [
  'audio_bitrate',
  'bitrate',
  'codec',
  'codecs',
  'height',
  'is_audio',
  'mime',
  'mime_type',
  'quality',
  'quality_label',
  'stream_type',
  'tag',
  'vencode_tag',
  'width',
] as const;

function representationValue(value: unknown): string | undefined {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

/**
 * Stable quality/audio discriminator for generic video redirectors. The asset
 * id groups a video; these fields keep its representations distinct without
 * admitting rotating delivery tokens into identity.
 */
function genericRepresentationKey(url: string, parsed: URL): string | undefined {
  const fields: Array<[string, string]> = [];
  for (const key of REPRESENTATION_FIELDS) {
    const value = parsed.searchParams.get(key);
    if (value != null && value !== '') fields.push([`q:${key}`, value]);
  }
  const encodedEfg = decodeEfg(url);
  if (encodedEfg != null) {
    try {
      const efg = JSON.parse(encodedEfg) as Record<string, unknown>;
      for (const key of REPRESENTATION_FIELDS) {
        const value = representationValue(efg[key]);
        if (value != null) fields.push([`e:${key}`, value]);
      }
    } catch {
      /* malformed efg still keeps its stable asset key when one was recoverable */
    }
  }
  if (fields.length === 0) return undefined;
  fields.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  return identityHash(JSON.stringify(fields));
}

// mediaId's ids are assumed to stay well under this bound: PlayingRef ids are
// truncated at 256 chars in transport (playing-handler.ts) and storage.ts's
// SavedEntry receipt contract reserves 256 chars for this value. `path` is
// taken straight from the URL, and the `asset` discriminator inside
// genericEndpointId can come straight from an attacker-decoded `efg` field
// (fbAssetKeys) — this whole path is reachable from the untrusted
// page-message channel (sanitizeIncomingItems) — so EVERY branch that can
// produce a mediaId can overflow, not only genericEndpointId's. Two earlier
// rounds each bounded a per-branch subset (genericEndpointId's three
// branches) and missed mediaIdCandidate's OWN two branches (`video-*` and the
// final `asset:` fallback) — a per-branch bound is exactly the pattern that
// keeps missing a sibling. boundMediaId is therefore applied ONCE, at the
// single point an id leaves mediaId (see mediaId below), so a future branch
// added to mediaIdCandidate is bounded automatically instead of by omission.
const MEDIA_ID_MAX_LEN = 256;

/**
 * Bound one candidate identity string — a mediaId or legacyMediaId candidate —
 * to the shared id contract above. Applied ONLY at those two exits: genericEndpointId
 * and mediaIdCandidate stay unbounded throughout, because genericEndpointId's
 * nested-url branch hashes a recursive candidate and bounding it mid-recursion
 * changes that hash's input, silently rewriting short ids that were already
 * stored. A candidate that already fits is returned byte-for-byte — the
 * overwhelming majority of real URLs — so this can never disturb an
 * already-stored short id. An overflowing candidate is hashed WHOLE (never
 * truncated: truncating could collide two long candidates that only diverge
 * near the end), so two different overlong candidates can never collapse into
 * the same bounded id regardless of which part of the candidate (path,
 * discriminator, or query) was the one that overflowed.
 */
function boundMediaId(candidate: string): string {
  return candidate.length <= MEDIA_ID_MAX_LEN ? candidate : `asset:q=${identityHash(candidate)}`;
}

function genericEndpointId(url: string, parsed: URL, path: string): string {
  // Generic video redirectors reuse one pathname, but efg carries the stable
  // asset identity shared by signature/host rotations. Keep a representation
  // discriminator when Facebook exposes one so separate quality tracks do not
  // collapse into a single row.
  const asset = fbAssetKeys(url)[0];
  if (asset != null) {
    const representation = genericRepresentationKey(url, parsed);
    return `asset:${path}?${asset}${representation == null ? '' : `&rep=${representation}`}`;
  }

  // safe_image.php (and similar proxy endpoints) identifies the underlying
  // resource in `url`; oh/oe/token are only expiring delivery signatures. Hash
  // the locator to keep PlayingRef ids below its bounded transport limit.
  const nestedUrl = parsed.searchParams.get('url');
  if (nestedUrl != null && nestedUrl !== '') {
    let resourceIdentity = nestedUrl;
    // A proxy can wrap an already-signed fbcdn rendition. In that case the
    // nested oh/oe/host rotate just like the outer proxy signature, while the
    // nested CDN pathname remains the canonical resource.
    if (isFbcdn(nestedUrl)) {
      // A proxy can wrap another signed fbcdn resource — a CDN rendition or even
      // another generic redirector — whose own oh/oe/host rotate like the outer
      // signature. Canonicalize it recursively so nothing rotating leaks into
      // identity. Recurses on mediaIdCandidate, the UNBOUNDED candidate: this
      // whole function stays unbounded precisely so identityHash below sees the
      // same string it always has. Hashing a bounded inner id instead would
      // change this branch's output — silently, and only for nested URLs whose
      // own candidate overflows — orphaning every already-stored row keyed off
      // the old value, while the outer id stayed short either way. The single
      // bound in mediaId() covers the result regardless. mediaIdCandidate always
      // recurses on a strictly shorter string (a decoded query value is shorter
      // than its parent URL), so this cannot loop.
      resourceIdentity = mediaIdCandidate(nestedUrl);
    }
    return `asset:${path}?resource=${identityHash(resourceIdentity)}`;
  }

  // Unknown generic endpoints remain conservative: retain their whole sorted
  // query so unrelated resources can never be grouped accidentally — but that
  // string, like `path` above, has no natural size ceiling. Bounding it is
  // mediaId()'s job, not this branch's: see the recursion note above for why
  // every branch here must stay unbounded.
  const query = new URLSearchParams(parsed.search);
  query.sort();
  const serialized = query.toString();
  return `asset:${path}${serialized === '' ? '' : `?${serialized}`}`;
}

/**
 * Canonical identity of one downloadable fbcdn object. The path identifies the
 * actual representation; the numeric video id alone does not, because every
 * rung in a DASH ladder can carry the same number. CDN host/routing prefixes,
 * byte ranges, and rotating signature params are deliberately ignored so the
 * manifest URL and the request URL for the same track still meet.
 *
 * Unbounded: `path` (and, in the simpleVideo branch, its captured filename;
 * in the final fallback, its `tag` query param) are taken straight from the
 * untrusted URL with no length cap of their own. Only mediaId (below) is
 * bounded — this raw candidate is also what genericEndpointId's nested-url
 * branch recurses on, where staying unbounded here is deliberate (see the
 * comment on that recursive call).
 */
function mediaIdCandidate(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/o\d+\/(?=v\/)/, '/');
    const tag = u.searchParams.get('tag');
    // Facebook's simple GraphQL fixture shape (also used by older stored rows)
    // already had a path-derived `video-*` id. Preserve that canonical spelling
    // while still deriving it here rather than trusting the supplied field.
    const simpleVideo = path.match(/^\/v\/t42\/([^/]+)\.mp4$/);
    if (simpleVideo) return `video-${simpleVideo[1]}${tag == null ? '' : `?tag=${encodeURIComponent(tag)}`}`;
    // Real CDN objects have a unique filename, so resize/signature parameters
    // can rotate without changing identity. Generic endpoints such as
    // safe_image.php reuse one pathname and need their own semantic identity.
    if (!path.startsWith('/v/') && !KNOWN_MEDIA_EXTENSION_RE.test(path)) {
      return genericEndpointId(url, u, path);
    }
    return `asset:${path}${tag == null ? '' : `?tag=${encodeURIComponent(tag)}`}`;
  } catch {
    return `invalid:${url}`;
  }
}

// mediaIdCandidate's `video-*` and final `asset:` branches are just as
// reachable from the untrusted page-message channel (sanitizeIncomingItems)
// as genericEndpointId's, and just as capable of overflowing the shared id
// contract — the reachable-but-unbounded gap two earlier rounds each left
// open in a different branch. Bounding the whole candidate here, once, at the
// single point every mediaId leaves this module, closes every current branch
// AND any branch added later without depending on that branch remembering to
// call boundMediaId itself.
export function mediaId(url: string): string {
  return boundMediaId(mediaIdCandidate(url));
}

/**
 * Read aliases emitted by older FaceScrap builds. Path-only generic ids cannot
 * identify two resources behind the same endpoint, so consumers must only
 * accept an alias when it maps to one unique current item.
 */
export function historicalMediaIds(url: string): string[] {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/o\d+\/(?=v\/)/, '/');
    const pathOnly = `asset:${path}`;
    const current = mediaId(url);
    // Only generic endpoints ever carried a path-only historical id. A simple
    // video (`video-*`) or an unparseable url never did, so emitting
    // `asset:${path}` for those would be an alias that canonicalizeHistoricalMediaId
    // round-trips to a different id — a latent migration trap. Restrict aliases
    // to the asset scheme so the two functions stay mutually consistent.
    if (!current.startsWith('asset:')) return [];
    return pathOnly === current ? [] : [pathOnly];
  } catch {
    return [];
  }
}

/** Re-canonicalize an `asset:` id emitted by the short-lived full-query scheme. */
export function canonicalizeHistoricalMediaId(id: string): string | undefined {
  if (!id.startsWith('asset:/')) return undefined;
  const resource = id.slice('asset:'.length);
  try {
    return mediaId(`https://identity.invalid.fbcdn.net${resource}`);
  } catch {
    return undefined;
  }
}

/** Identity produced by FaceScrap 1.0 before representation-safe canonical
 * ids were introduced. Kept only as a read/display alias for persisted session
 * rows and Saved receipts; all new writes use mediaId(). `pathname` is taken
 * straight from the same untrusted URL mediaId() reads, and the digit run
 * matched below has no length cap of its own, so this is bounded the same way
 * (and through the same helper) as mediaId(). */
export function legacyMediaId(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const numeric = pathname.match(/(\d{8,})/);
    return boundMediaId(numeric ? `fb:${numeric[1]}` : `path:${pathname}`);
  } catch {
    return undefined;
  }
}

/**
 * Alias ownership across a batch of currently-captured items: a legacy
 * path-only historical id (see historicalMediaIds) mapped to the ids of every
 * CURRENT item whose URL produces it. A generic endpoint (e.g. safe_image.php)
 * reuses one pathname, so two distinct captures can legitimately share the
 * same historical alias — matchesActiveMediaId only trusts an alias when this
 * map proves it names exactly one item. Build once per candidate batch and
 * reuse it across every item; rebuilding it per item is quadratic in batch size.
 */
export function historicalAliasOwners(items: readonly MediaItem[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const item of items) {
    for (const alias of historicalMediaIds(item.url)) {
      const owned = owners.get(alias) ?? new Set<string>();
      owned.add(item.id);
      owners.set(alias, owned);
    }
  }
  return owners;
}

/**
 * Does `item` correspond to one of the ids in `active`? The canonical union
 * for matching a captured MediaItem against a set of "centered/active" media
 * ids: the item's own id, its freshly recomputed mediaId (covers a stored row
 * whose id predates a canonicalization fix), its FaceScrap-1.0 legacyMediaId,
 * or an unambiguous historical alias (see historicalAliasOwners — pass the
 * owners map built from the SAME items `active` is being matched against).
 */
export function matchesActiveMediaId(
  item: MediaItem,
  active: ReadonlySet<string>,
  owners: ReadonlyMap<string, Set<string>>,
): boolean {
  if (active.has(item.id)) return true;
  if (active.has(mediaId(item.url))) return true;
  const legacy = legacyMediaId(item.url);
  if (legacy != null && active.has(legacy)) return true;
  return historicalMediaIds(item.url).some((alias) => active.has(alias) && owners.get(alias)?.size === 1);
}

/**
 * Stable key matching the currently-fetched fbcdn track to a captured
 * representation. Neither mediaId nor the full pathname is stable (no numeric
 * asset id; origin prefix varies: …/o1/v/… fetched vs …/v/… in the manifest); the
 * filename (per-track base64 token) survives origin routing, byte-range
 * segmenting, and the rotating query signature.
 */
export function trackKey(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ?? u.pathname;
  } catch {
    return url;
  }
}

/**
 * Decode a fbcdn URL's `efg` param (URL-safe base64) into its JSON string,
 * or null when the param is absent or malformed.
 */
let lastEfgUrl: string | undefined;
let lastEfgValue: string | null = null;
/** makeItem() resolves the same url through mediaKindFromUrl, fbAssetKeys and
 *  genericRepresentationKey in quick succession, each decoding `efg`. A one-slot
 *  memo collapses those repeats without unbounded state (the worker is not
 *  persistent, and the key is the full url so a hit is never stale). */
function decodeEfg(url: string): string | null {
  if (url === lastEfgUrl) return lastEfgValue;
  lastEfgUrl = url;
  lastEfgValue = decodeEfgUncached(url);
  return lastEfgValue;
}

function decodeEfgUncached(url: string): string | null {
  const m = url.match(/[?&]efg=([^&]+)/);
  if (!m) return null;
  try {
    let b64 = decodeURIComponent(m[1]).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    return atob(b64);
  } catch {
    return null;
  }
}

/**
 * Canonical per-video keys from a fbcdn URL's `efg` param. The same
 * `xpv_asset_id`/`video_id` appears in every representation of one video
 * (progressive playable_url plus the separate DASH video/audio tracks), making it
 * the only reliable cross-track match. Ids stay strings: 17 digits exceeds
 * Number.MAX_SAFE_INTEGER. Returns e.g. ["xpv:…", "vid:…"].
 */
export function fbAssetKeys(url: string): string[] {
  const json = decodeEfg(url);
  if (json == null) return [];
  const keys: string[] = [];
  const xpv = json.match(/"xpv_asset_id":\s*"?(\d+)/);
  if (xpv) keys.push(`xpv:${xpv[1]}`);
  const vid = json.match(/"video_id":\s*"?(\d+)/);
  if (vid) keys.push(`vid:${vid[1]}`);
  return keys;
}

/** Resolution label + rank for an item. Prefers the URL's `tag=..._720p` (progressive), then `height` (DASH), then the `efg`'s `vencode_tag`. */
export function resolutionOf(item: Pick<MediaItem, 'url' | 'height'>): { label: string; rank: number } {
  const tag = item.url.match(/[?&]tag=[^&]*?(\d{3,4})p/i);
  if (tag) return { label: `${tag[1]}p`, rank: Number(tag[1]) };
  if (item.height != null && item.height > 0) return { label: `${item.height}p`, rank: item.height };
  const json = decodeEfg(item.url);
  if (json != null) {
    const vt = json.match(/"vencode_tag":"[^"]*?\.(\d{3,4})\./);
    if (vt) return { label: `${vt[1]}p`, rank: Number(vt[1]) };
  }
  return { label: 'Video', rank: 0 };
}

/** Key that groups every representation of the same video (the efg's xpv_asset_id; falls back to the item id when there is no efg). */
export function videoGroupKey(item: MediaItem): string {
  return fbAssetKeys(item.url)[0] ?? item.id;
}

export function makeItem(
  url: string,
  kind: MediaKind,
  source: MediaSource,
  origin: MediaOrigin,
  now: number,
  dash = false,
): MediaItem {
  return { id: mediaId(url), url, kind: mediaKindFromUrl(url, kind) ?? kind, source, origin, dash, addedAt: now };
}

// Exported: storage.ts validates persisted SavedEntry shapes against the same
// enum authorities this sanitizer uses.
export const MEDIA_KINDS: ReadonlySet<string> = new Set(['video', 'image', 'audio']);
export const MEDIA_SOURCES: ReadonlySet<string> = new Set(['reel', 'story', 'highlight', 'video', 'page']);
const ORIGINS: ReadonlySet<string> = new Set(['network', 'graphql', 'dom']);

/**
 * Validate + normalize items from the untrusted page-message channel. The
 * MAIN-world hook shares the page's trust domain, so any co-resident script can
 * forge a MEDIA_FOUND payload: accept only fbcdn URLs and known enum values, and
 * rebuild a clean object so forged extra fields can't ride along. Downstream
 * consumers can then treat stored items as fbcdn-scoped.
 */
// Hard caps on the untrusted page-message channel: a hostile co-resident script
// can post arbitrarily large payloads; bound what one message may cost us.
export const MAX_ITEMS_PER_MESSAGE = 500;
export const MAX_MEDIA_URL_LEN = 8192;
export const MAX_TRACK_IDS = 64;
export const MAX_MEDIA_ITEM_BYTES = 64 * 1024;
export const MAX_MEDIA_BATCH_BYTES = 512 * 1024;
export const MAX_STORY_IDS = 8;
export const MAX_MEDIA_DIMENSION = 100_000;
// A capture timestamp is minted in the renderer and may spend a little time in
// an acknowledged retry queue. It is not authority for retention order beyond
// that small transit window.
const MAX_TIME = 8_640_000_000_000_000;
const MAX_CAPTURE_AGE_MS = 10 * 60 * 1000;
const MAX_CAPTURE_FUTURE_SKEW_MS = 2 * 60 * 1000;

function normalizeAddedAt(raw: unknown, now: number, allowHistorical: boolean): number {
  const safeNow = Number.isFinite(now) && Math.abs(now) <= MAX_TIME ? now : Date.now();
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) > MAX_TIME) return safeNow;
  if (raw <= 0 || raw > safeNow + MAX_CAPTURE_FUTURE_SKEW_MS) return safeNow;
  if (!allowHistorical && raw < safeNow - MAX_CAPTURE_AGE_MS) return safeNow;
  return raw;
}

function normalizeMediaDimension(raw: unknown): number | undefined {
  return typeof raw === 'number' &&
    Number.isSafeInteger(raw) &&
    raw > 0 &&
    raw <= MAX_MEDIA_DIMENSION
    ? raw
    : undefined;
}

/** Verified natural pixel area for an image, or zero when either dimension is unknown. */
export function imagePixelArea(item: Pick<MediaItem, 'kind' | 'width' | 'height'>): number {
  if (item.kind !== 'image') return 0;
  const width = normalizeMediaDimension(item.width);
  const height = normalizeMediaDimension(item.height);
  return width != null && height != null ? width * height : 0;
}

/** Stored natural dimensions for an image, ready for the side-panel metadata row. */
export function imageDimensionsLabel(
  item: Pick<MediaItem, 'kind' | 'width' | 'height'>,
): string | undefined {
  if (imagePixelArea(item) === 0) return undefined;
  return `${item.width}×${item.height}`;
}

// Module-scope: mergeMedia recomputes this for the SAME already-built
// candidate object multiple times per item (normalizeMergeCandidate's own
// entry/exit checks, plus its caller's changed-detection compare), and
// getMedia re-runs mergeMedia on EVERY read — at the storage cap that
// repetition, not any one call, is what costs. A fresh TextEncoder per call
// was one avoidable cost; the identity cache below removes the rest.
const mediaItemWeightEncoder = new TextEncoder();
const mediaItemWeightCache = new WeakMap<object, number>();

/** UTF-8 serialized size used by both page-channel validation and bounded
 * delivery queues. Invalid/cyclic values are treated as infinitely large.
 * Memoized by object identity — safe because every MediaItem candidate built
 * in this module is constructed once and never mutated afterward, and a
 * storage read always hands back freshly-deserialized objects this cache has
 * never seen before. */
export function mediaItemWeight(value: unknown): number {
  const cacheable = value != null && typeof value === 'object';
  if (cacheable) {
    const cached = mediaItemWeightCache.get(value as object);
    if (cached !== undefined) return cached;
  }
  let weight: number;
  try {
    const serialized = JSON.stringify(value);
    weight = typeof serialized === 'string'
      ? mediaItemWeightEncoder.encode(serialized).byteLength
      : Number.POSITIVE_INFINITY;
  } catch {
    weight = Number.POSITIVE_INFINITY;
  }
  if (cacheable) mediaItemWeightCache.set(value as object, weight);
  return weight;
}

function normalizeTrackIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const prefix = raw.slice(0, MAX_TRACK_IDS);
  return prefix.every((track) => typeof track === 'string' && track.length <= 512)
    ? prefix as string[]
    : [];
}

function normalizeStoryIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Inspect only a small prefix even if a hostile page supplies a huge array.
  for (const value of raw.slice(0, MAX_STORY_IDS * 4)) {
    if (!isStoryDomId(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length === MAX_STORY_IDS) break;
  }
  return out;
}

/** Merge oldest-to-newest associations while keeping the newest bounded tail.
 *  A popular video can be reposted by many Story cards; keeping the first eight
 *  would eventually discard the card the user just opened and defeat the exact
 *  now-playing association this field exists to provide. */
function mergeStoryIds(older: unknown, newer: unknown): string[] {
  const out: string[] = [];
  for (const id of [...normalizeStoryIds(older), ...normalizeStoryIds(newer)]) {
    const previous = out.indexOf(id);
    if (previous >= 0) out.splice(previous, 1);
    out.push(id);
  }
  if (out.length > MAX_STORY_IDS) out.splice(0, out.length - MAX_STORY_IDS);
  return out;
}

/**
 * Shape-check + copy a MediaItem out of an untrusted record. Both entry
 * points below — sanitizeIncomingItems (the untrusted page-message channel)
 * and mergeMedia's normalizeMergeCandidate (existing storage rows AND new
 * incoming items) — fork from this ONE gate-and-copy chain, so a MediaItem
 * field added later cannot be copied in one path and silently stripped in
 * the other: mergeMedia stores whatever this returns (byId.set), and
 * getMedia runs mergeMedia on every read, so a dropped field here used to be
 * a live, persisted data-loss bug, not just a shape mismatch.
 * `allowHistorical` is forwarded to normalizeAddedAt as-is: fresh incoming
 * items (sanitizeIncomingItems, and mergeMedia's incoming side) never allow
 * it; existing persisted rows (mergeMedia's existing side) do.
 */
function normalizeMediaCandidate(raw: unknown, now: number, allowHistorical: boolean): MediaItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const it = raw as Record<string, unknown>;
  if (typeof it.url !== 'string' || it.url.length > MAX_MEDIA_URL_LEN || !isFbcdn(it.url)) return null;
  // fbcdn-hosted UI chrome (rsrc.php sprites/emoji) rides along in GraphQL
  // bodies as image URIs — it is never downloadable media.
  if (isStaticFbAsset(it.url)) return null;
  if (typeof it.kind !== 'string' || !MEDIA_KINDS.has(it.kind)) return null;
  if (typeof it.source !== 'string' || !MEDIA_SOURCES.has(it.source)) return null;
  if (typeof it.origin !== 'string' || !ORIGINS.has(it.origin)) return null;
  // Optional URL-bearing fields, if present, must also be fbcdn (and bounded).
  if (
    it.audioUrl !== undefined &&
    (typeof it.audioUrl !== 'string' || it.audioUrl.length > MAX_MEDIA_URL_LEN || !isFbcdn(it.audioUrl))
  ) {
    return null;
  }
  if (
    it.thumbUrl !== undefined &&
    (typeof it.thumbUrl !== 'string' || it.thumbUrl.length > MAX_MEDIA_URL_LEN || !isFbcdn(it.thumbUrl))
  ) {
    return null;
  }

  const clean: MediaItem = {
    id: mediaId(it.url),
    url: it.url,
    kind: mediaKindFromUrl(it.url, it.kind as MediaKind) ?? it.kind as MediaKind,
    source: it.source as MediaSource,
    origin: it.origin as MediaOrigin,
    addedAt: normalizeAddedAt(it.addedAt, now, allowHistorical),
  };
  if (typeof it.dash === 'boolean') clean.dash = it.dash;
  if (typeof it.audioUrl === 'string') clean.audioUrl = it.audioUrl;
  if (typeof it.thumbUrl === 'string') clean.thumbUrl = it.thumbUrl;
  const width = normalizeMediaDimension(it.width);
  const height = normalizeMediaDimension(it.height);
  if (width != null) clean.width = width;
  if (height != null) clean.height = height;
  if (typeof it.durationSec === 'number' && Number.isFinite(it.durationSec)) clean.durationSec = it.durationSec;
  const trackIds = normalizeTrackIds(it.trackIds);
  if (trackIds.length > 0) clean.trackIds = trackIds;
  const storyIds = normalizeStoryIds(it.storyIds);
  if (storyIds.length > 0) clean.storyIds = storyIds;
  return clean;
}

export function sanitizeIncomingItems(
  raw: unknown,
  maxTotalBytes = Number.POSITIVE_INFINITY,
  now = Date.now(),
): MediaItem[] {
  if (!Array.isArray(raw)) return [];
  if (!(maxTotalBytes > 0)) return [];
  const out: MediaItem[] = [];
  let totalBytes = 0;
  for (const r of raw.slice(0, MAX_ITEMS_PER_MESSAGE)) {
    const clean = normalizeMediaCandidate(r, now, false);
    if (clean == null) continue;
    const itemBytes = mediaItemWeight(clean);
    if (itemBytes > MAX_MEDIA_ITEM_BYTES) continue;
    // Runtime-message receivers pass their transport budget here. Stop as soon
    // as the next clean item would cross it: the sender's ordered ACK queue
    // already splits legitimate traffic, while a forged 500-item renderer
    // payload cannot make the worker allocate/copy tens of megabytes first.
    if (totalBytes + itemBytes > maxTotalBytes) break;
    totalBytes += itemBytes;
    out.push(clean);
  }
  return out;
}

/** Classify a raw fbcdn request of webRequest type `media` (the service-worker observer filters on type before calling). */
export function classifyNetworkRequest(url: string, now: number, source: MediaSource = 'video'): MediaItem | null {
  if (url.length > MAX_MEDIA_URL_LEN || !isFbcdn(url)) return null;
  const isDash = DASH_BYTE_RANGE_RE.test(url);
  return makeItem(widenDashUrl(url), 'video', source, 'network', now, isDash);
}

/**
 * Merge new items into an existing list, deduping by id. If an incoming item
 * carries a linked audio track (audioUrl) where the stored one didn't, upgrade
 * it in place — the same video then becomes downloadable WITH audio.
 * Returns [merged, changed].
 */
function normalizeMergeCandidate(raw: MediaItem, now: number, allowHistorical: boolean): MediaItem | null {
  // Early exit on the untouched candidate: merge-specific, kept as-is. The
  // gate chain and field copy live once, in normalizeMediaCandidate, shared
  // with sanitizeIncomingItems.
  if (mediaItemWeight(raw) > MAX_MEDIA_ITEM_BYTES) return null;
  const it = normalizeMediaCandidate(raw, now, allowHistorical);
  return it != null && mediaItemWeight(it) <= MAX_MEDIA_ITEM_BYTES ? it : null;
}

export function mergeMedia(existing: MediaItem[], incoming: MediaItem[], now = Date.now()): [MediaItem[], boolean] {
  const byId = new Map<string, MediaItem>();
  let changed = false;
  const insert = (raw: MediaItem, allowHistorical: boolean, isIncoming: boolean): void => {
    const it = normalizeMergeCandidate(raw, now, allowHistorical);
    if (!it) {
      if (!isIncoming) changed = true;
      return;
    }
    if (!isIncoming && (raw.id !== it.id || raw.addedAt !== it.addedAt || mediaItemWeight(raw) !== mediaItemWeight(it))) {
      changed = true;
    }
    const prev = byId.get(it.id);
    if (!prev) {
      byId.set(it.id, it);
      if (isIncoming) changed = true;
      return;
    }
    // Two persisted legacy rows may name the same URL with different forged or
    // pre-canonical ids. The returned map compacts them; flag the migration so
    // storage writes that repaired shape back even when neither row enriches it.
    if (!isIncoming) changed = true;
    // Enrich transactionally: every accepted intermediate shape must remain a
    // valid storable item. Never delete a field already present on `prev` just
    // to make room for new metadata. Strong playback associations win first;
    // lower-priority track/preview metadata is admitted only while it fits.
    const gainsAudio = Boolean(it.audioUrl) && !prev.audioUrl;
    // Deliberately stays first-wins (never replaces an already-set thumbUrl):
    // MediaItem carries no signal — verified dimensions, capture provenance,
    // or otherwise — describing a THUMBNAIL's own quality independent of
    // guessing at Facebook's private URL scheme. `origin` cannot substitute:
    // it names this item's ORIGINAL capture, not necessarily which later
    // insert supplied prev.thumbUrl (thumbUrl and origin can be set by
    // different merge passes over the item's life), so treating e.g. a 'dom'
    // origin as "the poster is trustworthy" would assert a correlation the
    // data doesn't actually guarantee. Revisit if a future capture path
    // starts attaching a verified width/height (or similar) to the
    // thumbnail itself rather than to the item.
    const gainsThumb = Boolean(it.thumbUrl) && !prev.thumbUrl;
    const gainsTracks = Boolean(it.trackIds?.length) && !prev.trackIds?.length;
    const previousStoryIds = normalizeStoryIds(prev.storyIds);
    const mergedStoryIds = mergeStoryIds(previousStoryIds, it.storyIds);
    const storyOrderChanged =
      mergedStoryIds.length !== previousStoryIds.length ||
      mergedStoryIds.some((id, index) => id !== previousStoryIds[index]);
    let enriched = prev;
    let enrichedChanged = false;
    const accept = (candidate: MediaItem): boolean => {
      if (mediaItemWeight(candidate) > MAX_MEDIA_ITEM_BYTES) return false;
      enriched = candidate;
      enrichedChanged = true;
      return true;
    };

    if (storyOrderChanged) {
      const candidate = { ...enriched };
      if (mergedStoryIds.length > 0) candidate.storyIds = mergedStoryIds;
      else delete candidate.storyIds;
      accept(candidate);
    }
    if (gainsAudio && it.audioUrl != null) {
      accept({ ...enriched, audioUrl: it.audioUrl, dash: true });
    }
    if (gainsTracks && it.trackIds != null) {
      // Keep the longest useful prefix that fits. Serialized weight grows
      // monotonically with this string prefix, so binary search bounds hostile
      // batches to O(log MAX_TRACK_IDS) full-size serializations per item.
      const base = enriched;
      let low = 1;
      let high = it.trackIds.length;
      let best: MediaItem | null = null;
      while (low <= high) {
        const count = Math.floor((low + high) / 2);
        const candidate = { ...base, trackIds: it.trackIds.slice(0, count) };
        if (mediaItemWeight(candidate) <= MAX_MEDIA_ITEM_BYTES) {
          best = candidate;
          low = count + 1;
        } else {
          high = count - 1;
        }
      }
      if (best != null) accept(best);
    }
    if (gainsThumb && it.thumbUrl != null) {
      accept({ ...enriched, thumbUrl: it.thumbUrl });
    }
    if (prev.kind === 'image' && it.kind === 'image') {
      const previousArea = imagePixelArea(prev);
      const incomingArea = imagePixelArea(it);
      const promotesVariant =
        incomingArea > previousArea ||
        (incomingArea > 0 &&
          incomingArea === previousArea &&
          it.width === prev.width &&
          it.height === prev.height &&
          it.url !== prev.url);
      if (promotesVariant) {
        // Identity and capture provenance stay with the first observation. Only
        // the concrete rendition changes, so an equal-size URL also refreshes
        // an expiring Facebook signature without ever accepting a lower size.
        accept({
          ...enriched,
          url: it.url,
          width: it.width,
          height: it.height,
        });
      } else if (it.url === prev.url) {
        // A later observer can learn one missing dimension for the exact same
        // URL even when it still cannot prove a complete pixel area.
        const candidate = { ...enriched };
        let gainsDimension = false;
        if (candidate.width == null && it.width != null) {
          candidate.width = it.width;
          gainsDimension = true;
        }
        if (candidate.height == null && it.height != null) {
          candidate.height = it.height;
          gainsDimension = true;
        }
        if (gainsDimension) accept(candidate);
      }
    }
    if (enrichedChanged) {
      byId.set(it.id, enriched);
      changed = true;
    }
  };
  // Persisted rows may legitimately be older than the renderer transit window,
  // but still cannot claim a future/negative/extreme date. New captures get the
  // tighter freshness bound even when a caller bypasses sanitizeIncomingItems.
  for (const raw of existing) insert(raw, true, false);
  for (const raw of incoming) insert(raw, false, true);
  return [Array.from(byId.values()), changed];
}
