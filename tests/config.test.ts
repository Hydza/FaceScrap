import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DASH_UI_HARD_CAP_MS, MUX_HARD_CAP_MS, SETTLE_CAP_MS } from '../src/shared/messages';
import { dashDownloadKey } from '../src/shared/download-settlement';
import { ATTEMPTS, RETRY_DELAY_MS, STALL_MS, WORST_CASE_SILENCE_MS } from '../src/shared/track-fetch';
import { getSaved, SAVED_ID_MAX, SAVED_LABEL_MAX, SAVED_THUMB_MAX } from '../src/shared/saved';
import { resetChromeStorage } from './chrome-fake';

// Test bundles run from a temporary directory with the repository as their working directory.
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(process.cwd(), rel), 'utf8'));
const readSrc = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8');

test('package.json declares the Node engine the toolchain actually targets', () => {
  const pkg = readJson('package.json') as { engines?: { node?: string } };
  const floor = /^>=(\d+)/.exec(pkg.engines?.node ?? '');
  assert.ok(floor, 'a from-source builder on old Node gets no guidance without a ">=N" engines field');
  // Keep the declared runtime floor aligned with the bundle target.
  const target = /target: 'node(\d+)'/.exec(readSrc('scripts/test.mjs'));
  assert.ok(target, 'scripts/test.mjs must keep declaring its esbuild Node target');
  assert.equal(Number(floor[1]), Number(target[1]), 'engines.node and the esbuild target must name the same Node');
});

test('the manifest and package.json ship one version', () => {
  const pkg = readJson('package.json') as { version?: string };
  const manifest = readJson('manifest.json') as { version?: string };
  // Package metadata and extension metadata must identify the same release.
  assert.match(String(pkg.version), /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
});

test('DASH_UI_HARD_CAP_MS is derived strictly above one full worker job worst case', () => {
  // The panel must outwait the worker's complete mux and settlement budget.
  assert.ok(DASH_UI_HARD_CAP_MS > MUX_HARD_CAP_MS + SETTLE_CAP_MS);
});

test('the mux idle window is derived above track-fetch\'s full retry-ladder worst case', () => {
  // The mux idle window must cover the complete retry ladder plus its margin.
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

// Capture the worker's message listener with a minimal runtime stub.
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
  // Complete each download immediately so tests can isolate receipt failures.
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
    // Expose offscreen support without starting a mux operation.
    getContexts: async () => [],
    ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
  };
  c.offscreen = { createDocument: async () => {}, Reason: { BLOBS: 'BLOBS' } };
}

await resetChromeStorage();
installDownloadChromeFake();
// Import the worker to register its message listener.
await import('../src/background/service-worker');

test('C7: a Saved-receipt write failure after a successful download reports ok:true, not a failed download', async () => {
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');
  const tabId = 900_001;
  const receipt = { id: 'v:c7-test', kind: 'video', source: 'reel', savedAt: 0 };

  // Fail only the receipt write while preserving all other storage behavior.
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
  // Seed a durable completion so the request must bypass the mux path.
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
  // Report the successful deduplication without writing another receipt.
  assert.deepEqual(response, { ok: true, deduped: true });
});

// A deduplicated in-page download must not create another saved receipt.
test('C1: a deduped in-page download writes no Saved receipt', async () => {
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');
  const { addMedia, getMedia, setPlaying } = await import('../src/shared/storage');
  const { makeItem, videoGroupKey } = await import('../src/shared/media');
  const { downloadFilename, videoCardId } = await import('../src/shared/download-naming');
  const { loadSettings } = await import('../src/shared/settings');

  const tabId = 900_010;
  const now = Date.now();
  const seed = makeItem('https://video-abc.xx.fbcdn.net/v/t42/c1_hd.mp4?bitrate=900000', 'video', 'reel', 'graphql', now, true);
  seed.height = 1080;
  seed.audioUrl = 'https://video-abc.xx.fbcdn.net/v/t42/c1_audio.mp4';
  await addMedia(tabId, [seed]);
  await setPlaying(tabId, { ids: [seed.id], hasVideo: true, at: now }, now);

  // Build the completion key from the same stored item and settings as the handler.
  const [stored] = await getMedia(tabId);
  assert.ok(stored, 'the seeded representation must read back');
  const settings = await loadSettings();
  await chrome.storage.session.set({
    dash_dedup_completed_v1: {
      [dashDownloadKey({
        tabId,
        receiptId: videoCardId(videoGroupKey(stored)),
        videoUrl: stored.url,
        audioUrl: stored.audioUrl!,
        filename: downloadFilename(stored, settings),
        saveAs: settings.defaultQuality === 'ask',
      })]: now - 1_000,
    },
  });

  const answer = await new Promise<unknown>((resolve) => {
    const handled = onMessage!(
      { type: 'FACESCRAP_REQUEST_PLAYING_DOWNLOAD' },
      { tab: { id: tabId, url: 'https://www.facebook.com/reel/1' } } as Sender,
      resolve,
    );
    assert.equal(handled, true);
  });

  // The flag confirms that the request reached the deduplication path.
  assert.deepEqual(answer, { ok: true, deduped: true });
  assert.deepEqual(await getSaved(tabId), [], 'a call that wrote no file must write no receipt');
});

// Validate inbound receipts through the worker against the shared storage limits.
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

  // Reject IDs above the bound because truncation would break card identity.
  assert.deepEqual(await sendReceipt({ ...base, id: `v:${'a'.repeat(SAVED_ID_MAX - 1)}` }), {
    ok: false,
    error: 'Invalid download request.',
  });

  // Accept an ID at the bound and clamp optional display fields.
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
