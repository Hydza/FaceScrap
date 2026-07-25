import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecentObserver } from '../src/background/recent-observer';

// A7: a watched DASH video keeps re-appending its own two canonical tracks
// (video representation + audio representation — widenDashUrl already
// collapses each track's byte-range churn down to one url per track), and a
// SINGLE-SLOT "last url" compare is defeated the instant they alternate: every
// switch differs from its immediate predecessor, so every segment schedules a
// full write. These are two distinct canonical urls, standing in for the
// video/audio pair of one playing item.
const V = 'https://video.xx.fbcdn.net/v/t42/video-track.mp4?bytestart=0&byteend=999';
const A = 'https://video.xx.fbcdn.net/v/t42/audio-track.mp4?bytestart=0&byteend=999';

test('A7: a confirmed video/audio alternation stops re-scheduling once the pair has swapped back once', async () => {
  const writes: string[] = [];
  const observer = createRecentObserver(async (_tabId, url) => {
    writes.push(url);
    return true;
  });

  // V, A, V: each differs from its immediate predecessor, so all three
  // schedule a write under the OLD single-slot compare too — that part is
  // unchanged and still correct on its own. The bug is what happens next.
  assert.ok(await observer.bump(1, V));
  assert.ok(await observer.bump(1, A));
  assert.ok(await observer.bump(1, V));
  assert.equal(writes.length, 3);

  // The pair {V, A} has now confirmed one full swap (u1,u2,u1). A real
  // playing video keeps re-appending exactly these two urls for as long as
  // it streams; without this fix every one of these would ALSO schedule a
  // write plus a panel re-render, for the entire duration of playback.
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

  // A real transition to a third url must not be swallowed by the OLD pair's
  // confirmation (it is not {V, A}), and must itself require a fresh swap-
  // back before ITS repeats dedupe.
  assert.ok(await observer.bump(2, other));
  assert.ok(await observer.bump(2, V));
  assert.equal(writes.length, 5);

  observer.reset(2);
  // After a navigation reset, even an immediate repeat of the old {V, A} pair
  // must be treated as brand new — confirmation does not survive the reset.
  assert.ok(await observer.bump(2, V));
  assert.ok(await observer.bump(2, A));
  assert.equal(writes.length, 7);
});
