// Media and retention locks must use separate chains so unrelated writes never block each other.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import type { MediaItem } from '../src/shared/media';

const { addMedia, setPlaying } = await import('../src/shared/storage');

function image(id: string): MediaItem {
  return {
    id,
    url: `https://scontent.xx.fbcdn.net/v/t39.30808-6/${id}.jpg`,
    kind: 'image',
    source: 'story',
    origin: 'graphql',
    addedAt: 1_800_000_000_000,
  };
}

test('the media-global lock and the retention-snapshot lock are independent chains', async () => {
  await resetChromeStorage();
  const mediaTab = 95_000;
  const playingTab = 95_001;

  const session = chrome.storage.session;
  const realSet = session.set.bind(session);
  let releaseMediaWrite!: () => void;
  const mediaGate = new Promise<void>((resolve) => {
    releaseMediaWrite = resolve;
  });

  session.set = async (values): Promise<void> => {
    // Block the media write (still inside withMediaGlobalLock's task) until
    // the test explicitly releases it.
    if (`media_${mediaTab}` in values) await mediaGate;
    await realSet(values);
  };

  try {
    const mediaWrite = addMedia(mediaTab, [image('lock-independence')]);
    // Let addMedia enter withMediaGlobalLock and block on the intercepted
    // session.set call.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // setPlaying uses the retention lock and must resolve while the media lock
    // remains blocked.
    const raced = await Promise.race([
      setPlaying(playingTab, { ids: ['b'], hasVideo: true, at: 1_800_000_009_000 }).then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 200)),
    ]);
    assert.equal(raced, 'resolved', 'setPlaying must not wait on the unrelated media-global lock');

    releaseMediaWrite();
    assert.equal(await mediaWrite, 1);
  } finally {
    releaseMediaWrite();
    session.set = realSet;
  }
});
