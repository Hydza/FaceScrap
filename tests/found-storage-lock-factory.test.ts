// Regression check for the storage-lane code-review finding S2:
// withHeadroomLock, withMediaGlobalLock and withRetentionSnapshotLock used to
// be three byte-identical chain-mutex implementations (differing only in
// which module-level chain variable each closed over). storage.ts now builds
// all three from one createChainLock() factory — but as three SEPARATE
// instances, each with its own closed-over chain.
//
// This test guards exactly the risk that refactor introduces: if a future
// edit (or a mistake while doing this one) made the three locks share one
// chain instead of each getting their own, an in-flight write on one lock
// would block unrelated work that only needed a different lock.
// withMediaGlobalLock only serializes addMedia's media read-merge-write;
// withRetentionSnapshotLock only serializes playing/recent/pin control
// writes — the two must stay independent.
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
    // Give addMedia's task a turn to enter withMediaGlobalLock and hang on
    // the intercepted session.set call (same pattern as the existing
    // "addMedia serializes media writes across tabs" test).
    await new Promise((resolve) => setTimeout(resolve, 0));

    // setPlaying only ever needs withRetentionSnapshotLock. If the two locks
    // were accidentally collapsed into one shared chain, this would hang
    // behind the still-blocked media write instead of resolving promptly.
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
