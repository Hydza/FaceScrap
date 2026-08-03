// Retention, panel selection, and in-page controls must match active media identically.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { mediaId, type MediaItem } from '../src/shared/media';
import { saveSettings } from '../src/shared/settings';

// Use a redirector identity whose canonical form ignores rotating signatures.
const WATCHED_URL =
  'https://external.xx.fbcdn.net/safe_image.php?' +
  'url=https%3A%2F%2Fexample.com%2Fwatched.jpg&oh=rotating-signature&oe=1';
// Represent the same photo with its query-based alias.
const PRE_CANONICAL_REF_ID =
  'asset:/safe_image.php?oe=1&oh=rotating-signature&' +
  'url=https%3A%2F%2Fexample.com%2Fwatched.jpg';

function filler(index: number): MediaItem {
  return {
    id: `filler-${index}`,
    url: `https://scontent.xx.fbcdn.net/v/t39.30808-6/filler-${index}.jpg`,
    kind: 'image',
    source: 'story',
    origin: 'graphql',
    addedAt: 1_800_000_000_000 + index,
  };
}

test('a pre-canonicalization PlayingRef id protects its row from the maxItems cap', async () => {
  await resetChromeStorage();
  await saveSettings({ maxItems: 3 });

  // Import storage after writing the cap because the module reads it once.
  const { addMedia, getMedia, setPlaying } = await import('../src/shared/storage');
  const { purgeTabBindings, selectPlaying } = await import('../src/shared/now-playing');
  await new Promise<void>((resolve) => setImmediate(resolve));

  const tabId = 91_500;
  const watched: MediaItem = {
    id: mediaId(WATCHED_URL),
    url: WATCHED_URL,
    kind: 'image',
    source: 'story',
    origin: 'graphql',
    addedAt: 1_800_000_000_000,
  };

  try {
    await addMedia(tabId, [watched]);
    await setPlaying(tabId, { ids: [PRE_CANONICAL_REF_ID], hasVideo: false, at: 1_800_000_000_100 });

    // The panel canonicalizes the stored ID before matching.
    assert.deepEqual(
      (await selectPlaying(tabId, await getMedia(tabId))).map((item) => item.url),
      [WATCHED_URL],
      'the selection matcher must still resolve the older id spelling',
    );

    // Evict ordinary rows while retaining the active photo at the cap.
    await addMedia(tabId, [filler(1), filler(2), filler(3), filler(4), filler(5)]);
    const kept = (await getMedia(tabId)).map((item) => item.url);
    assert.equal(kept.length, 3);
    assert.ok(
      kept.includes(WATCHED_URL),
      `retention evicted the row the panel is displaying as playing: ${kept.join(', ')}`,
    );
  } finally {
    purgeTabBindings(tabId);
    await resetChromeStorage();
  }
});
