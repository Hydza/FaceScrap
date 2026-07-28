// The global shortcut's wiring: which tab it acts on, and what it reports back.
//
// The handler used to be inline at the worker's module scope, where testing it meant evaluating
// the whole service worker. Its own logic needs no browser — it picks the active tab, hands it to
// the already-tested in-page download handler, and tells the tab the outcome.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createShortcutHandler, DOWNLOAD_PLAYING_COMMAND } from '../src/background/shortcut-download';

interface Recorded {
  senders: unknown[];
  reports: { tabId: number; ok: boolean }[];
  errors: (string | undefined)[];
}

function harness(answer: unknown, tab?: { id?: number; url?: string }) {
  const seen: Recorded = { senders: [], reports: [], errors: [] };
  const handler = createShortcutHandler({
    activeTab: async () => tab,
    run: (_message, sender, sendResponse) => {
      seen.senders.push(sender);
      sendResponse(answer);
    },
    report: (tabId, message) => seen.reports.push({ tabId, ok: message.ok }),
    onError: (error) => seen.errors.push(error),
  });
  return { handler, seen };
}

/** The handler starts an async chain and returns; let it settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('runs the download for the active tab and reports success to it', async () => {
  const { handler, seen } = harness({ ok: true }, { id: 4242, url: 'https://www.facebook.com/reel/1' });
  handler(DOWNLOAD_PLAYING_COMMAND);
  await settle();

  // The sender is synthesized from the tab, never from the message: that is what makes every
  // guard in the in-page handler apply to the shortcut too.
  assert.deepEqual(seen.senders, [{ tab: { id: 4242, url: 'https://www.facebook.com/reel/1' } }]);
  assert.deepEqual(seen.reports, [{ tabId: 4242, ok: true }]);
  assert.deepEqual(seen.errors, []);
});

test('reports a failure to the tab as well, and never silently', async () => {
  // Silence here is indistinguishable from a keypress that never arrived, which is why both the
  // tab and the console hear about it.
  const { handler, seen } = harness({ ok: false, error: 'Nothing downloadable is playing.' }, { id: 7 });
  handler(DOWNLOAD_PLAYING_COMMAND);
  await settle();

  assert.deepEqual(seen.reports, [{ tabId: 7, ok: false }]);
  assert.deepEqual(seen.errors, ['Nothing downloadable is playing.']);
});

test('treats a malformed or missing answer as a failure', async () => {
  for (const answer of [undefined, null, {}, { ok: 'yes' }, 'ok']) {
    const { handler, seen } = harness(answer, { id: 9 });
    handler(DOWNLOAD_PLAYING_COMMAND);
    await settle();
    assert.deepEqual(seen.reports, [{ tabId: 9, ok: false }], `${JSON.stringify(answer)} must not read as success`);
  }
});

test('does nothing at all without an active tab', async () => {
  for (const tab of [undefined, {}, { url: 'https://www.facebook.com/' }]) {
    const { handler, seen } = harness({ ok: true }, tab);
    handler(DOWNLOAD_PLAYING_COMMAND);
    await settle();
    assert.deepEqual(seen.senders, [], 'no tab id means no download');
    assert.deepEqual(seen.reports, []);
  }
});

test('ignores every other command name', async () => {
  const { handler, seen } = harness({ ok: true }, { id: 1 });
  for (const command of ['', 'download', 'DOWNLOAD-PLAYING', 'download-playing-2', '_execute_action']) {
    handler(command);
  }
  await settle();
  assert.deepEqual(seen.senders, [], 'only the declared command may act');
});
