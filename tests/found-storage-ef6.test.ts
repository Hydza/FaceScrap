// Regression check for the storage-lane code-review finding EF6: addMedia's
// retention-cap eviction used to trim to EXACTLY maxItemsCache
// (`merged.splice(0, merged.length - maxItemsCache)`), so once a tab sat AT
// the cap, every later batch that added even a single new item satisfied
// `merged.length > maxItemsCache` again and re-ran partitionMediaForRetention
// (3 storage reads + an O(n) scan) from scratch.
//
// storage.ts now spends a small hysteresis margin BELOW the cap — but only
// once `stored.length` (the durable count before the batch) was already at or
// over the cap. A batch that crosses the cap for the FIRST time still trims to
// exactly maxItemsCache, unchanged — this is what keeps unrelated exact-
// boundary tests elsewhere (e.g. tests/now-playing.test.ts's single-shot
// "1500 later captures" scenarios) passing without being touched.
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

  // Fill to exactly the cap without ever exceeding it: 100 is not > 100, so no
  // eviction runs here regardless of the fix.
  await addMedia(tabId, Array.from({ length: 100 }, (_value, index) => image(index)));
  assert.equal((await getMedia(tabId)).length, 100);

  // The tab is now AT the cap. One more item must trigger eviction — and the
  // fix requires landing BELOW the cap instead of exactly at it.
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

  // A single batch jumping straight from empty to over the cap is a FIRST
  // crossing (stored.length was 0, well under the cap) — no hysteresis
  // margin applies, matching the pre-fix exact-cap behaviour that
  // tests/now-playing.test.ts's boundary tests rely on.
  await addMedia(tabId, Array.from({ length: 105 }, (_value, index) => image(index)));
  assert.equal((await getMedia(tabId)).length, 100);
});
