// Verify that the worker gates the in-page button without disabling the keyboard shortcut.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { makeItem } from '../src/shared/media';

const TAB = 77_301;
const VIDEO_URL =
  'https://scontent.xx.fbcdn.net/v/t42.1790-2/reel.mp4?efg=eyJ2ZW5jb2RlX3RhZyI6InQifQ&bitrate=800000';

type Handler = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => true | undefined;

/** Create a handler for a live Facebook tab with inert receipt writes. */
async function handlerUnderTest(): Promise<Handler> {
  const { createPlayingDownloadHandler } = await import('../src/background/playing-download');
  return createPlayingDownloadHandler({
    isDead: () => false,
    isFacebookUrl: () => true,
    persistReceipt: async () => {},
  });
}

/** Return the label-only reply consumed by the overlay. */
interface Reply {
  ok?: boolean;
  error?: string;
  media?: { kind: string; labels: string[] };
}

/** Send one request and await the handler reply. */
function ask(handler: Handler, type: string): Promise<Reply> {
  return new Promise((resolve) => {
    handler(
      { type },
      { tab: { id: TAB, url: 'https://www.facebook.com/reel/1' } } as chrome.runtime.MessageSender,
      (response) => resolve(response as Reply),
    );
  });
}

/** Seed one downloadable reel for a tab. */
async function seedPlayingReel(): Promise<void> {
  const { addMedia, setPlaying } = await import('../src/shared/storage');
  const now = Date.now();
  const item = makeItem(VIDEO_URL, 'video', 'reel', 'dom', now);
  await addMedia(TAB, [item]);
  await setPlaying(TAB, { ids: [item.id], hasVideo: true, at: now }, now);
}

async function setInPageButton(on: boolean): Promise<void> {
  const { normalizeSettings } = await import('../src/shared/settings');
  await chrome.storage.local.set({ settings: normalizeSettings({ inPageButton: on }) });
}

test('the button is offered by default, and the switch takes it away', async () => {
  await resetChromeStorage();
  try {
    const handler = await handlerUnderTest();
    await seedPlayingReel();

    // The enabled default exposes the reel to the button.
    await setInPageButton(true);
    const offered = await ask(handler, 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS');
    assert.equal(offered.ok, true);
    assert.ok(offered.media, 'a downloadable reel must be offered while the button is on');
    assert.equal(offered.media.kind, 'video');
    assert.ok(Array.isArray(offered.media.labels) && offered.media.labels.length > 0);

    // The disabled setting hides the same stored reel from the overlay.
    await setInPageButton(false);
    const withheld = await ask(handler, 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS');
    assert.deepEqual(withheld, { ok: true, media: undefined });
  } finally {
    await resetChromeStorage();
  }
});

test('turning the button off leaves the global shortcut working', async () => {
  await resetChromeStorage();
  try {
    const handler = await handlerUnderTest();
    await seedPlayingReel();
    await setInPageButton(false);

    // The keyboard shortcut must still resolve the reel.
    const answer = await ask(handler, 'FACESCRAP_REQUEST_PLAYING_DOWNLOAD');
    assert.notEqual(
      answer?.error,
      'Nothing downloadable is playing.',
      'the shortcut must not be gated by the in-page button switch',
    );
  } finally {
    await resetChromeStorage();
  }
});

test('a corrupt stored value leaves the button on rather than silently gone', async () => {
  const { normalizeSettings, DEFAULT_SETTINGS } = await import('../src/shared/settings');
  assert.equal(DEFAULT_SETTINGS.inPageButton, true);
  for (const bad of [undefined, null, 'false', 0, 1, {}]) {
    assert.equal(
      normalizeSettings({ inPageButton: bad }).inPageButton,
      true,
      `${JSON.stringify(bad)} must not read as "off"`,
    );
  }
  // Only the boolean value `false` disables the feature.
  assert.equal(normalizeSettings({ inPageButton: false }).inPageButton, false);
});
