// A3 — service-worker.ts's offscreen-document idle-close was check-then-act:
// `if (dashDeduper.inFlightCount === 0) chrome.offscreen.closeDocument().catch(() => {});`
// fired the close WITHOUT awaiting it, never cancelled the scheduled idle
// timer when a new job began, and ensureOffscreen trusted getContexts() even
// while a close from an OLDER job might still be tearing the document down.
// A job that started in that window could see the (about to be) dying
// context via getContexts, skip creating a fresh one, and send its own
// FACESCRAP_MUX into it.
//
// This proves BOTH halves of the fix:
//   1. A job that starts BEFORE the scheduled idle-close timer fires cancels
//      it outright — the stale close never happens underneath a job that is
//      now running.
//   2. A job that starts AFTER the timer has already fired (its close still
//      in flight) waits the close out inside ensureOffscreen before trusting
//      getContexts, instead of racing it.
//
// service-worker.ts has no exports (it registers every listener as a side
// effect of module evaluation), so this drives it the same way
// tests/prot-dash-job-started.test.ts and tests/config.test.ts do: a capture
// chrome.* fake plus the captured runtime.onMessage listener.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mock } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resetChromeStorage } from './chrome-fake';

// service-worker.ts's runDownloadDash() starts a 20s keepalive setInterval on
// every job and OFFSCREEN_IDLE_MS's own setTimeout for the idle-close under
// test — mocking timers is what lets this test fire that timer deterministically
// (via mock.timers.tick) instead of waiting on it in real time.
mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

// Read the real constant from source rather than hand-copying it, so this
// test cannot silently stop exercising the timer if OFFSCREEN_IDLE_MS ever
// changes (same technique tests/config.test.ts uses for its own mirrored
// constants).
const OFFSCREEN_IDLE_MS = (() => {
  const m = readSrc('src/background/service-worker.ts').match(/const OFFSCREEN_IDLE_MS = ([\d_]+);/);
  assert.ok(m, 'could not find OFFSCREEN_IDLE_MS in service-worker.ts');
  return Number(m![1].replace(/_/g, ''));
})();

type Sender = chrome.runtime.MessageSender;
type SendResponse = (response?: unknown) => void;
type OnMessageListener = (message: unknown, sender: Sender, sendResponse: SendResponse) => boolean | undefined;

let onMessage: OnMessageListener | undefined;
let nextDownloadId = 1;

// Fake offscreen-document state, shared across every test in this file —
// mirroring how the SAME real offscreen document persists across DASH jobs.
let offscreenDocOpen = false;
let createDocumentCalls = 0;
let closeDocumentCalls = 0;
let muxCalls = 0;
const pendingCloseResolvers: Array<() => void> = [];

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
  // and prot-dash-job-started.test.ts's fakes: settlement must not depend on
  // the REGISTRATION_RACE_DELAY_MS retry timer, itself now mocked here too.
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
      const m = message as { type?: string; videoUrl?: unknown };
      if (m?.type === 'FACESCRAP_MUX') {
        muxCalls++;
        return { ok: true, blobUrl: `blob:${String(m.videoUrl)}` };
      }
      return undefined; // FACESCRAP_DASH_JOB_STARTED / FACESCRAP_REVOKE: fire-and-forget
    },
    getPlatformInfo: async () => ({}),
    getContexts: async () => (offscreenDocOpen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []),
    ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
  };
  c.offscreen = {
    createDocument: async () => {
      createDocumentCalls++;
      offscreenDocOpen = true;
    },
    // Held open until the test explicitly resolves it — this is what lets the
    // test simulate the real cross-process gap between "close requested" and
    // "Chrome confirms the document is gone".
    closeDocument: () =>
      new Promise<void>((resolve) => {
        closeDocumentCalls++;
        pendingCloseResolvers.push(() => {
          offscreenDocOpen = false;
          resolve();
        });
      }),
    Reason: { BLOBS: 'BLOBS' },
  };
}

await resetChromeStorage();
installChromeFake();
// No exports to bind — importing it only for the chrome.runtime.onMessage
// listener it registers as a side effect, captured by the fake installed
// just above.
await import('../src/background/service-worker');

function sendDash(tabId: number, id: string): Promise<unknown> {
  const videoUrl = `https://video-${id}.xx.fbcdn.net/v/t42/${id}.mp4`;
  const audioUrl = `https://video-${id}.xx.fbcdn.net/v/t42/${id}-audio.mp4`;
  return new Promise((resolve) => {
    const handled = onMessage!(
      {
        type: 'FACESCRAP_DOWNLOAD_DASH',
        tabId,
        videoUrl,
        audioUrl,
        filename: `clip-${id}.mp4`,
        saveAs: false,
        receipt: { id: `v:${id}`, kind: 'video', source: 'reel', savedAt: 0 },
      },
      {} as Sender,
      resolve,
    );
    assert.equal(handled, true);
  });
}

// Drains the microtask queue without depending on any (possibly mocked) timer
// API — see prot-dash-job-started.test.ts's identical helper for why 50
// iterations is enough to settle a whole job's promise chain.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function resolveAllPendingCloses(): Promise<void> {
  while (pendingCloseResolvers.length > 0) pendingCloseResolvers.shift()!();
  await flushMicrotasks();
}

test('A3: starting a new job cancels a still-pending idle-close instead of letting it fire underneath the new job', async () => {
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');
  const tabId = 900_501;

  // Job A completes fully, creates the (only) offscreen document, and
  // schedules an idle-close timer for OFFSCREEN_IDLE_MS from now.
  await sendDash(tabId, 'a3-cancel-a');
  assert.equal(createDocumentCalls, 1, 'job A must have created the offscreen document');
  assert.equal(closeDocumentCalls, 0, 'no close should have happened yet');

  // Job B starts NOW, well before OFFSCREEN_IDLE_MS elapses — its start must
  // cancel job A's pending timer outright.
  await sendDash(tabId, 'a3-cancel-b');
  // Job B must reuse the still-open document — a second createDocument call
  // would only happen if ensureOffscreen wrongly believed no context existed.
  assert.equal(createDocumentCalls, 1, 'job B must reuse the still-open document, not recreate it');

  // Advance the clock past OFFSCREEN_IDLE_MS. If job A's timer had NOT been
  // cancelled, this tick fires it too (dashDeduper is idle by now, so its
  // check passes) IN ADDITION to job B's own timer — two closes instead of
  // the one job B's own schedule accounts for.
  mock.timers.tick(OFFSCREEN_IDLE_MS);
  await flushMicrotasks();
  assert.equal(
    closeDocumentCalls,
    1,
    "exactly one close must fire here (job B's own idle timer) — a second means job A's stale timer was never cancelled",
  );

  await resolveAllPendingCloses();
});

test('A3: ensureOffscreen waits out a close already in flight instead of racing getContexts', async () => {
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');
  const tabId = 900_502;

  await sendDash(tabId, 'a3-wait-c');
  const createsBefore = createDocumentCalls;
  const muxesBefore = muxCalls;

  // Let the idle timer fire; the close it triggers is held open (not yet
  // resolved) by this fake, simulating the real cross-process gap between
  // "close requested" and "Chrome confirms the document is gone".
  mock.timers.tick(OFFSCREEN_IDLE_MS);
  await flushMicrotasks();
  assert.equal(pendingCloseResolvers.length, 1, 'the idle timer must have started exactly one close');
  assert.equal(offscreenDocOpen, true, 'the fake document is still "open" until its close resolver runs');

  // A new job starts WHILE that close is still pending.
  const jobD = sendDash(tabId, 'a3-wait-d');
  await flushMicrotasks();

  // If ensureOffscreen trusted getContexts() without waiting the close out
  // first, it would see offscreenDocOpen still true here and skip straight
  // to sending FACESCRAP_MUX without ever creating a fresh document.
  assert.equal(
    createDocumentCalls,
    createsBefore,
    'job D must NOT have created a document yet — it should be blocked awaiting the in-flight close',
  );
  assert.equal(muxCalls, muxesBefore, 'job D must NOT have sent its mux yet — ensureOffscreen must still be waiting');

  // Now let the close actually finish.
  await resolveAllPendingCloses();

  // Only now should job D have been unblocked, correctly recreating the
  // document before sending its own mux.
  const response = await jobD;
  assert.deepEqual(response, { ok: true });
  assert.equal(createDocumentCalls, createsBefore + 1, 'job D must have created a FRESH document once the close finished');
  assert.equal(muxCalls, muxesBefore + 1, "job D must have sent its own mux only after recreating the document");
});
