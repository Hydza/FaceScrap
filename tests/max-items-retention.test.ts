import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import type { MediaItem } from '../src/shared/media';
import { saveSettings } from '../src/shared/settings';

function image(index: number): MediaItem {
  return {
    id: `image-${index}`,
    url: `https://scontent.xx.fbcdn.net/v/t39.30808-6/image-${index}.jpg`,
    kind: 'image',
    source: 'story',
    origin: 'graphql',
    addedAt: 1_800_000_000_000 + index,
  };
}

test('addMedia enforces a persisted custom maxItems limit', async () => {
  await resetChromeStorage();
  await saveSettings({ maxItems: 3 });

  const { addMedia, getMedia } = await import('../src/shared/storage');
  await new Promise<void>((resolve) => setImmediate(resolve));

  const tabId = 91_000;
  await addMedia(tabId, [image(0), image(1), image(2), image(3), image(4)]);

  assert.deepEqual(
    (await getMedia(tabId)).map((item) => item.url),
    [image(2).url, image(3).url, image(4).url],
  );
});
