// DASH remux via the offscreen document, and the plain download path beside it.
//
// Owns the whole lifetime of one merge: the offscreen document, the keepalive that
// stops MV3 reaping the worker mid-job, the serial job chain, the idle backstop and
// the completion dedup that survives a worker restart. Holds no per-tab state — the
// caller owns tabs, receipts and badges.

import { createJobChain, withHeartbeat } from '../shared/async';
import {
  MUX_HARD_CAP_MS,
  MUX_PORT,
  SETTLE_CAP_MS,
  type DashJobStartedMsg,
  type MuxMsg,
  type MuxProgress,
  type MuxProgressMsg,
  type MuxResponse,
  type RevokeMsg,
} from '../shared/messages';
import {
  dashDownloadKey,
  waitForDownloadSettlement,
  type DashDownloadIdentity,
} from '../shared/download-settlement';
import { createSuccessDeduper, isRecentlyCompleted, withCompletion, type DedupSnapshot } from '../shared/success-deduper';
import { WORST_CASE_SILENCE_MS } from '../shared/track-fetch';

let creatingOffscreen: Promise<void> | null = null;

// Module scope, not per job: the idle-close timer scheduled in runDownloadDash
// outlives the job that scheduled it, so both of these are shared across jobs.
//   - offscreenClosing lets ensureOffscreen wait out a close already in flight, so
//     getContexts() below sees a settled state instead of racing a teardown.
//   - cancelPendingOffscreenIdleClose lets a new job cancel that timer, so an OLD
//     job's "no other job is running" verdict cannot fire once it stopped being true.
let offscreenClosing: Promise<void> | null = null;
let cancelPendingOffscreenIdleClose: (() => void) | null = null;

async function ensureOffscreen(): Promise<void> {
  const closing = offscreenClosing;
  if (closing) await closing;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen/offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Remux split DASH video+audio tracks into one MP4.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

// A DASH job can take a while — the two track fetches dominate it now that the
// merge itself is table surgery — and a service worker that goes idle mid-job is
// killed, orphaning the offscreen reply and hanging the panel's button forever.
// Pinging a cheap API on an interval resets the idle timer while a job runs.
// (chrome.downloads is unavailable in offscreen docs, so the SW must stay alive
// to receive the blob URL and start the download itself.)
function startKeepalive(): () => void {
  const id = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  return () => clearInterval(id);
}

// A DASH download is identified by its (video, audio) track pair. The panel's
// UI timeout (DASH_UI_TIMEOUT_MS) does NOT cancel the SW job, and once the
// panel gives up its button turns clickable again, so duplicates are collapsed:
// a concurrent request shares the one in-flight job, and a request shortly
// after a completed download is an idempotent no-op.
// SETTLE_CAP_MS and MUX_HARD_CAP_MS (imported above from messages.ts) are this
// job's other two timing constants; they live there — not here — so
// DASH_UI_HARD_CAP_MS (the panel's own ceiling) can be derived from them
// instead of merely asserted to sit above them. See their comments there.
// Grace before closing the idle offscreen document after a download settles. It no
// longer has a loaded wasm core to amortize, but recreating the document per
// download would still serialize a page load in front of every merge.
const OFFSCREEN_IDLE_MS = 60_000;

// Backstop on ONE mux round-trip, measured from job START — jobs are serialized on
// dashChain below, so queue wait never burns this budget.
//
// It bounds IDLENESS, against the progress the offscreen reports over MUX_PORT, not
// wall-clock: a 500 MB video on a slow-but-steady link is minutes of perfectly
// healthy transfer, and a wall-clock cap killed it deterministically. It must also
// sit above track-fetch's WHOLE retry ladder, because nothing beats during a stall,
// a backoff or a hanging reconnect — cut a job off inside the ladder and a track
// about to report its own specific error dies under this generic one instead.
const MUX_IDLE_MS = WORST_CASE_SILENCE_MS + 30_000;

// Just past the longest a job can possibly run, and derived from it so the two
// cannot drift apart: a retry clicked after a long download must hit the no-op
// above, never run a second full download of a file already on disk. Derived
// from the HARD CAP rather than the panel's idle window — with progress-based
// timeouts a healthy job may now legitimately outlive that window several times
// over, and a dedup entry that expired first would let a retry duplicate it.
const DEDUP_WINDOW_MS = MUX_HARD_CAP_MS + 30_000;
const dashDeduper = createSuccessDeduper(DEDUP_WINDOW_MS, () => performance.now());

// dashDeduper above is in-memory only, so its success window dies with the
// worker — and MV3 can reap an idle worker roughly a minute after a download
// settles (see scheduleIdleClose below), well inside DEDUP_WINDOW_MS. A Retry
// clicked minutes later, after a restart, would otherwise re-run a full
// track fetch + remux for a file already on disk. Mirror completions into
// chrome.storage.session — wall-clock stamped (see DedupSnapshot), never
// performance.now(), which resets its origin every worker instance — and
// consult the mirror before ever asking dashDeduper to start a fresh job. A
// separate small key rather than routed through storage.ts: this bookkeeping
// is unrelated to the captured-media domain storage.ts owns (media/saved/
// playing/recent/bind), so it does not participate in its capture-headroom
// reservation or per-tab retention.
const DASH_DEDUP_STORAGE_KEY = 'dash_dedup_completed_v1';

async function readDashDedupSnapshot(): Promise<DedupSnapshot> {
  try {
    const raw = (await chrome.storage.session.get(DASH_DEDUP_STORAGE_KEY))[DASH_DEDUP_STORAGE_KEY];
    return raw != null && typeof raw === 'object' ? (raw as DedupSnapshot) : {};
  } catch {
    return {}; // a read failure must never block a legitimate download — fail open
  }
}

function dashCompletedAcrossRestart(key: string): Promise<boolean> {
  return readDashDedupSnapshot().then((snapshot) => isRecentlyCompleted(snapshot, key, Date.now(), DEDUP_WINDOW_MS));
}

async function recordDashCompletionAcrossRestart(key: string): Promise<void> {
  const next = withCompletion(await readDashDedupSnapshot(), key, Date.now(), DEDUP_WINDOW_MS);
  try {
    await chrome.storage.session.set({ [DASH_DEDUP_STORAGE_KEY]: next });
  } catch (err) {
    // Best-effort mirror: losing this write only re-exposes the pre-fix gap
    // for this one entry (a worker-restarted Retry re-downloads it), never a
    // new hazard — the file and its Saved receipt are already durable by now.
    console.error('[FaceScrap] dash dedup mirror write failed', err);
  }
}

// Progress from the running mux. Jobs are serialized on dashChain, so at most
// one beat function is live; the port is opened by the offscreen when its job
// starts (see enqueueMux there).
let activeBeat: (() => void) | null = null;
chrome.runtime.onConnect.addListener((port) => {
  // Only the extension's own offscreen document — a content script's port has
  // sender.tab set. Same defence-in-depth as the message router.
  if (port.name !== MUX_PORT || port.sender?.tab) return;
  port.onMessage.addListener((p: MuxProgress) => {
    activeBeat?.();
    // Forward to the panel so ITS wait is idle-bounded too — otherwise a
    // download long enough to be worth this whole mechanism would still be
    // reported failed by the UI while the worker was happily finishing it.
    chrome.runtime.sendMessage({ type: 'FACESCRAP_MUX_PROGRESS', ...p } satisfies MuxProgressMsg).catch(() => {});
  });
});

// Every DASH job runs one at a time here, whichever panel window sent it, so that
// each job's timeout starts at JOB START rather than at sendMessage: a request queued
// behind a long merge would otherwise burn its budget waiting and be reported failed
// over work that then completed. createJobChain's internal catch keeps one failed job
// from poisoning the chain, while downloadDash still sees its OWN job's rejection.
//
// The panel's ceiling has the same problem from its side, which is why downloadDash
// broadcasts FACESCRAP_DASH_JOB_STARTED — see DASH_UI_HARD_CAP_MS in messages.ts.
const dashChain = createJobChain<void>();

export async function downloadDash(request: DashDownloadIdentity): Promise<void> {
  const key = dashDownloadKey(request);
  // Durable check FIRST: dashDeduper's own in-memory hit/miss means nothing
  // right after a worker restart.
  if (await dashCompletedAcrossRestart(key)) return;
  await dashDeduper.run(key, () =>
    // The completion mirror write is folded into the SAME chained job (not
    // appended after it) so it is serialized against every other queued job's
    // read-modify-write of the one shared storage key — two jobs completing
    // close together could otherwise race and silently lose one's record.
    dashChain(async () => {
      // Tell whichever panel is waiting on THIS request that it has left the
      // queue — addressed by `key` so a panel queued behind a DIFFERENT job
      // can never rebase its hard cap off someone else's start. Fire-and-
      // forget, like FACESCRAP_MUX_PROGRESS: with no panel open (or the wrong
      // one listening), sendMessage simply finds no matching receiver.
      chrome.runtime
        .sendMessage({ type: 'FACESCRAP_DASH_JOB_STARTED', key } satisfies DashJobStartedMsg)
        .catch(() => {});
      await runDownloadDash(request.videoUrl, request.audioUrl, request.filename, request.saveAs);
      await recordDashCompletionAcrossRestart(key);
    }),
  );
}

async function runDownloadDash(
  videoUrl: string,
  audioUrl: string,
  filename: string,
  saveAs: boolean,
): Promise<void> {
  // Synchronous, before any await: it either beats a not-yet-fired timer or is a safe
  // no-op (ensureOffscreen's offscreenClosing wait covers the already-fired case).
  // Also releases the previous job's keepalive, which nothing else would ever release.
  cancelPendingOffscreenIdleClose?.();
  const stopKeepalive = startKeepalive();
  let keepaliveStopped = false;
  const stopOnce = (): void => {
    if (keepaliveStopped) return;
    keepaliveStopped = true;
    stopKeepalive();
  };
  // Let the document go once idle: it holds the fetched tracks and the published
  // blob, which is the only memory left in this path now that there is no wasm
  // heap. Hold the keepalive one grace period longer, then close it if no other
  // mux is running. The next download simply recreates it.
  let idleCloseScheduled = false;
  const scheduleIdleClose = (): void => {
    if (idleCloseScheduled) return;
    idleCloseScheduled = true;
    const timer = setTimeout(() => {
      cancelPendingOffscreenIdleClose = null;
      if (dashDeduper.inFlightCount === 0) {
        // Module-scope (not a local var) so a job starting while this is
        // still in flight can await it from ensureOffscreen instead of
        // racing it — see offscreenClosing's comment above.
        offscreenClosing = chrome.offscreen
          .closeDocument()
          .catch(() => {})
          .finally(() => {
            offscreenClosing = null;
          });
      }
      stopOnce();
    }, OFFSCREEN_IDLE_MS);
    cancelPendingOffscreenIdleClose = () => {
      clearTimeout(timer);
      cancelPendingOffscreenIdleClose = null;
      stopOnce();
    };
  };

  try {
    await ensureOffscreen();
    let res: MuxResponse | undefined;
    try {
      const guarded = withHeartbeat(
        chrome.runtime.sendMessage({ type: 'FACESCRAP_MUX', videoUrl, audioUrl } satisfies MuxMsg),
        MUX_IDLE_MS,
        MUX_HARD_CAP_MS,
        'The merge timed out.',
      );
      activeBeat = guarded.beat;
      try {
        res = (await guarded.promise) as MuxResponse | undefined;
      } finally {
        activeBeat = null;
      }
    } catch (e) {
      // A timed-out mux may still be RUNNING over there: the guard only stops
      // waiting, and there is no cancel message. Left alive, the wedge keeps the
      // offscreen queue busy and cascades false timeouts into every job behind it, so
      // tear the document down and let the next job recreate one. AWAITED before the
      // rethrow — dashChain advances on rejection within microtasks, while
      // closeDocument is a cross-process round trip, and an unawaited close lets the
      // next job's getContexts see the dying document and send its mux into it.
      await chrome.offscreen.closeDocument().catch(() => {});
      throw e;
    }
    if (res?.ok !== true || !res.blobUrl) {
      throw new Error((res?.ok === false ? res.error : undefined) || 'Could not merge audio and video.');
    }

    const blobUrl = res.blobUrl;
    let downloadId: number;
    try {
      downloadId = await chrome.downloads.download({ url: blobUrl, filename, saveAs });
    } catch (e) {
      // The mux succeeded but the download couldn't start — release the
      // offscreen-owned blob instead of leaking it until the doc closes.
      chrome.runtime.sendMessage({ type: 'FACESCRAP_REVOKE', blobUrl } satisfies RevokeMsg).catch(() => {});
      throw e;
    }
    try {
      // `download()` proves only enqueue. Dedup and Saved advance only after
      // this terminal promise confirms the file actually reached `complete`.
      await waitForDownloadSettlement(chrome.downloads, downloadId, {
        timeoutMs: SETTLE_CAP_MS,
        cancelOnTimeout: true,
      });
    } finally {
      chrome.runtime.sendMessage({ type: 'FACESCRAP_REVOKE', blobUrl } satisfies RevokeMsg).catch(() => {});
    }
    scheduleIdleClose();
  } catch (e) {
    // Same idle-close path as success: a failed mux (an expired fbcdn URL is the
    // common failure) must not leave the offscreen document — and the tracks it
    // fetched — alive indefinitely.
    scheduleIdleClose();
    throw e;
  }
}

export async function downloadDirect(url: string, filename: string, saveAs: boolean): Promise<void> {
  const stopKeepalive = startKeepalive();
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs,
    });
    // A remote progressive file can be legitimately slow, so unlike the local
    // DASH blob this has no wall-clock timeout. The browser's terminal event is
    // the authority; interruption rejects and leaves Retry real.
    await waitForDownloadSettlement(chrome.downloads, downloadId);
  } finally {
    stopKeepalive();
  }
}
