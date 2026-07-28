// An offscreen document gets chrome.runtime. It does NOT get chrome.storage.
//
// Measured, not assumed: `typeof chrome.storage` inside a live offscreen document
// on Edge 150 is 'undefined'. That makes any chrome.storage reference at module
// scope a TypeError while the script is still evaluating — and the mux listener is
// registered at the BOTTOM of that script, so it never registers at all. The worker
// then sends FACESCRAP_MUX to a document with no receiver: with a side panel open
// another context answers nothing, sendMessage resolves undefined in ~1ms, and every
// HD download fails with the generic "Could not merge audio and video." A whole
// download path, silently dead, with no counter for it.
//
// This test evaluates the real module against a chrome that has exactly what an
// offscreen document has, and asserts the mux listener survives.

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

  // `true` is what keeps the message channel open for the async answer. Without a
  // registered listener the worker's sendMessage resolves undefined instead, which
  // is exactly how this failed in production.
  assert.equal(handled, true, 'FACESCRAP_MUX must be claimed by the offscreen listener');
  assert.equal(answered, undefined, 'the answer is asynchronous, so nothing is sent back synchronously');
});
