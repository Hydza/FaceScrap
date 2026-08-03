// Set the constant badge color once per worker instance, independent of text updates.
// Capture Chrome API calls because the worker registers listeners during module evaluation.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';

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
let badgeColorCalls = 0;
let badgeTextCalls = 0;

function installChromeFake(): void {
  const c = chrome as unknown as Record<string, unknown>;
  c.action = {
    disable: async () => {},
    enable: async () => {},
    setPopup: async () => {},
    setTitle: async () => {},
    setBadgeText: async () => {
      badgeTextCalls++;
    },
    setBadgeBackgroundColor: async () => {
      badgeColorCalls++;
    },
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
installChromeFake();
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

test('EF8: setBadgeBackgroundColor runs once total, not once per setBadge call, across both its call sites', async () => {
  assert.ok(onBeforeRequest, 'webRequest.onBeforeRequest listener was not registered');
  assert.ok(onMessage, 'runtime.onMessage listener was not registered');

  // Module evaluation at import time already fired the one badge-color call
  // this worker instance will ever make.
  assert.equal(badgeColorCalls, 1, 'setBadgeBackgroundColor must run once at worker startup, before any setBadge call');
  const textCallsAtStart = badgeTextCalls;

  const tabA = 800_101;
  const tabB = 800_102;

  // Hot path 1: a classified fbcdn media webRequest.
  onBeforeRequest!({
    tabId: tabA,
    frameId: 0,
    documentId: 'doc-a',
    type: 'media',
    url: 'https://scontent.xx.fbcdn.net/v/t42/clip-ef8.mp4',
  });
  for (let i = 0; i < 50; i++) await Promise.resolve();

  // Hot path 2: a MEDIA_FOUND ack, from a different tab.
  const { sendResponse, response } = captured();
  const sender: Sender = {
    tab: { id: tabB } as chrome.tabs.Tab,
    frameId: 0,
    documentLifecycle: 'active',
    documentId: 'doc-b',
  };
  const handled = onMessage!({ type: 'MEDIA_FOUND', items: [], documentToken: 'token-b-ef8' }, sender, sendResponse);
  assert.equal(handled, true);
  assert.deepEqual(await response, { ok: true });

  assert.ok(badgeTextCalls > textCallsAtStart, 'setBadge must still have updated the badge text on both hot paths');
  assert.equal(
    badgeColorCalls,
    1,
    'setBadgeBackgroundColor must not run again for either later setBadge call',
  );
});
