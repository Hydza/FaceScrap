import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecentObserver } from '../src/background/recent-observer';

// Treat alternating canonical video and audio URLs as one stable pair after
// widenDashUrl removes each track's byte-range churn.
const V = 'https://video.xx.fbcdn.net/v/t42/video-track.mp4?bytestart=0&byteend=999';
const A = 'https://video.xx.fbcdn.net/v/t42/audio-track.mp4?bytestart=0&byteend=999';

test('A7: a confirmed video/audio alternation stops re-scheduling once the pair has swapped back once', async () => {
  const writes: string[] = [];
  const observer = createRecentObserver(async (_tabId, url) => {
    writes.push(url);
    return true;
  });

  // The first V/A/V cycle establishes an alternating pair.
  assert.ok(await observer.bump(1, V));
  assert.ok(await observer.bump(1, A));
  assert.ok(await observer.bump(1, V));
  assert.equal(writes.length, 3);

  // Suppress later alternation writes until the refresh interval expires.
  assert.equal(await observer.bump(1, A), undefined);
  assert.equal(await observer.bump(1, V), undefined);
  assert.equal(await observer.bump(1, A), undefined);
  assert.equal(writes.length, 3, 'a confirmed alternating pair must stop triggering a write per segment');
});

test('A7: a genuinely third url still gets a fresh confirmation window, and reset() clears the confirmed pair', async () => {
  const writes: string[] = [];
  const observer = createRecentObserver(async (_tabId, url) => {
    writes.push(url);
    return true;
  });
  const other = 'https://video.xx.fbcdn.net/v/t42/other.mp4?bytestart=0&byteend=999';

  assert.ok(await observer.bump(2, V));
  assert.ok(await observer.bump(2, A));
  assert.ok(await observer.bump(2, V));
  assert.equal(await observer.bump(2, A), undefined); // pair confirmed, as above

  // A third URL starts a new candidate pair and requires its own swap-back
  // confirmation before repeats dedupe.
  assert.ok(await observer.bump(2, other));
  assert.ok(await observer.bump(2, V));
  assert.equal(writes.length, 5);

  observer.reset(2);
  // A navigation reset discards pair confirmation, so immediate repeats are new.
  assert.ok(await observer.bump(2, V));
  assert.ok(await observer.bump(2, A));
  assert.equal(writes.length, 7);
});
