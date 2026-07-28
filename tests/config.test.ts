import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DASH_UI_HARD_CAP_MS, MUX_HARD_CAP_MS, SETTLE_CAP_MS } from '../src/shared/messages';
import { dashDownloadKey } from '../src/shared/download-settlement';
import { ATTEMPTS, RETRY_DELAY_MS, STALL_MS, WORST_CASE_SILENCE_MS } from '../src/shared/track-fetch';
import { getSaved, SAVED_ID_MAX, SAVED_LABEL_MAX, SAVED_THUMB_MAX } from '../src/shared/saved';
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

test('the mux idle window is derived above track-fetch\'s full retry-ladder worst case', () => {
  // Nothing beats during a stall, a backoff or a hanging reconnect, so a mux cut off
  // INSIDE the ladder kills a track that was about to report its own specific error.
  // The worker imports WORST_CASE_SILENCE_MS and adds a margin, so it cannot drift
  // below the ladder by construction; this pins the arithmetic and today's numbers.
  assert.equal(
    WORST_CASE_SILENCE_MS,
    STALL_MS * ATTEMPTS + (RETRY_DELAY_MS * (ATTEMPTS * (ATTEMPTS - 1))) / 2,
  );
  assert.equal(WORST_CASE_SILENCE_MS, 183_000);
  assert.match(
    readSrc('src/background/dash-download.ts'),
    /const MUX_IDLE_MS = WORST_CASE_SILENCE_MS \+ [\d_]+;/,
    'MUX_IDLE_MS must stay derived from the ladder, not re-hardcoded',
  );
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

// The worker validates an inbound receipt against saved.ts's own bounds instead of
// re-spelling the numbers. Asserted through the real message path, so a re-hardcoded
// literal that disagrees with the exported bound cannot satisfy it.
test('an inbound receipt is bounded by saved.ts\'s limits, not by re-spelled literals', async () => {
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');
  const tabId = 900_003;
  const sendReceipt = (receipt: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve) => {
      const handled = onMessage!(
        {
          type: 'FACESCRAP_DOWNLOAD_DIRECT',
          tabId,
          url: 'https://video-abc.xx.fbcdn.net/v/t42/bounds.mp4',
          filename: 'bounds.mp4',
          receipt,
        },
        {} as Sender,
        resolve,
      );
      assert.equal(handled, true);
    });
  const base = { kind: 'video', source: 'reel', savedAt: 0 };

  // One char past the bound is refused outright: a TRUNCATED receipt id could never
  // re-link to its live card, so accepting it would be worse than rejecting it.
  assert.deepEqual(await sendReceipt({ ...base, id: `v:${'a'.repeat(SAVED_ID_MAX - 1)}` }), {
    ok: false,
    error: 'Invalid download request.',
  });

  // Exactly at the bound it lands, and the display fields are clamped on the way in.
  const id = `v:${'a'.repeat(SAVED_ID_MAX - 2)}`;
  assert.deepEqual(
    await sendReceipt({
      ...base,
      id,
      resLabel: 'x'.repeat(SAVED_LABEL_MAX + 8),
      thumbUrl: `https://scontent.xx.fbcdn.net/${'t'.repeat(SAVED_THUMB_MAX)}.jpg`,
    }),
    { ok: true },
  );
  const stored = (await getSaved(tabId)).find((e) => e.id === id);
  assert.ok(stored, 'the receipt at the id bound must reach the ledger');
  assert.equal(stored.id.length, SAVED_ID_MAX);
  assert.equal(stored.resLabel?.length, SAVED_LABEL_MAX);
  assert.equal(stored.thumbUrl, undefined, 'an over-long thumb URL is dropped, not stored');
});
