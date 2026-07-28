// Retention must protect exactly what the panel paints as playing.
//
// Three matchers pair with media.ts's matchesActiveMediaId, and they had drifted:
// the panel's selection (now-playing.ts's domMatchFresh) and the in-page button's
// pure read (video-options.ts's playingItems) re-canonicalized the ids a PlayingRef
// carries before matching; the retention classifier (storage.ts's isExactPlayingItem)
// did not. A ref left in chrome.storage.session by a build that used the short-lived
// full-query `asset:` scheme therefore selected a row in the panel that
// partitionMediaForRetention treated as ordinary — evictable while it was on screen.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { mediaId, type MediaItem } from '../src/shared/media';
import { saveSettings } from '../src/shared/settings';

// A generic redirector: the only id shape canonicalizeHistoricalMediaId can rewrite,
// because the current canonical form hashes the resource the proxy wraps instead of
// keeping the rotating oh/oe signature.
const WATCHED_URL =
  'https://external.xx.fbcdn.net/safe_image.php?' +
  'url=https%3A%2F%2Fexample.com%2Fwatched.jpg&oh=rotating-signature&oe=1';
// The same photo as an older build spelled it: whole sorted query, no resource hash.
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

  // Imported AFTER the settings write, like max-items-retention.test.ts: storage.ts
  // reads the cap once at module evaluation.
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

    // The panel paints it: the stored id is re-canonicalized before matching.
    assert.deepEqual(
      (await selectPlaying(tabId, await getMedia(tabId))).map((item) => item.url),
      [WATCHED_URL],
      'the selection matcher must still resolve the older id spelling',
    );

    // Five newer captures against a cap of three. The FIFO cut may only run through
    // ordinary rows, so it has to take fillers and leave the photo on screen.
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
