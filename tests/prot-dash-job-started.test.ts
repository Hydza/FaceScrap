// PROTOCOL lane, stage 1 — C5 residual: the side panel's DASH_UI_HARD_CAP_MS
// wait used to arm at chrome.runtime.sendMessage time, before a request even
// reached dashChain (service-worker.ts serializes every DASH job on that one
// chain). A request queued behind another long-running job could exhaust that
// whole budget while still queued, then have the worker finish it and write a
// Saved receipt under a card the panel had already tagged Failed.
//
// The fix: service-worker.ts's downloadDash() now broadcasts
// FACESCRAP_DASH_JOB_STARTED — addressed by dashDownloadKey — the instant a
// request LEAVES dashChain, so the panel can rebase its hard cap off the job
// actually starting. The panel's half of this used to be pinned by source-text
// assertions; those were dropped as refactor-detectors, so what follows is the
// whole automated guard — the panel side shows up in a real tab as a merge that
// times out early.
//
// This test proves the WORKER-side half: a second, differently-keyed request
// queued behind a first must not see its own start signal until the first's
// entire run (mux + download + settlement) has actually finished — not merely
// once it is received or queued. If downloadDash regressed to broadcasting at
// receive time (the same bug shape as before, just moved earlier), this test
// would see job B's signal long before job A's mux ever resolves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mock } from 'node:test';

import { dashDownloadKey, type DashDownloadIdentity } from '../src/shared/download-settlement';
import { resetChromeStorage } from './chrome-fake';

// service-worker.ts's runDownloadDash() starts a 20s keepalive setInterval and
// a 60s offscreen-idle-close setTimeout on EVERY job, success or failure (by
// design — see OFFSCREEN_IDLE_MS's comment there). Mocking timers here is not
// about the fix under test; it is what lets this test exercise a REAL job
// end-to-end without the process (or this file's `node --test` run) blocking
// on those multi-second real-world backstops. Only setInterval/setTimeout are
// mocked — Promise-based flushing below never depends on either, so nothing
// needs the mock clock ever advanced or ticked.
mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

type Sender = chrome.runtime.MessageSender;
type SendResponse = (response?: unknown) => void;
type OnMessageListener = (message: unknown, sender: Sender, sendResponse: SendResponse) => boolean | undefined;

let onMessage: OnMessageListener | undefined;
let nextDownloadId = 1;

// Every FACESCRAP_MUX request (worker -> offscreen, in real life) is held
// pending here until the test explicitly resolves it via the stored resolver
// — keyed by videoUrl, since each job below uses a distinct one. This is what
// lets the test PROVE ordering: while job A's resolver is never called, its
// mux (and everything chained after it) cannot settle, so dashChain cannot
// advance to job B — if it did anyway, that would itself be a bug.
//
// Every FACESCRAP_DASH_JOB_STARTED broadcast is logged instead, in send
// order, so the test can assert exactly when each job's signal went out
// relative to the other job's mux resolving.
const pendingMux = new Map<string, () => void>();
const jobStartedLog: string[] = [];

function installChromeFake(): void {
  const c = chrome as unknown as Record<string, unknown>;
  c.action = {
    disable: async () => {},
    enable: async () => {},
    setPopup: async () => {},
    setTitle: async () => {},
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  };
  c.tabs = {
    query: async () => [],
    get: async () => ({}),
    sendMessage: async () => ({}),
    onActivated: { addListener() {} },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
  };
  c.scripting = { executeScript: async () => [] };
  c.webRequest = { onBeforeRequest: { addListener() {} } };
  c.webNavigation = {
    onBeforeNavigate: { addListener() {} },
    onCommitted: { addListener() {} },
    onErrorOccurred: { addListener() {} },
  };
  // Resolves every download 'complete' immediately, same as config.test.ts's
  // fake: settlement must not depend on the REGISTRATION_RACE_DELAY_MS retry
  // timer (download-settlement.ts), which is now a mocked/fake timer here.
  c.downloads = {
    download: async () => nextDownloadId++,
    onChanged: { addListener() {}, removeListener() {} },
    search: async (query: { id?: number }) => [{ id: query.id, state: 'complete' }],
    cancel: async () => {},
  };
  c.runtime = {
    id: 'test-extension-id',
    getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onConnect: { addListener() {} },
    onMessage: {
      addListener(fn: OnMessageListener) {
        onMessage = fn;
      },
    },
    sendMessage: async (message: unknown) => {
      const m = message as { type?: string; key?: unknown; videoUrl?: unknown };
      if (m?.type === 'FACESCRAP_DASH_JOB_STARTED') {
        jobStartedLog.push(String(m.key));
        return undefined;
      }
      if (m?.type === 'FACESCRAP_MUX') {
        const videoUrl = String(m.videoUrl);
        return new Promise((resolve) => {
          pendingMux.set(videoUrl, () => resolve({ ok: true, blobUrl: `blob:${videoUrl}` }));
        });
      }
      return undefined; // FACESCRAP_REVOKE and anything else: fire-and-forget
    },
    getPlatformInfo: async () => ({}),
    // Only present so hasOffscreen() feature-detects true (see capabilities.ts).
    getContexts: async () => [],
    ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
  };
  c.offscreen = { createDocument: async () => {}, Reason: { BLOBS: 'BLOBS' } };
}

await resetChromeStorage();
installChromeFake();
// No exports to bind — importing it only for the chrome.runtime.onMessage
// listener it registers as a side effect, captured by the fake installed
// just above (same pattern as tests/config.test.ts and
// tests/fix-background-identity.test.ts).
await import('../src/background/service-worker');

function sendDash(identity: DashDownloadIdentity): Promise<unknown> {
  return new Promise((resolve) => {
    const handled = onMessage!(
      {
        type: 'FACESCRAP_DOWNLOAD_DASH',
        tabId: identity.tabId,
        videoUrl: identity.videoUrl,
        audioUrl: identity.audioUrl,
        filename: identity.filename,
        saveAs: identity.saveAs,
        receipt: { id: identity.receiptId, kind: 'video', source: 'reel', savedAt: 0 },
      },
      {} as Sender,
      resolve,
    );
    assert.equal(handled, true);
  });
}

// Drains the microtask queue without depending on any (possibly mocked) timer
// API: every step of downloadDash()'s setup (dashCompletedAcrossRestart,
// dashDeduper.run, the dashChain attachment itself) and of a resolved mux's
// aftermath (chrome.downloads.download, the immediate 'complete' settlement
// path, recordDashCompletionAcrossRestart) is Promise-chained only — nothing
// on these paths waits on a real or mocked setTimeout in this test's fakes.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

test('a DASH job queued behind another does not broadcast FACESCRAP_DASH_JOB_STARTED until the earlier job fully settles', async () => {
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');
  const tabId = 900_301;

  const identityA: DashDownloadIdentity = {
    tabId,
    receiptId: 'v:prot-job-a',
    videoUrl: 'https://video-a.xx.fbcdn.net/v/t42/a.mp4',
    audioUrl: 'https://video-a.xx.fbcdn.net/v/t42/a-audio.mp4',
    filename: 'clip-a.mp4',
    saveAs: false,
  };
  const identityB: DashDownloadIdentity = {
    tabId,
    receiptId: 'v:prot-job-b',
    videoUrl: 'https://video-b.xx.fbcdn.net/v/t42/b.mp4',
    audioUrl: 'https://video-b.xx.fbcdn.net/v/t42/b-audio.mp4',
    filename: 'clip-b.mp4',
    saveAs: false,
  };
  const keyA = dashDownloadKey(identityA);
  const keyB = dashDownloadKey(identityB);
  assert.notEqual(keyA, keyB, 'the two jobs must be distinct requests, not deduped into one');

  // 1. Send A alone and let it run up to its held mux call.
  const jobA = sendDash(identityA);
  await flushMicrotasks();
  assert.ok(pendingMux.has(identityA.videoUrl), 'job A must have reached its mux call (dashChain started empty)');
  assert.deepEqual(jobStartedLog, [keyA], 'job A must broadcast its OWN start signal once it leaves the (empty) queue');

  // 2. NOW send B. It is chained behind A on dashChain, and A's mux is still
  // held pending — B's job body (including its own broadcast) must not run.
  const jobB = sendDash(identityB);
  await flushMicrotasks();
  assert.ok(!pendingMux.has(identityB.videoUrl), 'job B must not have reached its mux call yet — it is still queued behind A');
  assert.deepEqual(jobStartedLog, [keyA], 'job B must NOT broadcast its start signal while still queued behind A');

  // 3. Resolve A's mux and let its whole job (download + settlement +
  // completion bookkeeping) finish. Only THEN can dashChain advance to B.
  pendingMux.get(identityA.videoUrl)!();
  await jobA;
  await flushMicrotasks();

  assert.deepEqual(
    jobStartedLog,
    [keyA, keyB],
    'job B must broadcast its start signal only after job A fully settles, and only once',
  );
  assert.ok(pendingMux.has(identityB.videoUrl), 'job B must now have reached its own mux call');

  // Let B finish too so its own sendResponse resolves cleanly.
  pendingMux.get(identityB.videoUrl)!();
  await jobB;
});
