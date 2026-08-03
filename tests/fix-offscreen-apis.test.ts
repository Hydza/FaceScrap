// Offscreen documents expose chrome.runtime but not chrome.storage. Evaluate the
// real module against that API surface and verify that it registers the mux listener.

import assert from 'node:assert/strict';
import test from 'node:test';

interface FakeListener {
  (message: unknown, sender: unknown, sendResponse: (response: unknown) => void): boolean | undefined;
}

/** chrome as an offscreen document actually sees it: runtime only. */
function offscreenChrome(): { listeners: FakeListener[]; api: unknown } {
  const listeners: FakeListener[] = [];
  return {
    listeners,
    api: {
      runtime: {
        id: 'facescrap-test',
        onMessage: { addListener: (fn: FakeListener) => listeners.push(fn) },
        onConnect: { addListener: () => {} },
        connect: () => ({ postMessage: () => {}, disconnect: () => {} }),
        sendMessage: async () => undefined,
        getURL: (path: string) => `chrome-extension://test/${path}`,
      },
      // Deliberately absent: storage, downloads, tabs, offscreen, action.
    },
  };
}

test('the offscreen document registers its mux listener with only chrome.runtime available', async () => {
  const fake = offscreenChrome();
  (globalThis as { chrome?: unknown }).chrome = fake.api;

  // Imported here, not at the top of the file: the module registers its listeners
  // as a side effect of evaluation, which is the thing under test.
  await import('../src/offscreen/offscreen');

  assert.ok(fake.listeners.length > 0, 'evaluating the offscreen module registered no message listener at all');

  let answered: unknown;
  const handled = fake.listeners[0]!(
    { type: 'FACESCRAP_MUX', videoUrl: 'https://x.fbcdn.net/v.mp4', audioUrl: 'https://x.fbcdn.net/a.mp4' },
    {},
    (response) => {
      answered = response;
    },
  );

  // `true` keeps the message channel open for the asynchronous response and confirms
  // that the listener is registered.
  assert.equal(handled, true, 'FACESCRAP_MUX must be claimed by the offscreen listener');
  assert.equal(answered, undefined, 'the answer is asynchronous, so nothing is sent back synchronously');
});
