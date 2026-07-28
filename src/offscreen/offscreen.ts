// FaceScrap offscreen document.
//
// The service worker cannot do this job: it has no URL.createObjectURL, which is
// the only way to hand chrome.downloads a file this extension built itself. This
// page fetches the separate DASH video + audio tracks from fbcdn
// (host_permissions bypass CORS) and merges them into one MP4.
//
// The merge is src/shared/mp4-remux.ts: copy the sample bytes, write a new sample
// table around them, trim to the shorter track. Its output is assembled from Blob
// slices, so the media never passes through this document's memory (see
// ARCHITECTURE.md's remux invariant).

import { createChainLock } from '../shared/async';
import { diagLog, diagLogDrain, errorText, redactUrl, setDiagContext, setDiagLogEnabled } from '../shared/diag-log';
import { MUX_PORT, MUX_PROGRESS_MS, type MuxProgress, type MuxResponse, type RuntimeMessage } from '../shared/messages';
import { remux } from '../shared/mp4-remux';
import { fetchDashTracks, MAX_DASH_OUTPUT_BYTES } from '../shared/track-fetch';

// Diagnostics (see shared/diag-log.ts). This document is where an HD download
// actually happens — the two track fetches and the remux — so a failure here is
// the one the user reports as "saving does nothing".
//
// AN OFFSCREEN DOCUMENT HAS chrome.runtime AND ESSENTIALLY NOTHING ELSE.
// `chrome.storage` is undefined here (measured on Edge 150; see
// tests/fix-offscreen-apis.test.ts). It cannot read the diagnostics setting and
// cannot persist what it records, so it does neither: the worker sends the flag on
// the mux request, and this document hands its trace back in the mux answer.
//
// This is not a style preference. Touching chrome.storage at module scope here
// throws while this script is still evaluating, which means the mux listener at the
// bottom of this file never registers — and every HD download then fails instantly
// with a generic error, because the worker's message reaches no receiver.
setDiagContext('offscreen');
/** Opens a progress port to the worker for ONE job. Jobs are serialized on both
 *  sides (muxQueue here, dashChain there), so at most one is ever open. */
function progressPort(): { report: (p: MuxProgress) => void; close: () => void } {
  let port: chrome.runtime.Port | null = null;
  try {
    port = chrome.runtime.connect({ name: MUX_PORT });
  } catch {
    // No worker to talk to (torn down mid-job). The mux still completes; the
    // worker's hard cap covers the case where nobody is listening.
  }
  let last = 0;
  return {
    report(p) {
      const now = performance.now();
      if (now - last < MUX_PROGRESS_MS) return; // a chunk-rate port would flood the worker
      last = now;
      try {
        port?.postMessage(p);
      } catch {
        port = null;
      }
    },
    close() {
      try {
        port?.disconnect();
      } catch {
        /* already gone */
      }
    },
  };
}


async function mux(videoUrl: string, audioUrl: string, report: (p: MuxProgress) => void): Promise<string> {
  // Each track reports its own CUMULATIVE total, which can go down when a
  // resume restarts from scratch — so track them separately and sum, rather
  // than accumulating deltas that a rewind would leave overstated forever.
  const held = { video: 0, audio: 0 };
  const post = (): void => report({ phase: 'fetch', bytes: held.video + held.audio });
  const [v, a] = await fetchDashTracks(
    videoUrl,
    audioUrl,
    (t) => {
      held.video = t;
      post();
    },
    (t) => {
      held.audio = t;
      post();
    },
  );

  // The remux reads only the sample TABLES — a few hundred KB even for a long
  // video — so it finishes in one step rather than streaming progress. Report the
  // phase change so a worker watching the port sees the fetch end, not a gap.
  report({ phase: 'remux', bytes: 0 });
  // Both track sizes, at the one moment both are known. A merge that produces a
  // file the player refuses is almost always visible here first — an audio track
  // of a few hundred bytes, or a video track that stopped short.
  diagLog('muxFetched', { video: v.size, audio: a.size });
  const merged = await remux(v, a);
  report({ phase: 'remux', bytes: 100 });
  diagLog('muxRemuxed', { bytes: merged.blob.size });

  // A merge cannot legitimately exceed its combined inputs. Checked before a blob
  // URL is published, as with the wasm path.
  if (merged.blob.size > MAX_DASH_OUTPUT_BYTES) {
    throw new Error(`Remux output exceeds the ${MAX_DASH_OUTPUT_BYTES}-byte safety limit.`);
  }
  return publishBlob(merged.blob);
}

// The SW revokes each blob via FACESCRAP_REVOKE once its download settles; if the SW
// is torn down first, self-revoke after a generous TTL so a full MP4 can't leak
// for the lifetime of this never-closed offscreen document.
const BLOB_TTL_MS = 10 * 60_000;
const pendingRevokes = new Map<string, ReturnType<typeof setTimeout>>();

/** The merged file is already a Blob of slices of the fetched tracks — publishing
 *  it costs a URL, not a copy. */
function publishBlob(blob: Blob): string {
  const url = URL.createObjectURL(blob);
  pendingRevokes.set(url, setTimeout(() => revokeBlob(url), BLOB_TTL_MS));
  return url;
}

function revokeBlob(url: string): void {
  const timer = pendingRevokes.get(url);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingRevokes.delete(url);
  }
  URL.revokeObjectURL(url);
}

// The remuxer is stateless, so this is no longer a correctness requirement the way
// it was with ffmpeg's single instance and fixed FS filenames. It stays because it
// bounds memory: two concurrent jobs mean two pairs of fully-fetched tracks held at
// once, and the worker's own dashChain already expects one job at a time.
const muxQueue = createChainLock();
function enqueueMux(videoUrl: string, audioUrl: string): Promise<string> {
  // The port opens when the job STARTS, not when it is queued: the worker times
  // each job from its own start, and a queued job reporting nothing yet would
  // otherwise look idle.
  return muxQueue(async () => {
    const port = progressPort();
    const startedAt = Date.now();
    diagLog('muxStart', { video: redactUrl(videoUrl), audio: redactUrl(audioUrl) });
    try {
      const url = await mux(videoUrl, audioUrl, port.report);
      diagLog('muxDone', { ms: Date.now() - startedAt });
      return url;
    } catch (error) {
      diagLog('muxFailed', { ms: Date.now() - startedAt, error: errorText(error) }, 'error');
      throw error;
    } finally {
      port.close();
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only the extension's own pages (the SW) drive the mux; a content script has
  // sender.tab set. Defense in depth — mux inputs are fbcdn-gated anyway.
  if (sender.tab) return undefined;
  const m = msg as RuntimeMessage | undefined;
  if (m?.type === 'FACESCRAP_MUX') {
    // The flag arrives with the job, since this context cannot read settings. Set
    // before the job starts so the whole job is traced, and cleared by the drain
    // below so one job's events can never be reported twice.
    setDiagLogEnabled(m.diag === true);
    (async () => {
      try {
        const blobUrl = await enqueueMux(m.videoUrl, m.audioUrl);
        sendResponse({ ok: true, blobUrl, events: diagLogDrain() } satisfies MuxResponse);
      } catch (e) {
        // The failure path is the one whose trace matters most — it carries the
        // track sizes and the remux error behind the worker's generic message.
        sendResponse({ ok: false, error: String((e as Error)?.message ?? e), events: diagLogDrain() } satisfies MuxResponse);
      }
    })();
    return true; // keep the channel open for the async response
  }
  if (m?.type === 'FACESCRAP_REVOKE' && typeof m.blobUrl === 'string') {
    revokeBlob(m.blobUrl);
  }
  return undefined;
});
