// Always-on discard counters explain fail-closed capture paths and bounded drops
// without allowing the page hook to affect Facebook.
//
// No chrome.* here: this file is bundled into the MAIN-world page hook too, and
// that context has no extension APIs. Drained counts ride the hook's own message
// channel back out (see content-diag.ts).

export type DiagReason =
  // --- discards: page hook (GraphQL capture) ---
  /** Response body past MAX_BODY_BYTES — the whole GraphQL body is dropped. */
  | 'graphqlBodyTooLarge'
  /** A queued scan was evicted under burst load: one whole response lost. */
  | 'scanQueueEvicted'
  /** JSON line past MAX_JSON_LINE — structured parse skipped for that line. */
  | 'jsonLineTooLarge'
  /** A line failed JSON.parse (partial/non-JSON chunk). */
  | 'jsonLineParseError'
  /** harvest() hit its depth cap and stopped descending. */
  | 'harvestDepthExceeded'
  /** A scan reached its aggregate emitted-item/count budget. */
  | 'scanOutputCapped'
  /** Embedded document scripts exceeded their aggregate text budget. */
  | 'documentScanCapped'
  // --- discards: content-script ingress (page hook -> content script) ---
  /** mediaIngressBudget rejected an already-sanitized batch: the newest
   *  capture for this tick is dropped whole, not queued or retried. */
  | 'mediaIngressRejected'
  // --- discards: DASH parsing ---
  /** Representation dropped: mime/codecs matched neither video nor audio. */
  | 'unknownCodec'
  /** An MPD failed to parse — the whole quality ladder is lost, not one rung. */
  | 'mpdParseError'
  /** DRM-protected AdaptationSet/Representation intentionally skipped. */
  | 'drmSkipped'
  /** Representation dropped: BaseURL missing or not fbcdn. */
  | 'repNoFbcdnBase'
  // --- discards: storage retention ---
  /** Oldest captures spliced off at the per-tab maxItems cap. */
  | 'storageMaxItemsEvicted'
  /** Globally-oldest safe captures dropped after a shared storage quota failure. */
  | 'storageQuotaEvicted'
  // --- refusals: identifying what a tab is playing for the in-page button ---
  // The button offers ONE resolution ladder and downloads without a confirmation,
  // so it refuses wherever the panel's own view would merely render an ambiguity.
  // Each refusal is its own counter because each has a different answer: the four
  // together are the only way to tell "the button is hidden" apart from "the button
  // is hidden BECAUSE …", which is the question a missing button actually raises.
  /** More than one video group is live at once — no single ladder to offer. */
  | 'playingAmbiguous'
  /** No fbcdn track streamed in the match window matched any captured video. */
  | 'playingNoTrackMatch'
  /** A track matched, but its stream is not anchored to this slide, so it is
   *  indistinguishable from fbcdn prefetching the neighbouring reel. */
  | 'playingUnanchored'
  /** This slide's track is in flight with its item not captured yet; picking now
   *  would name the previous slide. */
  | 'playingCaptureWait'
  // --- successes, so the discards above can be read as a ratio ---
  | 'captureGraphql'
  | 'captureDom'
  | 'captureNetwork'
  /** The worker answered the button's query with something downloadable. */
  | 'buttonOffered'
  /** …and answered it with nothing, so the button hid. */
  | 'buttonHidden'
  /** The in-page download button could not reach the worker to ask what the
   *  playing media could be saved as. Counts the query, not the download. */
  | 'overlayQueryFailed';

// A Record, not an array: `Record<DiagReason, true>` makes the COMPILER reject a reason
// the union declares and this list omits. Sanitizers read this list at every boundary,
// so a missing entry silently drops that counter everywhere.
const REASONS: Record<DiagReason, true> = {
  graphqlBodyTooLarge: true,
  scanQueueEvicted: true,
  jsonLineTooLarge: true,
  jsonLineParseError: true,
  harvestDepthExceeded: true,
  scanOutputCapped: true,
  documentScanCapped: true,
  mediaIngressRejected: true,
  unknownCodec: true,
  mpdParseError: true,
  drmSkipped: true,
  repNoFbcdnBase: true,
  storageMaxItemsEvicted: true,
  storageQuotaEvicted: true,
  playingAmbiguous: true,
  playingNoTrackMatch: true,
  playingUnanchored: true,
  playingCaptureWait: true,
  captureGraphql: true,
  captureDom: true,
  captureNetwork: true,
  buttonOffered: true,
  buttonHidden: true,
  overlayQueryFailed: true,
};

export const DIAG_REASONS: readonly DiagReason[] = Object.keys(REASONS) as DiagReason[];

export type DiagCounters = Partial<Record<DiagReason, number>>;

const counters = new Map<DiagReason, number>();

/** What bounds this is the reason whitelist, not a flag: the map holds at most one
 *  entry per DiagReason, so counting for the life of a context costs what counting
 *  for a minute did. Call sites sit inside branches that are already rare (a catch,
 *  a size cap, an unparseable codec) — never in harvest()'s success path, which
 *  walks hundreds of thousands of nodes per reels-feed response. */
export function diagBump(reason: DiagReason, n = 1): void {
  counters.set(reason, (counters.get(reason) ?? 0) + n);
}

export function diagSnapshot(): DiagCounters {
  return Object.fromEntries(counters) as DiagCounters;
}

/** Read and reset — used at the page hook's flush points, so a count is
 *  reported exactly once even though several contexts report independently. */
export function diagDrain(): DiagCounters {
  const out = diagSnapshot();
  counters.clear();
  return out;
}

/** Counters crossing a world boundary are page-supplied data. Re-validate at the
 *  receiver even though the sender built them, same defence-in-depth as
 *  sanitizeIncomingItems in media.ts: a compromised renderer shares a process
 *  with the page hook. The known-reason whitelist also bounds the result size. */
export function sanitizeDiagCounters(raw: unknown): DiagCounters {
  if (!raw || typeof raw !== 'object') return {};
  const out: DiagCounters = {};
  const record = raw as Record<string, unknown>;
  // Read only the fixed whitelist to bound work independently of unknown properties.
  for (const key of DIAG_REASONS) {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue;
    out[key] = value;
  }
  return out;
}

/** Sum one already-sanitized counter map into another, saturating at `max` instead
 *  of overflowing. Two places coalesce on this same path — the content script,
 *  between reports, and the worker's observer, per tab — and they had drifted to
 *  different saturation rules over identical data. Both parameters stay the
 *  caller's on purpose: the BOUND, because the content side only has to stay
 *  countable while the worker's is what actually reaches storage; and the KEYS,
 *  because the worker re-reads the whitelist as defence in depth while the content
 *  side sums what sanitizeDiagCounters already handed it. */
export function addBoundedCounters<K extends string>(
  target: Partial<Record<K, number>>,
  source: Readonly<Partial<Record<K, number>>>,
  keys: readonly K[],
  max: number,
): void {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value <= 0 || !Number.isSafeInteger(value)) continue;
    target[key] = Math.min(max, (target[key] ?? 0) + value);
  }
}

interface CounterCoalescer<K extends string> {
  add(counters: Readonly<Partial<Record<K, number>>>): void;
  drain(): Partial<Record<K, number>>;
}

/** Accumulate sanitized counters between reports. The caller owns scheduling. */
export function createCounterCoalescer<K extends string>(): CounterCoalescer<K> {
  let pending: Partial<Record<K, number>> = {};
  return {
    add(counters) {
      addBoundedCounters(pending, counters, Object.keys(counters) as K[], Number.MAX_SAFE_INTEGER);
    },
    drain() {
      const drained = pending;
      pending = {};
      return drained;
    },
  };
}
