// The "button on the video" switch, driven through the handler that actually answers it.
//
// The gate lives in the worker, not in the content script, for the same reason every other
// "what can this tab download" question does: the overlay decides nothing, it asks. So the
// switch is only real if the OPTIONS reply changes — and this drives the real handler against
// real stored state rather than reading the source for an `if`.
//
// The second half matters as much as the first. FACESCRAP_REQUEST_PLAYING_DOWNLOAD is shared
// with the global keyboard shortcut, which is configured separately in
// chrome://extensions/shortcuts. Gating that path too would have made a UI switch silently
// disable a shortcut the user set up somewhere else entirely.

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

/** The handler with its three injected dependencies stubbed to the harmless answers: the tab is
 *  alive, it is a Facebook tab, and a receipt write is a no-op. */
async function handlerUnderTest(): Promise<Handler> {
  const { createPlayingDownloadHandler } = await import('../src/background/playing-download');
  return createPlayingDownloadHandler({
    isDead: () => false,
    isFacebookUrl: () => true,
    persistReceipt: async () => {},
  });
}

/** The reply shape the overlay reads: labels only, never a URL. */
interface Reply {
  ok?: boolean;
  error?: string;
  media?: { kind: string; labels: string[] };
}

/** Ask the handler one question and wait for its asynchronous reply. */
function ask(handler: Handler, type: string): Promise<Reply> {
  return new Promise((resolve) => {
    handler(
      { type },
      { tab: { id: TAB, url: 'https://www.facebook.com/reel/1' } } as chrome.runtime.MessageSender,
      (response) => resolve(response as Reply),
    );
  });
}

/** A tab that is watching one downloadable reel. */
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

    // Default on: the reel resolves to something the button can offer.
    await setInPageButton(true);
    const offered = await ask(handler, 'FACESCRAP_PLAYING_DOWNLOAD_OPTIONS');
    assert.equal(offered.ok, true);
    assert.ok(offered.media, 'a downloadable reel must be offered while the button is on');
    assert.equal(offered.media.kind, 'video');
    assert.ok(Array.isArray(offered.media.labels) && offered.media.labels.length > 0);

    // Switched off: the same stored state, and the answer is "nothing". That is the reply the
    // overlay already handles by hiding, and it hides BEFORE build(), so nothing is injected.
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

    // The download request is the shortcut's path too, and it must still resolve the reel.
    // A refusal here would mean a switch in the panel had quietly disabled a shortcut set up
    // in chrome://extensions/shortcuts, with nothing on screen to explain why.
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
  // Only a real false turns it off.
  assert.equal(normalizeSettings({ inPageButton: false }).inPageButton, false);
});
