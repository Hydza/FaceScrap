// Repeated writes at capacity trim below the limit to avoid a full retention scan per batch.
// The first batch that crosses the limit still trims to the exact configured cap.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import type { MediaItem } from '../src/shared/media';
import { saveSettings } from '../src/shared/settings';

function image(index: number): MediaItem {
  return {
    id: `hysteresis-image-${index}`,
    url: `https://scontent.xx.fbcdn.net/v/t39.30808-6/hysteresis-${index}.jpg`,
    kind: 'image',
    source: 'story',
    origin: 'graphql',
    addedAt: 1_800_000_000_000 + index,
  };
}

test('addMedia evicts a hysteresis margin below the cap once a tab is already at capacity', async () => {
  await resetChromeStorage();
  // maxItems: 100 -> hysteresis = min(50, floor(100 / 10)) = 10, so trimming
  // once at capacity should land at 90, not 100.
  await saveSettings({ maxItems: 100 });

  const { addMedia, getMedia } = await import('../src/shared/storage');
  // Let storage.ts's module-load refreshFromSettings() promise resolve before
  // relying on the custom cap (see tests/max-items-retention.test.ts for the
  // same pattern).
  await new Promise<void>((resolve) => setImmediate(resolve));

  const tabId = 94_000;

  // Filling exactly to the cap does not trigger eviction.
  await addMedia(tabId, Array.from({ length: 100 }, (_value, index) => image(index)));
  assert.equal((await getMedia(tabId)).length, 100);

  // One more item at the cap must trigger eviction below the cap.
  await addMedia(tabId, [image(1_000)]);
  assert.equal(
    (await getMedia(tabId)).length,
    90,
    'reverted (exact-cap) behaviour would leave exactly 100 here; the fix must evict a hysteresis margin further',
  );

  // Consuming that headroom one item at a time must never re-trigger
  // eviction: each addition should grow the stored count by exactly one, all
  // the way back up to the cap.
  for (let index = 0; index < 10; index++) {
    await addMedia(tabId, [image(2_000 + index)]);
    assert.equal(
      (await getMedia(tabId)).length,
      91 + index,
      `unexpected eviction while refilling the hysteresis headroom (step ${index})`,
    );
  }
  assert.equal((await getMedia(tabId)).length, 100);

  // The item that finally exceeds the cap again must re-trigger eviction, back
  // down to the same trimmed floor — proving the margin is spent every time
  // the tab is caught at/over capacity, not just once.
  await addMedia(tabId, [image(3_000)]);
  assert.equal((await getMedia(tabId)).length, 90);
});

test('addMedia still trims to exactly the cap the first time a batch crosses it', async () => {
  await resetChromeStorage();
  await saveSettings({ maxItems: 100 });

  const { addMedia, getMedia } = await import('../src/shared/storage');
  await new Promise<void>((resolve) => setImmediate(resolve));

  const tabId = 94_001;

  // A batch that crosses the cap from below trims to the cap without hysteresis.
  await addMedia(tabId, Array.from({ length: 105 }, (_value, index) => image(index)));
  assert.equal((await getMedia(tabId)).length, 100);
});
