import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DASH_UI_HARD_CAP_MS, MUX_HARD_CAP_MS, SETTLE_CAP_MS } from '../src/shared/messages';
import { dashDownloadKey } from '../src/shared/download-settlement';
import { resetChromeStorage } from './chrome-fake';

// The suite runs with cwd = repo root (scripts/test.mjs). import.meta.url can't
// be used: esbuild bundles the tests into a temp dir, so it no longer resolves
// to the repo.
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(process.cwd(), rel), 'utf8'));
const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

test('package.json declares the Node engine the toolchain needs', () => {
  const pkg = readJson('package.json') as { engines?: { node?: string } };
  assert.ok(pkg.engines?.node, 'a from-source builder on old Node gets no guidance without an engines field');
});

test('DASH_UI_HARD_CAP_MS is derived strictly above one full worker job worst case', () => {
  // messages.ts derives this panel-side ceiling from MUX_HARD_CAP_MS +
  // SETTLE_CAP_MS rather than a bare literal precisely so it cannot silently
  // regress to equalling (or falling below) the worker's own worst case —
  // which would let the panel time out at or before the worker is still
  // entitled to keep working on the very same job.
  assert.ok(DASH_UI_HARD_CAP_MS > MUX_HARD_CAP_MS + SETTLE_CAP_MS);
});

test('MUX_IDLE_MS in service-worker.ts is derived above track-fetch.ts\'s full retry-ladder worst case', () => {
  // track-fetch.ts's retry ladder (STALL_MS/ATTEMPTS/RETRY_DELAY_MS) is not
  // exported, so service-worker.ts keeps a hand-mirrored copy (see the
  // comment above TRACK_FETCH_STALL_MS there) instead of importing it. This
  // test is the guard against that mirror drifting from the real ladder, and
  // against MUX_IDLE_MS regressing to a value that no longer sits above it —
  // exactly the bug that once killed a download still healthy on attempt 2 of
  // a lawful 3-attempt retry (see MUX_IDLE_MS's own comment).
  const trackFetchSrc = readSrc('src/shared/track-fetch.ts');
  const workerSrc = readSrc('src/background/service-worker.ts');

  const extract = (src: string, re: RegExp, label: string): number => {
    const m = src.match(re);
    assert.ok(m, `could not find ${label}`);
    return Number(m![1].replace(/_/g, ''));
  };

  const realStallMs = extract(trackFetchSrc, /const STALL_MS = ([\d_]+);/, 'track-fetch.ts STALL_MS');
  const realAttempts = extract(trackFetchSrc, /const ATTEMPTS = ([\d_]+);/, 'track-fetch.ts ATTEMPTS');
  const realRetryDelayMs = extract(trackFetchSrc, /const RETRY_DELAY_MS = ([\d_]+);/, 'track-fetch.ts RETRY_DELAY_MS');

  const mirroredStallMs = extract(
    workerSrc,
    /const TRACK_FETCH_STALL_MS = ([\d_]+);/,
    'service-worker.ts TRACK_FETCH_STALL_MS',
  );
  const mirroredAttempts = extract(
    workerSrc,
    /const TRACK_FETCH_ATTEMPTS = ([\d_]+);/,
    'service-worker.ts TRACK_FETCH_ATTEMPTS',
  );
  const mirroredRetryDelayMs = extract(
    workerSrc,
    /const TRACK_FETCH_RETRY_DELAY_MS = ([\d_]+);/,
    'service-worker.ts TRACK_FETCH_RETRY_DELAY_MS',
  );
  assert.equal(mirroredStallMs, realStallMs, 'TRACK_FETCH_STALL_MS mirror is out of sync with track-fetch.ts STALL_MS');
  assert.equal(mirroredAttempts, realAttempts, 'TRACK_FETCH_ATTEMPTS mirror is out of sync with track-fetch.ts ATTEMPTS');
  assert.equal(
    mirroredRetryDelayMs,
    realRetryDelayMs,
    'TRACK_FETCH_RETRY_DELAY_MS mirror is out of sync with track-fetch.ts RETRY_DELAY_MS',
  );

  const margin = extract(
    workerSrc,
    /const MUX_IDLE_MS = TRACK_FETCH_WORST_CASE_SILENCE_MS \+ ([\d_]+);/,
    'service-worker.ts MUX_IDLE_MS',
  );

  // Same arithmetic as fetchTrackWithBudget's retry loop: every attempt
  // stalls out (STALL_MS each) plus the backoff sleep between attempts
  // (RETRY_DELAY_MS * attempt, for every attempt but the last).
  const worstCaseSilenceMs = realStallMs * realAttempts + (realRetryDelayMs * (realAttempts * (realAttempts - 1))) / 2;
  const muxIdleMs = worstCaseSilenceMs + margin;
  assert.ok(muxIdleMs > worstCaseSilenceMs, 'MUX_IDLE_MS must sit strictly above the lawful worst-case retry-ladder silence');
  // Pins today's actual numbers too, so a passing test can't hide behind a
  // margin that happens to cancel out: at today's values this is 183_000ms.
  assert.equal(worstCaseSilenceMs, 183_000);
});

// S8: sanitizeDownloadReceipt used to hardcode its three bounds
// (id.length > 258, thumbUrl.length <= 1024, resLabel.slice(0, 16)) as
// separate literals, even though storage.ts already declares — and enforces
// on every SavedEntry via sanitizeEntry — the exact same three numbers as
// SAVED_ID_MAX / SAVED_THUMB_MAX / SAVED_LABEL_MAX. Two independently
// hand-maintained copies of the same bound can drift the moment either one
// changes; this pins service-worker.ts to importing storage.ts's exports
// instead of re-spelling them, the same drift-guard technique the MUX_IDLE_MS
// test above uses for its own mirrored constants.
test('S8: sanitizeDownloadReceipt in service-worker.ts imports its bounds from storage.ts instead of re-spelling them', () => {
  const workerSrc = readSrc('src/background/service-worker.ts');

  assert.match(
    workerSrc,
    /import\s*\{[^}]*\bSAVED_ID_MAX\b[^}]*\}\s*from\s*'\.\.\/shared\/storage'/,
    'service-worker.ts must import SAVED_ID_MAX from storage.ts',
  );
  assert.match(
    workerSrc,
    /import\s*\{[^}]*\bSAVED_THUMB_MAX\b[^}]*\}\s*from\s*'\.\.\/shared\/storage'/,
    'service-worker.ts must import SAVED_THUMB_MAX from storage.ts',
  );
  assert.match(
    workerSrc,
    /import\s*\{[^}]*\bSAVED_LABEL_MAX\b[^}]*\}\s*from\s*'\.\.\/shared\/storage'/,
    'service-worker.ts must import SAVED_LABEL_MAX from storage.ts',
  );

  const fnMatch = workerSrc.match(/function sanitizeDownloadReceipt\([\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'could not locate sanitizeDownloadReceipt in service-worker.ts');
  const fn = fnMatch![0];

  assert.match(fn, /receipt\.id\.length > SAVED_ID_MAX/, 'the id bound must reference SAVED_ID_MAX');
  assert.match(fn, /receipt\.thumbUrl\.length <= SAVED_THUMB_MAX/, 'the thumbUrl bound must reference SAVED_THUMB_MAX');
  assert.match(
    fn,
    /receipt\.resLabel\.slice\(0, SAVED_LABEL_MAX\)/,
    'the resLabel truncation must reference SAVED_LABEL_MAX',
  );

  // The old hardcoded numbers must be GONE from this function, not merely
  // supplemented by the imports above (which would leave both a literal and
  // an unused import, still free to drift against each other in practice).
  assert.doesNotMatch(fn, /\b258\b/, 'the old hardcoded id bound (258) must not remain');
  assert.doesNotMatch(fn, /\b1024\b/, 'the old hardcoded thumbUrl bound (1024) must not remain');
  assert.doesNotMatch(fn, /\.slice\(0, 16\)/, 'the old hardcoded resLabel bound (16) must not remain');
});

// C7 regression: a Saved-receipt write failure AFTER an already-successful
// download must be reported as ok:true, never a failed download — otherwise
// the panel tags an already-saved file Failed, and clicking Retry lands
// inside the dedup window and silently no-ops, hiding that the file was
// already written the first time.
//
// service-worker.ts has no exports (it registers every listener as a side
// effect of module evaluation — see tests/fix-background-identity.test.ts's
// own comment), so exercising this needs a minimal chrome.* fake sufficient
// to import it cleanly and capture its onMessage listener. Kept as its own
// small fake rather than sharing one across test files: chrome.storage comes
// from chrome-fake.ts's real in-memory implementation; everything else below
// is a capture-only stub.
type Sender = chrome.runtime.MessageSender;
type SendResponse = (response?: unknown) => void;
type OnMessageListener = (message: unknown, sender: Sender, sendResponse: SendResponse) => boolean | undefined;

let onMessage: OnMessageListener | undefined;
let nextDownloadId = 1;

function installDownloadChromeFake(): void {
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
  // Resolves every download 'complete' immediately: the download itself must
  // succeed so only the Saved-receipt write (below, per-test) is the failure
  // under test.
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
    sendMessage: async () => undefined,
    getPlatformInfo: async () => ({}),
    // Only present so hasOffscreen() feature-detects true and the
    // FACESCRAP_DOWNLOAD_DASH handler does not reject before reaching
    // downloadDash — the E4 test below never lets execution reach a real
    // createDocument/mux call (see that test's comment).
    getContexts: async () => [],
    ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
  };
  c.offscreen = { createDocument: async () => {}, Reason: { BLOBS: 'BLOBS' } };
}

await resetChromeStorage();
installDownloadChromeFake();
// No exports to bind — importing it only for the chrome.* listener it
// registers as a side effect, captured by the fake installed just above.
await import('../src/background/service-worker');

test('C7: a Saved-receipt write failure after a successful download reports ok:true, not a failed download', async () => {
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');
  const tabId = 900_001;
  const receipt = { id: 'v:c7-test', kind: 'video', source: 'reel', savedAt: 0 };

  // Every OTHER storage.session write (including the download's own control-
  // headroom bookkeeping) still uses chrome-fake.ts's real in-memory
  // implementation; only the Saved-ledger write inside addSaved is made to
  // fail, and only for the duration of this test.
  const originalSet = chrome.storage.session.set;
  (chrome.storage.session as unknown as { set: unknown }).set = async () => {
    throw new Error('simulated storage.session failure');
  };
  try {
    const response = await new Promise<unknown>((resolve) => {
      const handled = onMessage!(
        {
          type: 'FACESCRAP_DOWNLOAD_DIRECT',
          tabId,
          url: 'https://video-abc.xx.fbcdn.net/v/t42/clip.mp4',
          filename: 'clip.mp4',
          receipt,
        },
        {} as Sender,
        resolve,
      );
      assert.equal(handled, true);
    });
    assert.deepEqual(response, { ok: true });
  } finally {
    chrome.storage.session.set = originalSet;
  }
});

test('E4: a dash download completed before a simulated worker restart is not re-run', async () => {
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');
  const identity = {
    tabId: 900_002,
    receiptId: 'v:e4-test',
    videoUrl: 'https://video-abc.xx.fbcdn.net/v/t42/video.mp4',
    audioUrl: 'https://video-abc.xx.fbcdn.net/v/t42/audio.mp4',
    filename: 'clip.mp4',
    saveAs: false,
  };
  // Seeds the durable mirror exactly as recordDashCompletionAcrossRestart
  // would after a genuine completion — done directly rather than through a
  // real download so this test need not fake a working offscreen mux
  // round-trip. This IS the point: if downloadDash's durable check did not
  // short-circuit before dashChain/ensureOffscreen, execution would reach
  // this fake's incomplete FACESCRAP_MUX handling (sendMessage resolves
  // undefined, so runDownloadDash throws "Could not merge audio and video."),
  // and the assertion below would see ok:false instead.
  await chrome.storage.session.set({
    dash_dedup_completed_v1: { [dashDownloadKey(identity)]: Date.now() - 1_000 },
  });

  const receipt = { id: identity.receiptId, kind: 'video', source: 'reel', savedAt: 0 };
  const response = await new Promise<unknown>((resolve) => {
    const handled = onMessage!(
      {
        type: 'FACESCRAP_DOWNLOAD_DASH',
        tabId: identity.tabId,
        videoUrl: identity.videoUrl,
        audioUrl: identity.audioUrl,
        filename: identity.filename,
        saveAs: identity.saveAs,
        receipt,
      },
      {} as Sender,
      resolve,
    );
    assert.equal(handled, true);
  });
  assert.deepEqual(response, { ok: true });
});
