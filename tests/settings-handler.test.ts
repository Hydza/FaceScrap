import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import {
  createSettingsMessageHandler,
  createSettingsPatchWriter,
  loadSettings,
  saveSettings,
  type SettingsStorageArea,
} from '../src/shared/settings';
import type { SettingsUpdateAck, SettingsUpdateMsg } from '../src/shared/messages';

const EXTENSION_ID = 'facescrap-test';
const extensionRuntime = {
  id: EXTENSION_ID,
  getURL: (path: string): string => `chrome-extension://${EXTENSION_ID}/${path}`,
};
const extensionSender = {
  id: EXTENSION_ID,
  url: extensionRuntime.getURL('sidepanel/sidepanel.html'),
} as chrome.runtime.MessageSender;

beforeEach(resetChromeStorage);

function sendSettingsMessage(
  handler: ReturnType<typeof createSettingsMessageHandler>,
  message: SettingsUpdateMsg,
  sender: chrome.runtime.MessageSender = extensionSender,
): Promise<SettingsUpdateAck> {
  return new Promise((resolve) => {
    assert.equal(handler(message, sender, resolve), true);
  });
}

test('saveSettings brokers an extension-page patch through the service worker', async () => {
  const mutableChrome = chrome as unknown as { runtime?: unknown };
  const originalRuntime = mutableChrome.runtime;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const messages: unknown[] = [];
  mutableChrome.runtime = {
    ...extensionRuntime,
    async sendMessage(message: unknown): Promise<SettingsUpdateAck> {
      messages.push(structuredClone(message));
      return { ok: true };
    },
  };
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: extensionRuntime.getURL('sidepanel/sidepanel.html') },
  });

  try {
    await saveSettings({ maxItems: 237 });

    assert.deepEqual(messages, [{ type: 'FACESCRAP_UPDATE_SETTINGS', patch: { maxItems: 237 } }]);
    assert.notEqual((await loadSettings()).maxItems, 237, 'the client must not also write storage directly');
  } finally {
    if (originalRuntime === undefined) delete mutableChrome.runtime;
    else mutableChrome.runtime = originalRuntime;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});

test('saveSettings falls back when a legacy worker has no settings receiver', async () => {
  const mutableChrome = chrome as unknown as { runtime?: unknown };
  const originalRuntime = mutableChrome.runtime;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  mutableChrome.runtime = {
    ...extensionRuntime,
    async sendMessage(): Promise<undefined> {
      return undefined;
    },
  };
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: extensionRuntime.getURL('sidepanel/sidepanel.html') },
  });

  try {
    await saveSettings({ maxItems: 321 });
    assert.equal((await loadSettings()).maxItems, 321);
  } finally {
    if (originalRuntime === undefined) delete mutableChrome.runtime;
    else mutableChrome.runtime = originalRuntime;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});

test('saveSettings never bypasses an explicit worker rejection', async () => {
  const mutableChrome = chrome as unknown as { runtime?: unknown };
  const originalRuntime = mutableChrome.runtime;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  mutableChrome.runtime = {
    ...extensionRuntime,
    async sendMessage(): Promise<SettingsUpdateAck> {
      return { ok: false, error: 'Unauthorized request.' };
    },
  };
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { href: extensionRuntime.getURL('sidepanel/sidepanel.html') },
  });

  try {
    await assert.rejects(saveSettings({ maxItems: 999 }), /Unauthorized request/);
    assert.notEqual((await loadSettings()).maxItems, 999);
  } finally {
    if (originalRuntime === undefined) delete mutableChrome.runtime;
    else mutableChrome.runtime = originalRuntime;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});

test('the worker broker serializes patches from independent extension pages', async () => {
  let stored: Record<string, unknown> = {};
  const storage: SettingsStorageArea = {
    async get(key) {
      await Promise.resolve();
      return key in stored ? { [key]: structuredClone(stored[key]) } : {};
    },
    async set(values) {
      await Promise.resolve();
      stored = { ...stored, ...structuredClone(values) };
    },
  };
  const writePatch = createSettingsPatchWriter(storage);
  const handler = createSettingsMessageHandler(writePatch, extensionRuntime);

  const [maxItemsAck, confirmClearAck] = await Promise.all([
    sendSettingsMessage(handler, {
      type: 'FACESCRAP_UPDATE_SETTINGS',
      patch: { maxItems: 237 },
    }),
    sendSettingsMessage(handler, {
      type: 'FACESCRAP_UPDATE_SETTINGS',
      patch: { confirmClear: true },
    }),
  ]);

  assert.deepEqual(maxItemsAck, { ok: true });
  assert.deepEqual(confirmClearAck, { ok: true });
  assert.deepEqual(
    {
      maxItems: (stored.settings as { maxItems: number }).maxItems,
      confirmClear: (stored.settings as { confirmClear: boolean }).confirmClear,
    },
    { maxItems: 237, confirmClear: true },
  );
});

test('a storage read failure never overwrites preferences with defaults', async () => {
  let writes = 0;
  const writePatch = createSettingsPatchWriter({
    async get() {
      throw new Error('temporary read failure');
    },
    async set() {
      writes += 1;
    },
  });

  await assert.rejects(writePatch({ theme: 'light' }), /temporary read failure/);
  assert.equal(writes, 0);
});

test('the worker broker rejects content-script and foreign-extension senders', async () => {
  let writes = 0;
  const handler = createSettingsMessageHandler(
    async () => {
      writes += 1;
      return await loadSettings();
    },
    extensionRuntime,
  );
  const message: SettingsUpdateMsg = {
    type: 'FACESCRAP_UPDATE_SETTINGS',
    patch: { theme: 'light' },
  };

  const contentAck = await sendSettingsMessage(handler, message, {
    id: EXTENSION_ID,
    url: 'https://www.facebook.com/reel/42',
    tab: { id: 42 } as chrome.tabs.Tab,
  });
  const foreignAck = await sendSettingsMessage(handler, message, {
    id: 'another-extension',
    url: 'chrome-extension://another-extension/sidepanel.html',
  });

  assert.equal(writes, 0);
  assert.deepEqual(contentAck, { ok: false, error: 'Unauthorized request.' });
  assert.deepEqual(foreignAck, { ok: false, error: 'Unauthorized request.' });
});

test('the worker broker accepts its own extension page when QA opens it in a tab', async () => {
  let receivedPatch: unknown;
  const handler = createSettingsMessageHandler(
    async (patch) => {
      receivedPatch = patch;
      return await loadSettings();
    },
    extensionRuntime,
  );

  const ack = await sendSettingsMessage(
    handler,
    { type: 'FACESCRAP_UPDATE_SETTINGS', patch: { theme: 'dark' } },
    {
      ...extensionSender,
      tab: { id: 99 } as chrome.tabs.Tab,
    },
  );

  assert.deepEqual(ack, { ok: true });
  assert.deepEqual(receivedPatch, { theme: 'dark' });
});
