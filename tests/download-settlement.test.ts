import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dashDownloadKey,
  DownloadInterruptedError,
  waitForDownloadSettlement,
  type DownloadSettlementApi,
} from '../src/shared/download-settlement';
import { createSuccessDeduper } from '../src/shared/success-deduper';

function fakeDownloads(initial: chrome.downloads.DownloadItem[] = []) {
  const listeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
  let items = initial;
  const cancelled: number[] = [];
  const api: DownloadSettlementApi = {
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    async search() {
      return items;
    },
    async cancel(id) {
      cancelled.push(id);
    },
  };
  return {
    api,
    listeners,
    cancelled,
    setItems(next: chrome.downloads.DownloadItem[]) {
      items = next;
    },
    emit(delta: chrome.downloads.DownloadDelta) {
      for (const listener of [...listeners]) listener(delta);
    },
  };
}

test('remains pending after enqueue and resolves only on matching complete', async () => {
  const fake = fakeDownloads();
  let completed = false;
  const pending = waitForDownloadSettlement(fake.api, 7).then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  fake.emit({ id: 8, state: { current: 'complete' } });
  fake.emit({ id: 7, state: { current: 'in_progress' } });
  assert.equal(completed, false);
  fake.emit({ id: 7, state: { current: 'complete' } });
  await pending;
  assert.equal(fake.listeners.size, 0);
});

test('rejects an interrupted download with the browser reason and cleans up', async () => {
  const fake = fakeDownloads();
  const pending = waitForDownloadSettlement(fake.api, 9);
  fake.emit({ id: 9, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof DownloadInterruptedError);
    assert.match(error.message, /USER_CANCELED/);
    return true;
  });
  assert.equal(fake.listeners.size, 0);
});

test('search closes the race when the terminal event happened before registration', async () => {
  const fake = fakeDownloads([{ id: 11, state: 'complete' } as chrome.downloads.DownloadItem]);
  await waitForDownloadSettlement(fake.api, 11);
  assert.equal(fake.listeners.size, 0);
});

test('a registration search that keeps failing settles with an error instead of hanging forever', async () => {
  const listeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
  const api: DownloadSettlementApi = {
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    // Always rejects and no onChanged delta is ever emitted below — the exact
    // shape of the race this backstop exists to close (terminal state reached
    // before the listener attached, so no further delta is coming) combined
    // with a backstop that cannot read it either. downloadDirect calls this
    // with no timeoutMs, so only this module's own give-up path can recover it.
    async search() {
      throw new Error('downloads.search unavailable');
    },
    async cancel() {},
  };
  await assert.rejects(waitForDownloadSettlement(api, 41), /Could not confirm/);
  assert.equal(listeners.size, 0);
});

test('a registration search that fails a few times still settles once it finds the terminal item', async () => {
  const listeners = new Set<(delta: chrome.downloads.DownloadDelta) => void>();
  let calls = 0;
  const api: DownloadSettlementApi = {
    onChanged: {
      addListener: (listener) => listeners.add(listener),
      removeListener: (listener) => listeners.delete(listener),
    },
    async search() {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return [{ id: 55, state: 'complete' } as chrome.downloads.DownloadItem];
    },
    async cancel() {},
  };
  // No onChanged emit at all: this only resolves if the retried search itself
  // is read, proving a transient failure does not permanently poison the race
  // check the way a single unretried failure did.
  await waitForDownloadSettlement(api, 55);
  assert.ok(calls >= 3, `expected at least 3 search attempts, got ${calls}`);
  assert.equal(listeners.size, 0);
});

test('timeout cancels an in-progress download before rejecting and removes the observer', async () => {
  const fake = fakeDownloads([{ id: 13, state: 'in_progress' } as chrome.downloads.DownloadItem]);
  await assert.rejects(
    waitForDownloadSettlement(fake.api, 13, { timeoutMs: 5, cancelOnTimeout: true }),
    /timed out/,
  );
  assert.deepEqual(fake.cancelled, [13]);
  assert.equal(fake.listeners.size, 0);
});

test('a timeout settles with the timeout reason even when cancel triggers an interrupted delta', async () => {
  const fake = fakeDownloads([{ id: 61, state: 'in_progress' } as chrome.downloads.DownloadItem]);
  const baseCancel = fake.api.cancel;
  fake.api.cancel = async (id) => {
    await baseCancel(id);
    // Mirrors real Chromium: cancelling an in-progress download fires its own
    // 'interrupted' onChanged delta while this settlement's cancel() await
    // (triggered by the timeout below) is still in flight.
    fake.emit({ id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
  };
  await assert.rejects(
    waitForDownloadSettlement(fake.api, 61, { timeoutMs: 5, cancelOnTimeout: true }),
    (error: unknown) => {
      assert.ok(!(error instanceof DownloadInterruptedError), 'must report the timeout, not the cancel it caused');
      assert.match((error as Error).message, /timed out/);
      return true;
    },
  );
  assert.deepEqual(fake.cancelled, [61]);
  assert.equal(fake.listeners.size, 0);
});

test('an interrupted first attempt does not poison a real retry', async () => {
  const fake = fakeDownloads();
  let enqueues = 0;
  const attempt = async (): Promise<void> => {
    const id = ++enqueues;
    const pending = waitForDownloadSettlement(fake.api, id);
    fake.emit({ id, state: { current: id === 1 ? 'interrupted' : 'complete' } });
    await pending;
  };

  await assert.rejects(attempt(), DownloadInterruptedError);
  await attempt();
  assert.equal(enqueues, 2);
  assert.equal(fake.listeners.size, 0);
});

test('DASH success dedup never aliases identical tracks across logical requests', async () => {
  const deduper = createSuccessDeduper(60_000, () => 1_000);
  const base = {
    tabId: 7,
    receiptId: 'v:card-a',
    videoUrl: 'https://video.xx.fbcdn.net/v/t42/video.mp4',
    audioUrl: 'https://video.xx.fbcdn.net/v/t42/audio.mp4',
    filename: 'FaceScrap-card-a.mp4',
    saveAs: false,
  };
  let enqueues = 0;
  const run = (request: typeof base): Promise<void> =>
    deduper.run(dashDownloadKey(request), async () => {
      enqueues += 1;
    });

  await run(base);
  await run({ ...base, tabId: 8, receiptId: 'v:card-b', filename: 'FaceScrap-card-b.mp4' });
  assert.equal(enqueues, 2, 'a different tab/card must enqueue its own download');

  await run({ ...base, tabId: 8, receiptId: 'v:card-b', filename: 'FaceScrap-card-b.mp4' });
  assert.equal(enqueues, 2, 'an identical logical retry remains deduplicated');

  await run({ ...base, saveAs: true });
  assert.equal(enqueues, 3, 'a different saveAs request must not reuse an earlier success');
});
