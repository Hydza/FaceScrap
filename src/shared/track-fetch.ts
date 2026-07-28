// Resumable fetch for one DASH track.
//
// Kept out of offscreen.ts (which reaches for chrome.* at module scope, so it
// cannot be imported by a test) precisely so this logic — the part with
// interesting failure modes — can be exercised without a browser.
//
// No chrome.* here.

import { isFbcdn } from './media';

/** fetch() has no read timeout: a socket that connects then stalls mid-body
 *  (edge hiccup, network/VPN switch, silent middlebox) leaves the read pending
 *  forever. Bound the IDLE gap, never total duration — a whole-transfer cap
 *  cannot tell a stall from a large track on a slow-but-steady link, and
 *  aborted legitimate slow downloads. */
export const STALL_MS = 60_000;

/** A dropped connection is worth retrying; an expired URL is not (see below). */
export const ATTEMPTS = 3;
export const RETRY_DELAY_MS = 1_000;

/** Longest a lawfully-retrying track fetch can go without emitting a byte: every
 *  attempt stalls out, plus the backoff between attempts. Exported because the
 *  worker's mux idle window must sit ABOVE it — cut a job off sooner and a track
 *  that was about to exhaust its retries reports a generic timeout instead of its
 *  own specific error. Derived here so the two cannot drift apart. */
export const WORST_CASE_SILENCE_MS = STALL_MS * ATTEMPTS + (RETRY_DELAY_MS * (ATTEMPTS * (ATTEMPTS - 1))) / 2;

// A 500 MB (decimal) video track still fits, as does its audio companion, while
// forged/unbounded responses cannot consume the offscreen document indefinitely.
const MAX_DASH_TRACK_BYTES = 512 * 1024 * 1024;
const MAX_DASH_INPUT_BYTES = 640 * 1024 * 1024;
// The remux is stream-copy only, so it must never be larger than both bounded
// inputs together. Kept distinct so the publish boundary is explicit/auditable.
export const MAX_DASH_OUTPUT_BYTES = MAX_DASH_INPUT_BYTES;

interface FetchTrackOptions {
  /** Injected for tests; defaults to the global. */
  fetch?: typeof globalThis.fetch;
  attempts?: number;
  retryDelayMs?: number;
  stallMs?: number;
  /** Primarily useful for focused tests; production callers use the hard cap. */
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Thrown for an HTTP status the server will keep returning. Retrying an
 *  expired fbcdn URL only delays the message the user actually needs. */
class HardHttpError extends Error {}
class ByteLimitError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Bytes received so far, held as sealed Blobs plus a small unsealed tail.
 *
 *  Sealing matters: a Uint8Array is always resident in the JS heap, while the
 *  browser may back a Blob with disk. Holding every chunk of a 512 MB track as
 *  Uint8Array until the very end made the offscreen document's peak memory the
 *  size of both tracks at once. Sealing every SEAL_BYTES lets everything before
 *  the tail leave the heap, and the sealed list is still discardable in one go
 *  when a resume has to start over. */
interface Buffered {
  sealed: Blob[];
  tail: Uint8Array[];
  tailBytes: number;
  bytes: number;
}

/** How much may sit unsealed in the heap. Small enough to bound the resident set,
 *  large enough that a long track does not accumulate thousands of Blobs. */
const SEAL_BYTES = 16 * 1024 * 1024;

function sealTail(held: Buffered): void {
  if (held.tail.length === 0) return;
  held.sealed.push(new Blob(held.tail as unknown as BlobPart[]));
  held.tail = [];
  held.tailBytes = 0;
}

function discardHeld(held: Buffered, shared: SharedBudget | undefined, onBytes: (total: number) => void): void {
  if (shared) shared.used -= held.bytes;
  held.sealed = [];
  held.tail = [];
  held.tailBytes = 0;
  held.bytes = 0;
  onBytes(0);
}

/** The first byte a 206 actually starts at, or null if it did not say. */
function contentRangeStart(res: Response): number | null {
  const raw = res.headers.get('Content-Range');
  const match = raw === null ? null : /^bytes\s+(\d+)-/i.exec(raw);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

interface SharedBudget {
  used: number;
  readonly limit: number;
}

function contentLength(res: Response): number | null {
  const raw = res.headers.get('Content-Length');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function overflow(kind: 'track' | 'combined', limit: number): ByteLimitError {
  return new ByteLimitError(`DASH ${kind} exceeds the ${limit}-byte safety limit.`);
}

/** One read attempt. Resumes from `held.bytes` when there is anything to resume
 *  from, and appends what it reads to `held`. */
async function readAttempt(
  url: string,
  held: Buffered,
  onBytes: (total: number) => void,
  doFetch: typeof globalThis.fetch,
  stallMs: number,
  maxBytes: number,
  shared: SharedBudget | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const ctrl = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, stallMs);
  };
  const abortFromCaller = (): void => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', abortFromCaller, { once: true });
  try {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    arm();
    const res = await doFetch(url, {
      credentials: 'omit',
      signal: ctrl.signal,
      headers: held.bytes > 0 ? { Range: `bytes=${held.bytes}-` } : undefined,
    });
    if (!res.ok) {
      throw new HardHttpError(
        `Couldn't fetch the track (${res.status}). The fbcdn URL may have expired — reload the Facebook page.`,
      );
    }
    // Reconcile a resumed read with what the server actually sent. The status alone
    // does not settle it: 206 says "this is A range", not "this is THE range you
    // asked for", and a CDN node change or a middlebox can answer with a different
    // offset. Appending that silently produces a file LONGER than the original,
    // which the remuxer's bounds check (offset+size <= blob.size) cannot catch — so
    // it would ship as a successful download of a broken file.
    if (held.bytes > 0) {
      const start = res.status === 206 ? contentRangeStart(res) : 0;
      if (start === null) {
        // A 206 with no Content-Range is malformed, but it is answering the Range
        // request we just made, and the only other reading — "this is the whole
        // file" — would DROP the head and truncate the track. Truncation is the
        // failure mode the remuxer catches loudly; take the resume.
      } else if (start === 0) {
        // The whole file, whatever the status said. Keeping the head would
        // duplicate it, so drop what we hold and take this body as complete.
        discardHeld(held, shared, onBytes);
      } else if (start !== held.bytes) {
        // Some third offset. Nothing here can be stitched into what we hold, and
        // guessing is how corruption ships. Throw away the partial and let the
        // retry ladder start this track over from zero.
        discardHeld(held, shared, onBytes);
        throw new Error(`The server resumed at byte ${start} instead of the requested offset.`);
      }
    }
    const advertised = contentLength(res);
    if (advertised !== null) {
      if (held.bytes + advertised > maxBytes) {
        ctrl.abort();
        throw overflow('track', maxBytes);
      }
      if (shared && shared.used + advertised > shared.limit) {
        ctrl.abort();
        throw overflow('combined', shared.limit);
      }
    }
    const append = (chunk: Uint8Array): void => {
      if (held.bytes + chunk.byteLength > maxBytes) {
        ctrl.abort();
        throw overflow('track', maxBytes);
      }
      if (shared && shared.used + chunk.byteLength > shared.limit) {
        ctrl.abort();
        throw overflow('combined', shared.limit);
      }
      held.tail.push(chunk);
      held.tailBytes += chunk.byteLength;
      held.bytes += chunk.byteLength;
      if (shared) shared.used += chunk.byteLength;
      if (held.tailBytes >= SEAL_BYTES) sealTail(held);
      onBytes(held.bytes);
    };
    if (!res.body) {
      const whole = new Uint8Array(await res.arrayBuffer());
      append(whole);
      return;
    }
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm(); // progress: reset the idle timer
      append(value);
    }
  } catch (e) {
    if (stalled) {
      throw new Error('The track download stalled and was aborted. The fbcdn URL may have expired — reload the Facebook page.');
    }
    if ((e as Error)?.name === 'AbortError' && signal?.aborted) {
      throw signal.reason ?? e;
    }
    throw e;
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Download one track, resuming across dropped connections.
 *
 *  Returns a Blob rather than a flat Uint8Array: building the flat buffer means
 *  holding the chunk list AND the copy at once, doubling peak memory for the
 *  largest thing this extension touches, and the browser can back a large Blob
 *  with disk where a JS-heap buffer is always resident.
 *
 *  `onBytes` receives the CUMULATIVE byte count, which can go DOWN if a restart
 *  discards partial data — callers reporting progress must handle that rather
 *  than assume monotonicity. */
export async function fetchTrack(
  url: string,
  onBytes: (total: number) => void,
  opts: FetchTrackOptions = {},
): Promise<Blob> {
  return fetchTrackWithBudget(url, onBytes, opts);
}

async function fetchTrackWithBudget(
  url: string,
  onBytes: (total: number) => void,
  opts: FetchTrackOptions,
  shared?: SharedBudget,
): Promise<Blob> {
  // Never let the offscreen doc (extension origin, holds host_permissions) fetch
  // an arbitrary host — only fbcdn tracks. Blocks SSRF via a forged track URL.
  if (!isFbcdn(url)) throw new Error('Track URL not allowed.');
  const doFetch = opts.fetch ?? globalThis.fetch;
  const attempts = opts.attempts ?? ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const stallMs = opts.stallMs ?? STALL_MS;
  const maxBytes = opts.maxBytes ?? MAX_DASH_TRACK_BYTES;

  const held: Buffered = { sealed: [], tail: [], tailBytes: 0, bytes: 0 };
  for (let attempt = 1; ; attempt++) {
    try {
      await readAttempt(url, held, onBytes, doFetch, stallMs, maxBytes, shared, opts.signal);
      // Concatenating Blobs copies no bytes through JS — the result references the
      // same stores. The cast covers ArrayBufferLike vs ArrayBuffer only: a fetch
      // body is never backed by a SharedArrayBuffer here (no cross-origin isolation).
      sealTail(held);
      return new Blob(held.sealed);
    } catch (e) {
      // A status the server will repeat is not worth three round trips.
      if (e instanceof HardHttpError || e instanceof ByteLimitError || opts.signal?.aborted || attempt >= attempts) throw e;
      await sleep(retryDelayMs * attempt);
    }
  }
}

interface FetchDashTracksOptions extends FetchTrackOptions {
  /** Primarily useful for focused tests; production callers use the hard cap. */
  maxTotalBytes?: number;
}

/** Fetches both DASH inputs under one byte budget. Failure of either side aborts
 * the sibling immediately so it cannot continue consuming network or memory. */
export async function fetchDashTracks(
  videoUrl: string,
  audioUrl: string,
  onVideoBytes: (total: number) => void,
  onAudioBytes: (total: number) => void,
  opts: FetchDashTracksOptions = {},
): Promise<[Blob, Blob]> {
  const controller = new AbortController();
  // childOpts below replaces opts.signal with the controller's own signal (the
  // sibling-abort mechanism needs one shared signal for both children), so a
  // caller-provided signal would otherwise have no effect at all. Link it in.
  const abortFromCaller = (): void => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', abortFromCaller, { once: true });
  if (opts.signal?.aborted) abortFromCaller();
  const shared: SharedBudget = { used: 0, limit: opts.maxTotalBytes ?? MAX_DASH_INPUT_BYTES };
  const abortSibling = async (promise: Promise<Blob>): Promise<Blob> => {
    try {
      return await promise;
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  const childOpts = { ...opts, signal: controller.signal };
  try {
    return await Promise.all([
      abortSibling(fetchTrackWithBudget(videoUrl, onVideoBytes, childOpts, shared)),
      abortSibling(fetchTrackWithBudget(audioUrl, onAudioBytes, childOpts, shared)),
    ]);
  } finally {
    opts.signal?.removeEventListener('abort', abortFromCaller);
  }
}
