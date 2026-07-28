// FaceScrap page hook (MAIN world).
// Runs in the page's own JS context so it can read the responses of the
// GraphQL calls Facebook already makes. We NEVER re-issue queries with a
// hardcoded doc_id (Meta rotates those every 2-4 weeks) — we only passively
// read what the client fetches, plus embedded JSON in the initial document.

import {
  fbAssetKeys,
  isFbcdn,
  makeItem,
  MAX_ITEMS_PER_MESSAGE,
  mediaSourceFromLocation,
  trackKey,
  type MediaItem,
  type MediaSource,
} from '../shared/media';
import {
  decodeMpd,
  extractPrefetchPairs,
  extractStringsByKey,
  extractUrlsByKey,
  fromMpdXml,
  fromPrefetchReps,
  MPD_STRING_KEYS,
  VIDEO_KEYS,
  type DashPair,
} from '../shared/dash';
import { diagBump, diagDrain, setDiagEnabled } from '../shared/diag';
import {
  diagLog,
  diagLogDrain,
  diagLogEnabled,
  errorText,
  redactUrl,
  setDiagContext,
  setDiagLogEnabled,
} from '../shared/diag-log';
import { graphqlImageCandidate, graphqlVideoUrl } from '../shared/graphql-media';
import { storyDomIdForGraphqlChild, storyDomIdFromGraphqlNode } from '../shared/story-mark';
import {
  createBoundedCollector,
  createTextBudget,
  readClonedResponseTextLimited,
  trimQueueToBudget,
  type BoundedCollector,
} from '../shared/page-hook-limits';
import { HOOK_ALIVE_ATTR } from '../shared/hook-attr';

// --- Idempotency: is a hook already alive in this document? ---
// page-hook.js can run twice in one document: manifest.json's declarative MAIN-world
// entry, and content.ts's runtime <script> fallback if it believes no hook survived an
// update (see content-recovery.ts). Each run is a fresh module evaluation with its own
// state, so only the DOM — the one thing this world shares with the ISOLATED-world
// content scripts — can answer "is a hook alive" synchronously, with no listener race.
const alreadyHooked = document.documentElement.hasAttribute(HOOK_ALIVE_ATTR);
if (!alreadyHooked) document.documentElement.setAttribute(HOOK_ALIVE_ATTR, '1');

// --- Diagnostics control channel (see diag.ts) ---
// This world has no chrome.*, so the flag has to be handed over by the content
// script. Ask for it rather than waiting to be told: the hook is injected as a
// separate <script> and either side can win the load race, and delaying the
// fetch/XHR patches below to await an answer would miss early traffic — the one
// cost never worth paying.
setDiagContext('hook');
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data as { __vpCtl?: boolean; diag?: unknown } | null;
  if (d && d.__vpCtl === true && typeof d.diag === 'boolean') {
    setDiagEnabled(d.diag);
    // One user-facing switch drives both: a counter tells you how often a path
    // was taken, the trace tells you which response took it. Split flags would
    // make "diagnostics on" mean two different things in two contexts.
    setDiagLogEnabled(d.diag);
    if (d.diag) diagLog('hookReady', { url: redactUrl(location.href), alreadyHooked });
  }
});
window.postMessage({ __vpCtl: true, query: true }, '*');

/** Hand this world's counts and trace to the content script, which owns chrome.storage. */
function flushDiag(): void {
  const counters = diagDrain();
  const events = diagLogDrain();
  if (Object.keys(counters).length === 0 && events.length === 0) return;
  window.postMessage({ __vpData: true, diag: counters, log: events }, '*');
}

// The scan drain (drainScans) is this world's natural flush point, but an event
// can be recorded when no scan is queued at all — a page error, a navigation.
// Without a timer of its own such an event would sit in the ring until the next
// GraphQL response happened to arrive, which on an idle reel page is never.
let diagFlushTimer: number | undefined;
function scheduleDiagFlush(): void {
  if (!diagLogEnabled() || diagFlushTimer !== undefined) return;
  diagFlushTimer = window.setTimeout(() => {
    diagFlushTimer = undefined;
    flushDiag();
  }, 2_000);
}

// Facebook's own uncaught errors and rejections, observed passively — never
// preventDefault()ed, never re-thrown, so the page's own handling is unchanged.
// This is the one signal that says "the page broke" rather than "we captured
// nothing", and those two look identical from the panel. Only the message and
// the source file are recorded; a stack would carry page internals.
window.addEventListener('error', (e) => {
  if (!diagLogEnabled()) return;
  diagLog('pageError', { message: errorText(e.message), src: redactUrl(e.filename), line: e.lineno ?? 0 }, 'warn');
  scheduleDiagFlush();
});
window.addEventListener('unhandledrejection', (e) => {
  if (!diagLogEnabled()) return;
  diagLog('pageRejection', { reason: errorText(e.reason) }, 'warn');
  scheduleDiagFlush();
});

function post(items: readonly MediaItem[]): void {
  // The receiver hard-caps each message at MAX_ITEMS_PER_MESSAGE to bound a hostile
  // co-resident script. One real reels-feed response harvests well past that
  // (~1248 items measured), so posting it as a single message would silently drop
  // everything past the cap — typically the DASH ladders of reels nested deepest,
  // i.e. exactly the one being watched. Chunk our own legitimate batch to cap size.
  for (let i = 0; i < items.length; i += MAX_ITEMS_PER_MESSAGE) {
    window.postMessage({ __vpData: true, items: items.slice(i, i + MAX_ITEMS_PER_MESSAGE) }, '*');
  }
}

// Keys under which a video's thumbnail/poster image may sit in the same node.
const THUMB_KEYS = [
  'preferred_thumbnail',
  'image',
  'thumbnailImage',
  'preview_image',
  'thumbnail',
  'poster_image',
  'first_frame_thumbnail',
  'video_thumbnail',
  'thumbnail_image',
  'previewImage',
  'thumbnail_src',
];

/** Find a poster/thumbnail fbcdn image URL within a video node. */
function findThumb(rec: Record<string, unknown>): string | undefined {
  for (const key of THUMB_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && isFbcdn(v)) return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.uri === 'string' && isFbcdn(o.uri)) return o.uri;
      const img = o.image as Record<string, unknown> | undefined;
      if (img && typeof img.uri === 'string' && isFbcdn(img.uri)) return img.uri;
    }
  }
  return undefined;
}

// A video's poster and its DASH manifest often arrive in DIFFERENT GraphQL
// responses, and the raw-text manifest fallback has no structured node to read a
// poster from. Key posters by the STABLE xpv asset id (survives rotating fbcdn
// filenames) so pairs captured without one still get their cover.
const posterByXpv = new Map<string, string>();
// The map lives as long as the Facebook tab; cap it so an hours-long scroll
// session can't grow it unboundedly (FIFO — Map preserves insertion order).
const POSTER_MAX = 400;

function xpvOf(url: string): string | undefined {
  return fbAssetKeys(url).find((k) => k.startsWith('xpv:'));
}

function rememberPoster(videoUrl: string, thumb: string | undefined): void {
  if (!thumb) return;
  const x = xpvOf(videoUrl);
  if (!x || posterByXpv.has(x)) return;
  posterByXpv.set(x, thumb);
  if (posterByXpv.size > POSTER_MAX) {
    posterByXpv.delete(posterByXpv.keys().next().value as string);
  }
}

function tagStory(item: MediaItem, storyId: string | undefined): MediaItem {
  if (storyId != null) item.storyIds = [storyId];
  return item;
}

function pushPair(
  pair: DashPair,
  source: MediaSource,
  out: BoundedCollector<MediaItem>,
  now: number,
  thumb?: string,
  storyId?: string,
): void {
  const item = makeItem(pair.videoUrl, 'video', source, 'graphql', now, true);
  tagStory(item, storyId);
  item.audioUrl = pair.audioUrl;
  const x = xpvOf(pair.videoUrl);
  const poster = thumb ?? (x ? posterByXpv.get(x) : undefined);
  if (poster) item.thumbUrl = poster;
  rememberPoster(pair.videoUrl, poster);
  // Keep the key of every quality so the now-playing filter matches whichever
  // adaptive-bitrate track the player actually streams (see MediaItem.trackIds).
  item.trackIds = pair.trackUrls.map(trackKey);
  if (pair.height != null) item.height = pair.height;
  if (pair.width != null) item.width = pair.width;
  if (pair.durationSec != null) item.durationSec = pair.durationSec;
  out.add(item);
}

// Detect a DASH source on a single object node and emit one linked pair per
// video quality in the ladder (the side panel groups them into one row with a
// quality picker via videoGroupKey/resolutionOf).
function harvestDash(
  rec: Record<string, unknown>,
  source: MediaSource,
  out: BoundedCollector<MediaItem>,
  now: number,
  storyId?: string,
  poster?: string,
): void {
  if ('all_video_dash_prefetch_representations' in rec) {
    for (const pair of fromPrefetchReps(rec.all_video_dash_prefetch_representations)) {
      if (out.full) break;
      pushPair(pair, source, out, now, poster, storyId);
    }
  }
  for (const key of MPD_STRING_KEYS) {
    const val = rec[key];
    if (typeof val === 'string' && val.length > 40) {
      const found = fromMpdXml(decodeMpd(val));
      if (found.length > 0) {
        for (const pair of found) {
          if (out.full) break;
          pushPair(pair, source, out, now, poster, storyId);
        }
        break;
      }
    }
  }
}

// Delegates to the classifier shared with content.ts's currentMediaSource()
// and the service worker's surfaceOf(), so the highlight/stories/reel
// precedence (and its real-path-segment anchoring, not a bare substring
// match) can never drift between the three call sites.
function pageSource(): MediaSource {
  return mediaSourceFromLocation(location.pathname, location.search);
}

const VIDEO_KEY_SET: ReadonlySet<string> = new Set(VIDEO_KEYS);

// Recursively collect media URLs from a parsed GraphQL/JSON object.
// The depth cap only guards against pathological payloads (parsed JSON has no
// cycles); it must comfortably exceed Facebook's feed nesting, where a home-feed
// video node sits ~13-19 levels deep (arrays count too).
function harvest(
  obj: unknown,
  source: MediaSource,
  out: BoundedCollector<MediaItem>,
  now: number,
  depth = 0,
  inheritedStoryId?: string,
  inheritedThumb?: string,
): void {
  if (!obj || out.full) return;
  if (depth > 48) {
    diagBump('harvestDepthExceeded');
    return;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) {
      if (out.full) break;
      harvest(v, source, out, now, depth + 1, inheritedStoryId, inheritedThumb);
    }
    return;
  }
  if (typeof obj !== 'object') return;

  const rec = obj as Record<string, unknown>;
  // The rendered Story card and its GraphQL node expose the same opaque `Uz...`
  // id. Carry it only through this node's descendants so media from prefetched
  // neighbouring cards remains distinguishable even when request timing is not.
  const directStoryId = storyDomIdFromGraphqlNode(rec);
  const storyId = directStoryId ?? inheritedStoryId;
  // A poster carries DOWN the same way a story id does. The Stories viewer keeps
  // the cover on the attachment's `media` node but the DASH ladder on a CHILD of
  // it, so asking only the node that emits the pair finds nothing — the reason
  // story videos rendered as blank cards. Nearest ancestor wins, so a real
  // per-attachment poster still beats a story-card-level one, and the scoping
  // is the recursion's own: a sibling attachment never sees this one's cover.
  const thumb = findThumb(rec) ?? inheritedThumb;
  harvestDash(rec, source, out, now, storyId, thumb);

  for (const [k, v] of Object.entries(rec)) {
    if (out.full) break;
    const videoUrl = VIDEO_KEY_SET.has(k) ? graphqlVideoUrl(v) : undefined;
    if (videoUrl != null) {
      const item = tagStory(makeItem(videoUrl, 'video', source, 'graphql', now), storyId);
      const th = thumb ?? (xpvOf(videoUrl) ? posterByXpv.get(xpvOf(videoUrl)!) : undefined);
      if (th) item.thumbUrl = th;
      rememberPoster(videoUrl, th);
      out.add(item);
    } else if (k === 'audio_url' && typeof v === 'string' && isFbcdn(v)) {
      out.add(makeItem(v, 'audio', source, 'graphql', now, true));
    }
    if (v && typeof v === 'object') {
      const childStoryId = storyDomIdForGraphqlChild(directStoryId, inheritedStoryId, k);
      // Image node shape: { uri, width, height }. This branch is promiscuous —
      // it fires on EVERY image node in EVERY response — so it carries two
      // noise gates the deliberate capture paths don't: profile-picture crops
      // (path type `tXX.Y-1`) are UI chrome — the stories tray's Create-story
      // tile ships the viewer's own face this way, which the panel then showed
      // as "a story from my profile" that was never posted — and sub-200px
      // renditions are avatars and tray previews of stories never opened (the
      // DOM scan applies the same 200px floor). Video posters are unaffected:
      // they ride THUMB_KEYS, not this branch.
      // Skip this promiscuous branch when the node was already consumed as a
      // video url wrapper: graphqlVideoUrl matched its {uri|url|src|base_url}, so
      // re-deriving it here only yields the same id (deduped away) — wasted work.
      const image = videoUrl == null ? graphqlImageCandidate(v, childStoryId != null) : null;
      if (image != null) {
        const item = tagStory(makeItem(image.url, 'image', source, 'graphql', now), storyId);
        if (image.width != null) item.width = image.width;
        if (image.height != null) item.height = image.height;
        out.add(item);
      }
      harvest(
        v,
        source,
        out,
        now,
        depth + 1,
        childStoryId,
        thumb,
      );
    }
  }
}

/**
 * Wrap a collector so an item id already added THIS scan is never re-added by
 * a later pass. The regex/manifest raw-text fallbacks below and the
 * structured JSON walk independently rediscover the SAME VIDEO_KEYS urls and
 * MPD ladders whenever a line parses cleanly; BoundedCollector itself has no
 * dedupe (mergeMedia's id dedupe only runs downstream, after this scan's cap
 * has already been spent), so two passes finding the same id used to consume
 * two slots of it instead of one. processScan runs the structured pass FIRST
 * so its richer item (poster, story id) is the one kept; the raw-text passes
 * then only ever add an id the structured walk could not reach.
 */
function dedupeCollector(out: BoundedCollector<MediaItem>): BoundedCollector<MediaItem> {
  const seen = new Set<string>();
  return {
    get items() {
      return out.items;
    },
    get weight() {
      return out.weight;
    },
    get full() {
      return out.full;
    },
    add(item: MediaItem): boolean {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return out.add(item);
    },
  };
}

// Facebook's MSE player appends its buffers on this same thread, so a body of up to
// MAX_BODY_BYTES must not be parsed in one go — the drain below only ever chopped BETWEEN
// jobs. Yield between small batches inside every loop, the way scanDocument already does
// for its script sweep, and let drainScans await the result.
const SCAN_YIELD_EVERY = 64;
const yieldToPlayer = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function processScan(text: string, source: MediaSource, label?: string): Promise<void> {
  // Callers pre-gate on fbcdn in scanText(), so text here already contains media candidates.
  // 2,500 leaves ample room above the measured ~1,248-item reels feed while
  // preventing a hostile/changed response from growing work and postMessage
  // payloads without bound. Aggregate weight catches fewer but giant items.
  const out = dedupeCollector(
    createBoundedCollector<MediaItem>({
      maxItems: 2_500,
      maxWeight: 16 * 1024 * 1024,
      weightOf: (item) => JSON.stringify(item).length,
    }),
  );
  const now = Date.now();

  // Structured parse FIRST — GraphQL streams one JSON object per line, and it is
  // the richest source (poster, story id). Skip a pathologically large single
  // line (>16 MB): JSON.parse + harvest on it would stall the main thread against
  // the MSE player's buffer appends, and the regex passes below still recover its
  // named video URLs and MPD strings. The prefetch ladder is a structured array,
  // so recover just that bounded slice below instead of parsing the whole
  // oversized line.
  const MAX_JSON_LINE = 16 * 1024 * 1024;
  let sinceYield = 0;
  for (const line of text.split('\n')) {
    if (++sinceYield >= SCAN_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToPlayer();
    }
    if (out.full) break;
    const s = line.trim();
    if (s.length < 2 || s[0] !== '{') continue;
    if (s.length > MAX_JSON_LINE) {
      diagBump('jsonLineTooLarge');
      for (const pair of extractPrefetchPairs(s)) {
        if (out.full) break;
        pushPair(pair, source, out, now);
      }
      continue;
    }
    try {
      harvest(JSON.parse(s), source, out, now);
    } catch {
      diagBump('jsonLineParseError'); /* partial/non-JSON line */
    }
  }

  // Regex fallback — robust to GraphQL shape changes, and to a video url the
  // structured pass above could not reach. dedupeCollector drops any id it
  // already added above, so this only ever contributes a genuinely new one.
  for (const url of extractUrlsByKey(text)) {
    if (++sinceYield >= SCAN_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToPlayer();
    }
    if (out.full) break;
    out.add(makeItem(url, 'video', source, 'graphql', now));
  }

  // Manifest fallback — the full DASH ladder (every resolution + audio) ships as an
  // escaped MPD string under videoDeliveryResponseResult.dash_manifests[].manifest_xml,
  // sometimes framed so the per-line parser can't split it or nested past the
  // recursion guard; pull it straight from the raw text.
  const seenMpd = new Set<string>();
  for (const raw of extractStringsByKey(text)) {
    if (++sinceYield >= SCAN_YIELD_EVERY) {
      sinceYield = 0;
      await yieldToPlayer();
    }
    if (out.full) break;
    const xml = decodeMpd(raw);
    // Dedupe signature must span more than the head: MPD headers are mostly
    // fixed boilerplate, and two same-duration videos would collide (dropping
    // one ladder). Length + head + tail (per-video BaseURLs) is collision-safe.
    const sig = `${xml.length}:${xml.slice(0, 120)}:${xml.slice(-120)}`;
    if (seenMpd.has(sig)) continue;
    seenMpd.add(sig);
    for (const pair of fromMpdXml(xml)) {
      if (out.full) break;
      pushPair(pair, source, out, now);
    }
  }

  if (out.full) diagBump('scanOutputCapped');
  diagBump('captureGraphql', out.items.length);
  // The single most useful line in the whole trace: it ties ONE Facebook response
  // to what came out of it. "captureGraphql: 0" says the parsers found nothing;
  // this says WHICH query returned nothing, which is what a shape change looks
  // like from the outside. `videos` counts the linked DASH pairs specifically —
  // an item count that is all images is a different failure from an empty one.
  if (diagLogEnabled()) {
    let videos = 0;
    let withAudio = 0;
    for (const item of out.items) {
      if (item.kind !== 'video') continue;
      videos += 1;
      if (item.audioUrl != null) withAudio += 1;
    }
    diagLog('graphql', {
      q: label ?? 'unknown',
      bytes: text.length,
      items: out.items.length,
      videos,
      withAudio,
      capped: out.full,
      source,
    });
  }
  post(out.items);
}

// The hook shares the main thread with Facebook's MSE video player; parsing a
// multi-MB GraphQL response synchronously starves its buffer appends. Queue each
// response and process one per macrotask, preferring the oldest disposable entries
// during bursts. `source` is captured at REQUEST-ISSUE time (see the fetch/XHR
// patches below) and carried unchanged through to this queue entry, so neither an
// SPA navigation while the request is still in flight nor one before drain can
// relabel a response onto the wrong surface. Document scans (`keep`) are the
// primary capture path for standalone reel/watch pages, but are still subject to
// the same hard aggregate caps.
interface ScanJob {
  text: string;
  source: MediaSource;
  keep?: boolean;
  /** What produced this body — a GraphQL query name, or `document`. Diagnostics
   *  only: nothing in the capture path branches on it. */
  label?: string;
}
const scanQueue: ScanJob[] = [];
// Hard per-body/per-job cap. It is enforced while fetch clones stream and again
// at enqueue so XHR and document scans cannot bypass it.
const MAX_BODY_BYTES = 24 * 1024 * 1024;
// Bound the queue by BOTH entry count and total retained bytes: a handful of
// multi-MB feed bodies matters far more than many tiny ones. trimQueueToBudget
// re-weighs the whole queue on every enqueue and sheds from it, so a scroll burst
// can't pin tens of MB of response text waiting to drain.
const SCAN_QUEUE_MAX = 8;
const SCAN_QUEUE_MAX_BYTES = MAX_BODY_BYTES;
let draining = false;
function scanText(text: string, source: MediaSource, keep = false, label?: string): void {
  if (!text || text.length < 20) return;
  if (text.length > MAX_BODY_BYTES) {
    diagBump('graphqlBodyTooLarge');
    diagLog('graphqlDropped', { q: label ?? 'unknown', bytes: text.length, why: 'bodyTooLarge' }, 'warn');
    return;
  }
  // Pre-gate at ENQUEUE: every parser needs isFbcdn on each URL, so a body with no
  // fbcdn host yields nothing, and media-less GraphQL (typing/presence/notifs) never
  // takes a queue slot or schedules a drain. Escaped JSON keeps the bare `fbcdn.net`
  // host intact, so this never hides media behind an unlisted key.
  if (!text.includes('fbcdn.net')) return;
  scanQueue.push({ text, source, keep, label });
  // Prefer dropping disposable traffic, but a burst made only of document
  // (`keep`) jobs is still bounded. No job, including the newly queued one, is
  // exempt from the aggregate cap.
  const droppedJobs = trimQueueToBudget({
    queue: scanQueue,
    maxItems: SCAN_QUEUE_MAX,
    maxWeight: SCAN_QUEUE_MAX_BYTES,
    weightOf: (job) => job.text.length,
    isDisposable: (job) => !job.keep,
  });
  for (const dropped of droppedJobs) {
    // A whole response, not one item: every ladder it carried is gone.
    diagBump('scanQueueEvicted');
    diagLog('graphqlDropped', { q: dropped.label ?? 'unknown', bytes: dropped.text.length, why: 'queueEvicted' }, 'warn');
  }
  if (!draining) {
    draining = true;
    setTimeout(drainScans, 0);
  }
}
async function drainScans(): Promise<void> {
  const job = scanQueue.shift();
  if (job === undefined) {
    draining = false;
    return;
  }
  try {
    await processScan(job.text, job.source, job.label);
  } catch (error) {
    // Was a bare `/* ignore */`. Still ignored — a parser fault must never
    // propagate into Facebook's own promise chains — but no longer invisible:
    // this catch swallowing a TypeError from a shape change is precisely the
    // failure the panel reports as "nothing captured".
    diagLog('scanFailed', { q: job.label ?? 'unknown', error: errorText(error) }, 'error');
  }
  job.text = ''; // release the body for GC before the next macrotask runs
  // Macrotask boundary: a natural flush point that needs no timer of its own.
  flushDiag();
  if (scanQueue.length) setTimeout(drainScans, 0);
  else draining = false;
}

/** The name Facebook gives the query it is issuing, read from the request body
 *  it already built. Diagnostics only, and only while they are on.
 *
 *  Reads `init.body` exclusively — never a Request object's body, which is a
 *  one-shot stream this hook must not consume (that would break the very request
 *  it is observing). Passive by construction: it reads what the page is already
 *  sending and never adds, alters or re-issues a query, so ARCHITECTURE.md's
 *  passive-hook invariant holds unchanged. */
function friendlyName(init: unknown): string | undefined {
  if (!diagLogEnabled()) return undefined;
  try {
    const body = (init as RequestInit | undefined)?.body;
    const text =
      typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : undefined;
    if (text == null) return undefined;
    return /fb_api_req_friendly_name=([A-Za-z0-9_]{1,64})/.exec(text)?.[1];
  } catch {
    return undefined;
  }
}

// --- Patch fetch ---
const origFetch = window.fetch;
window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
  const p = origFetch.apply(this as typeof globalThis, args);
  // A redundant second installation in this document (see alreadyHooked
  // above) must not attach a second scan chain to the same response — that
  // is the "wrapping page APIs a second time" failure this guard exists to
  // make impossible, not merely unlikely. The still-live original wrapper —
  // `origFetch`, from this instance's own point of view — already does the
  // real work, so this instance becomes a transparent passthrough.
  if (alreadyHooked) return p;
  try {
    const input = args[0];
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url && url.includes('/api/graphql')) {
      // Capture the surface HERE, at request-ISSUE time: a pushState navigation
      // (see notifyNav below) can land while the response is still in flight, and
      // a response belongs to whichever page issued it, not whichever page
      // happens to be showing once its body finishes streaming.
      const source = pageSource();
      const label = friendlyName(args[1]);
      p.then(async (res) => {
        // A GraphQL call Facebook itself made coming back 4xx/5xx explains an
        // empty panel outright, and is invisible from every counter: nothing was
        // discarded because nothing arrived.
        if (!res.ok) diagLog('graphqlHttp', { q: label ?? 'unknown', status: res.status }, 'warn');
        const result = await readClonedResponseTextLimited(res, MAX_BODY_BYTES);
        if (!result.ok) {
          diagBump('graphqlBodyTooLarge');
          diagLog('graphqlDropped', { q: label ?? 'unknown', why: 'bodyTooLarge' }, 'warn');
          return '';
        }
        return result.text;
      })
        .then((text) => scanText(text, source, false, label))
        .catch((error) => {
          // The request itself failed, or its body could not be read. Facebook's
          // own copy of this promise is untouched — this is our clone's chain.
          diagLog('graphqlFailed', { q: label ?? 'unknown', error: errorText(error) }, 'warn');
        });
    }
  } catch {
    /* ignore */
  }
  return p;
} as typeof fetch;

// --- Patch XHR ---
const origOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, _method: string, url: string | URL) {
  // Same guard as the fetch patch above: a redundant second installation
  // must not tag the instance or attach a second load listener — it must be
  // a transparent passthrough to the still-live original wrapper.
  if (alreadyHooked) {
    // eslint-disable-next-line prefer-rest-params
    return origOpen.apply(this, arguments as unknown as Parameters<typeof origOpen>);
  }
  const self = this as XMLHttpRequest & {
    __vpUrl?: string;
    __vpSource?: MediaSource;
    __vpHooked?: boolean;
  };
  self.__vpUrl = String(url); // refresh the URL on every open()...
  // ...and the surface, captured HERE at request-ISSUE time (see the fetch patch
  // above for why response-arrival time is the wrong moment to read it).
  self.__vpSource = pageSource();
  if (!self.__vpHooked) {
    // ...but attach the load listener only ONCE per instance. If Facebook reuses a
    // long-lived XHR (open() called again), a per-open listener would stack and
    // re-scan/enqueue the same multi-MB body once per prior open(). The listener
    // itself reads __vpUrl/__vpSource at fire time, so it always
    // reflects whichever open() call was most recent.
    self.__vpHooked = true;
    this.addEventListener(
      'load',
      function (this: XMLHttpRequest & { __vpUrl?: string; __vpSource?: MediaSource }) {
        try {
          if (this.__vpUrl?.includes('/api/graphql') && typeof this.responseText === 'string') {
            // No query name here: XHR carries it in send()'s body, and this hook
            // patches open() only — wrapping send() as well would mean touching
            // one more page API for a diagnostics label.
            scanText(this.responseText, this.__vpSource ?? 'video', false, 'xhr');
          }
        } catch {
          /* ignore */
        }
      },
    );
  }
  // eslint-disable-next-line prefer-rest-params
  return origOpen.apply(this, arguments as unknown as Parameters<typeof origOpen>);
} as typeof XMLHttpRequest.prototype.open;

// --- Tell the content script when the SPA navigates ---
// Facebook advances feed → /reel/<id> with pushState, which fires no popstate
// and no main_frame request (the service worker's own comment notes this). The
// content script had no navigation signal at all: it waited for its 300ms
// poller or a media event, and a slide transition detected late restamps
// slideAt, which is what the anchoring window in now-playing.ts measures
// against. Patching history has to happen HERE — an isolated content script
// sees its own History object, not the page's.
//
// This does NOT change how the id is resolved: reelVideoId (data-video-id)
// still outranks the URL, which lags the scroll. It only makes the content
// script look sooner.
// Everything below is installation work only the FIRST hook instance may do.
// The fetch/XHR patches above check alreadyHooked inside their own bodies, so a
// redundant chain is merely wasteful; these are not idempotent — a wrapped
// pushState calls notifyNav() on every real call, and scanDocument's WeakSet is
// per-evaluation, so a second instance would re-walk every <script> in the
// document on the main thread this file works to protect.
//
// Guarded as ONE block rather than per-effect: a new effect added later would
// otherwise need to remember its own check. The DOM stamp and the diag channel
// above stay outside it — the stamp IS the alreadyHooked test, and the diag flag
// is per-instance state nothing below reads once this block is skipped.
if (!alreadyHooked) {
  function notifyNav(): void {
    try {
      diagLog('nav', { url: redactUrl(location.href) });
      scheduleDiagFlush();
      window.postMessage({ __vpData: true, nav: true }, '*');
    } catch {
      /* ignore */
    }
  }
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name];
    history[name] = function (this: History, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args);
      notifyNav();
      return result;
    } as typeof original;
  }
  // pushState/replaceState do not fire popstate; back/forward do not call them.
  window.addEventListener('popstate', notifyNav);

  // --- Scan embedded JSON in the initial document (reel/watch standalone pages). ---
  // Facebook ships the media (DASH ladders, playable_urls) inside <script> JSON blobs,
  // NOT the rendered markup; scanning only fbcdn-mentioning script contents (rather
  // than the whole outerHTML) avoids retaining megabytes of DOM/CSS/SVG. Rendered
  // <img>/<video> covers are captured by the content script's DOM scan.
  //
  // Persisted across scanDocument's three calls (module eval, load, load+2500ms)
  // so a <script> node already inspected is never re-collected into processScan's
  // regex+JSON passes a second or third time. Those three calls exist because
  // Facebook keeps inserting NEW scripts as the SPA renders — not to re-scan the
  // SAME multi-MB text repeatedly on the main thread. Node identity is enough to
  // recognize "already scanned": these tags carry a static embedded payload
  // written once at insertion, never mutated in place.
  const scannedScripts = new WeakSet<Element>();

  let documentScanRunning = false;
  async function scanDocument(): Promise<void> {
    if (documentScanRunning) return;
    documentScanRunning = true;
    try {
      const budget = createTextBudget(MAX_BODY_BYTES);
      const scripts = document.querySelectorAll('script');
      for (let i = 0; i < scripts.length; i += 1) {
        const node = scripts[i];
        if (!scannedScripts.has(node)) {
          const c = node.textContent;
          if (c && c.length > 40 && c.includes('fbcdn.net')) {
            if (!budget.add(c, '\n')) {
              diagBump('documentScanCapped');
              break; // cap hit: leave `node` unmarked so a fresh-budget pass can retry it
            }
          }
          scannedScripts.add(node);
        }
        // Large initial documents can contain thousands of script tags. Yield
        // between small batches so the Facebook player can append MSE buffers.
        if (i > 0 && i % 32 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      const text = budget.value();
      if (text) scanText(text, pageSource(), true, 'document');
    } catch (error) {
      diagLog('documentScanFailed', { error: errorText(error) }, 'error');
    } finally {
      documentScanRunning = false;
    }
  }
  void scanDocument();
  window.addEventListener('load', () => {
    void scanDocument();
    window.setTimeout(() => void scanDocument(), 2500);
  });
} // end: installation work gated to the first hook instance in this document
// Counts bumped after the last drain would otherwise die with the page.
window.addEventListener('pagehide', flushDiag);
