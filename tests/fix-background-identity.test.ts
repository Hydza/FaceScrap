import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';

// service-worker.ts registers every listener as a side effect of module
// evaluation (it has no exports), so exercising a fix inside it means booting
// a wider slice of chrome.* than the storage-only fake most suites need.
// chrome.storage/onChanged stay chrome-fake's real in-memory implementation;
// everything added below is a capture-only stub — each addListener just
// remembers the callback (or discards it, for listeners these tests never
// fire) rather than emulating Chrome's behaviour.
type Sender = chrome.runtime.MessageSender;
type SendResponse = (response?: unknown) => void;
type OnMessageListener = (message: unknown, sender: Sender, sendResponse: SendResponse) => boolean | undefined;
interface FakeRequestDetails {
  tabId: number;
  frameId: number;
  documentId?: string;
  type: string;
  url: string;
}
type OnBeforeRequestListener = (details: FakeRequestDetails) => void;

let onMessage: OnMessageListener | undefined;
let onBeforeRequest: OnBeforeRequestListener | undefined;

function installBackgroundChromeFake(): void {
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
  c.webRequest = {
    onBeforeRequest: {
      addListener(fn: OnBeforeRequestListener) {
        onBeforeRequest = fn;
      },
    },
  };
  c.webNavigation = {
    onBeforeNavigate: { addListener() {} },
    onCommitted: { addListener() {} },
    onErrorOccurred: { addListener() {} },
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
  };
}

await resetChromeStorage();
installBackgroundChromeFake();
// No exports to bind — importing it only for the chrome.* listeners it
// registers as a side effect, captured by the fake installed just above.
await import('../src/background/service-worker');

function captured(): { sendResponse: SendResponse; response: Promise<unknown> } {
  let resolve!: (value: unknown) => void;
  const response = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { sendResponse: (value) => resolve(value), response };
}

let nextTab = 800_001;

test('A1: a subframe fbcdn media request cannot claim the tab identity and lock out the real top-level document', async () => {
  const tabId = nextTab++;
  assert.ok(onBeforeRequest, 'webRequest.onBeforeRequest listener was not registered');
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');

  // An ad/tracking iframe embedded in the tab fetches an fbcdn media URL —
  // e.g. right after a service-worker restart, before any top-level
  // content-script message has re-established the tab's identity.
  onBeforeRequest!({
    tabId,
    frameId: 4,
    documentId: 'subframe-doc',
    type: 'media',
    url: 'https://scontent.xx.fbcdn.net/v/t42/reel.mp4',
  });

  // The real top-level content script then reports its theme, under its own
  // (different) documentId. This must succeed: the subframe request above
  // must never have been allowed to claim the tab first.
  const { sendResponse, response } = captured();
  const sender: Sender = {
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId: 0,
    documentLifecycle: 'active',
    documentId: 'top-doc',
  };
  const handled = onMessage!({ type: 'FACEBOOK_THEME', theme: 'dark', at: Date.now() }, sender, sendResponse);

  assert.equal(handled, true);
  assert.deepEqual(await response, { ok: true });
});

test('C1: a prerendering content-script sender is not permanently rejected', async () => {
  const tabId = nextTab++;
  const { sendResponse, response } = captured();
  const sender: Sender = {
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId: 0,
    documentLifecycle: 'prerender',
    documentId: 'prerender-doc',
  };

  const handled = onMessage!({ type: 'FACEBOOK_THEME', theme: 'light', at: Date.now() }, sender, sendResponse);

  assert.equal(handled, true);
  assert.deepEqual(await response, { ok: true });
});

test('S4: NOW_PLAYING answers ok:true (not a permanent failure) for a stale tab epoch, matching FACEBOOK_THEME/MEDIA_FOUND', async () => {
  const tabId = nextTab++;
  const sender: Sender = {
    tab: { id: tabId } as chrome.tabs.Tab,
    frameId: 0,
    documentLifecycle: 'active',
    documentId: 'now-playing-doc',
  };
  const nowPlaying = captured();
  const handled = onMessage!(
    { type: 'NOW_PLAYING', ids: ['m1'], hasVideo: true, mark: 'vm:1', detectedAt: Date.now() },
    sender,
    nowPlaying.sendResponse,
  );
  assert.equal(handled, true);

  // Synchronously — before the pending call above can resume past its
  // `await ready` — an extension page clears the same tab, which bumps its
  // tabLifecycle epoch. That is exactly the race that produces
  // StaleTabEpochError for the still-pending NOW_PLAYING write.
  const clearAck = captured();
  const clearHandled = onMessage!({ type: 'FACESCRAP_CLEAR_TAB', tabId }, {}, clearAck.sendResponse);
  assert.equal(clearHandled, true);

  assert.deepEqual(await nowPlaying.response, { ok: true });
  await clearAck.response;
});
