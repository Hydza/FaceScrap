// Shared media model + pure helpers (no chrome.* here — this file is also
// bundled into the MAIN-world page hook, which has no extension APIs).

import { isStoryDomId } from './story-mark';

export { isNumericMediaId, NUMERIC_MEDIA_ID_RE, NUMERIC_MEDIA_ID_SOURCE } from './media-id';

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
 * The fbcdn media URL inside a CSS `background-image` value, if it holds one.
 * Facebook paints some photo stories as a <div> background rather than an <img>, so
 * the centre detector and the in-page button both have to read one, with the same
 * two guards: fbcdn-hosted, and not an rsrc.php sprite — those are fbcdn too, and a
 * big one would pass for the photo. Takes the already-computed style string rather
 * than an element: how each side reaches getComputedStyle is the only part that
 * legitimately differs (one uses its own window, the other takes one by injection so
 * it can be driven without a browser), and this file must stay usable from the
 * worker, which has no DOM at all.
 */
export function fbcdnBackgroundUrl(backgroundImage: string | undefined): string | undefined {
  if (!backgroundImage || backgroundImage === 'none') return undefined;
  const m = backgroundImage.match(/url\(["']?(https?:[^"')]+)["']?\)/);
  if (!m || !isFbcdn(m[1]) || isStaticFbAsset(m[1])) return undefined;
  return m[1];
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

/** Minimum natural pixel width/height for a DOM- or GraphQL-observed image to
 *  count as real content rather than an avatar/UI thumbnail/tray preview. */
export const MIN_MEDIA_DIMENSION_PX = 200;

/** DASH byte-range segment query params. widenDashUrl strips them to recover the
 *  full-track URL; classifyNetworkRequest's isDash check and service-worker.ts's
 *  DASH_BYTE_RANGE_RE both derive from this pair so they cannot drift apart. */
const DASH_BYTE_RANGE_PARAMS = ['bytestart', 'byteend'] as const;
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

// Match highlight as a complete path segment, with singular and plural forms.
const HIGHLIGHT_SEGMENT_RE = /(?:^|\/)highlights?(?:\/|$)/i;

// Profile highlights use a story path and identify the surface through `source`.
// Match complete underscore-delimited tokens only.
const HIGHLIGHT_SOURCE_PARAM_RE = /(?:^|_)highlights?(?:_|$)/i;

function isHighlightQuery(search: string): boolean {
  const source = new URLSearchParams(search).get('source');
  return source != null && HIGHLIGHT_SOURCE_PARAM_RE.test(source);
}

/** Classify a Facebook location for every capture path. The required search string
 *  ensures profile-highlight query signals participate in the shared precedence. */
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
/** Match known media filenames whose path uniquely identifies the fbcdn object.
 *  Other paths use genericEndpointId's semantic keying. */
const KNOWN_MEDIA_EXTENSION_RE = new RegExp(
  `\\.(?:${IMAGE_EXTENSIONS}|${AUDIO_EXTENSIONS}|${VIDEO_EXTENSIONS})$`,
  'i',
);

/** "audio" as a whole token in an efg `vencode_tag`. Anchored on the separators Facebook
 *  uses so a video tag — which carries a resolution, never this word — cannot match. */
const AUDIO_ENCODE_TAG_RE = /(?:^|[._-])audio(?:$|[._-])/i;

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
        } else if (typeof efg.vencode_tag === 'string' && AUDIO_ENCODE_TAG_RE.test(efg.vencode_tag)) {
          // Facebook names each DASH track's encode here, and the audio ones say so
          // ("dash.audio", "dash_ln_heaac_vbr3_audio") while the video ones carry a
          // resolution instead ("dash.720.video") — resolutionOf reads the same field for
          // exactly that. It is the only audio evidence left in a representation whose
          // mime_type claims video/mp4, so it overrides that claim: everything downstream
          // treats kind as authority for whether a URL is a video the user can download.
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

/** Per-kind fallback when the URL has no recognized extension or cannot be parsed. */
const DEFAULT_EXTENSION: Record<MediaKind, string> = { image: 'jpg', audio: 'm4a', video: 'mp4' };
const KIND_EXTENSION_RE: Record<MediaKind, RegExp> = {
  image: IMAGE_EXTENSION_RE,
  audio: AUDIO_EXTENSION_RE,
  video: VIDEO_EXTENSION_RE,
};

/** Choose a lowercase download extension recognized for the item's kind. Use the
 *  per-kind fallback for missing, conflicting or unparseable URL extensions. */
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

// PlayingRef transport and Saved receipts share this id bound. Candidate paths and
// efg fields are untrusted, so every mediaId is bounded once at the public exit.
export const MEDIA_ID_MAX_LEN = 256;

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
 * the same bounded id regardless of whether the path, discriminator or query
 * overflows.
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
      // Canonicalize nested fbcdn resources recursively so rotating signatures do
      // not affect identity. Keep the inner candidate unbounded to preserve stable
      // hash input; mediaId bounds the final result. Each decoded URL is shorter,
      // which guarantees termination.
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
    // Simple GraphQL shapes and persisted rows use a path-derived `video-*` id.
    // Derive that canonical spelling instead of trusting a supplied field.
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

// Bound the complete candidate at the shared exit so every current and future
// branch obeys the id contract.
export function mediaId(url: string): string {
  return boundMediaId(mediaIdCandidate(url));
}

/**
 * Read persisted path-only aliases. Generic endpoints may serve several resources,
 * so consumers accept an alias only when it maps to one current item.
 */
export function historicalMediaIds(url: string): string[] {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/o\d+\/(?=v\/)/, '/');
    const pathOnly = `asset:${path}`;
    const current = mediaId(url);
    // Path-only aliases apply only to the asset scheme, preserving round-trip
    // consistency with canonicalizeHistoricalMediaId.
    if (!current.startsWith('asset:')) return [];
    return pathOnly === current ? [] : [pathOnly];
  } catch {
    return [];
  }
}

/** Canonicalize a persisted full-query `asset:` id. */
export function canonicalizeHistoricalMediaId(id: string): string | undefined {
  if (!id.startsWith('asset:/')) return undefined;
  const resource = id.slice('asset:'.length);
  try {
    return mediaId(`https://identity.invalid.fbcdn.net${resource}`);
  } catch {
    return undefined;
  }
}

/** Read/display alias for persisted session rows and Saved receipts. New writes
 *  use mediaId(). Bound the result through the same helper as mediaId(). */
export function legacyMediaId(url: string): string | undefined {
  try {
    const pathname = new URL(url).pathname;
    const numeric = pathname.match(/(\d{8,})/);
    return boundMediaId(numeric ? `fb:${numeric[1]}` : `path:${pathname}`);
  } catch {
    return undefined;
  }
}

/** Map each path-only alias to its current item ids. Shared endpoints may collide,
 *  so matchesActiveMediaId trusts only uniquely owned aliases. Build once per batch. */
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

/** Expand PlayingRef ids with canonical forms of persisted full-query aliases.
 *  Panel selection, retention and the in-page button share this exact set. */
export function activeMediaIds(ids: readonly string[] | undefined): Set<string> {
  const active = new Set(ids ?? []);
  for (const id of [...active]) {
    const canonical = canonicalizeHistoricalMediaId(id);
    if (canonical != null) active.add(canonical);
  }
  return active;
}

/** Match an item by stored id, current canonical id, numeric fallback or uniquely
 *  owned path alias. Build `owners` from the same candidate batch. */
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

/** Resolution label + rank for an item. Prefers the URL's `tag=..._720p` (progressive), then the
 *  frame's SHORT edge (DASH), then the `efg`'s `vencode_tag`. */
export function resolutionOf(item: Pick<MediaItem, 'url' | 'height' | 'width'>): { label: string; rank: number } {
  const tag = item.url.match(/[?&]tag=[^&]*?(\d{3,4})p/i);
  if (tag) return { label: `${tag[1]}p`, rank: Number(tag[1]) };
  // The SHORT edge, not the height. Every reel and story is portrait — 1080x1920 — and
  // both Facebook's own picker and the "1080p" everyone means by the word name the short
  // one. Labelling by height put "1920p" next to a sibling rung whose label came from the
  // encode tag as "720p", so one menu ranked its options on two different scales.
  // With only a height there is nothing to take the minimum OF, so it stays in
  // charge — a label from one known edge beats no label at all, and the ladder is
  // consistent as soon as the second edge is learned.
  const short =
    item.width != null && item.width > 0 && item.height != null && item.height > 0
      ? Math.min(item.width, item.height)
      : item.height;
  if (short != null && short > 0) return { label: `${short}p`, rank: short };
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

// Storage validates persisted entries against these allowed values.
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

/** The stored-dimension rule: a positive safe integer within MAX_MEDIA_DIMENSION.
 *  Exported for the DOM capture edge (visible-media.ts), which bounds a measured
 *  natural width/height the same way before it builds an item. */
export function normalizeMediaDimension(raw: unknown): number | undefined {
  return typeof raw === 'number' &&
    Number.isSafeInteger(raw) &&
    raw > 0 &&
    raw <= MAX_MEDIA_DIMENSION
    ? raw
    : undefined;
}

/** Verified natural pixel area for an image, or zero when either dimension is unknown. */
function imagePixelArea(item: Pick<MediaItem, 'kind' | 'width' | 'height'>): number {
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

// Reuse one encoder and cache serialized weights by immutable object identity.
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

/** Per element, like normalizeStoryIds beside it: one malformed entry drops itself,
 *  not the whole list. All-or-nothing let a single oversized id from the page cost
 *  an item every track key the now-playing filter matches on. */
function normalizeTrackIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const track of raw.slice(0, MAX_TRACK_IDS)) {
    if (typeof track === 'string' && track.length <= 512) out.push(track);
  }
  return out;
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

/** Shape-check and copy a MediaItem through the shared ingress and merge contract.
 *  `allowHistorical` applies only to existing persisted rows. */
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
  // Reject overweight inputs before shared normalization and its field copies.
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
    // Compact duplicate persisted rows and mark the normalized shape for storage.
    if (!isIncoming) changed = true;
    // Enrich transactionally: every accepted intermediate shape must remain a
    // valid storable item. Never delete a field already present on `prev` just
    // to make room for new metadata. Strong playback associations win first;
    // lower-priority track/preview metadata is admitted only while it fits.
    const gainsAudio = Boolean(it.audioUrl) && !prev.audioUrl;
    // Thumbnail selection is first-wins because MediaItem has no independent
    // thumbnail-quality signal. Item origin does not describe a later thumbnail.
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
    // Fill missing dimensions without replacing an existing measurement.
    if ((it.height != null && enriched.height == null) || (it.width != null && enriched.width == null)) {
      const candidate = { ...enriched };
      if (it.height != null && candidate.height == null) candidate.height = it.height;
      if (it.width != null && candidate.width == null) candidate.width = it.width;
      accept(candidate);
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
      }
      // No else: an equal-URL observation whose only news is a dimension this row
      // lacks is already absorbed by the generic block above, whose guard is the
      // exact disjunction such a branch would have to re-test.
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
