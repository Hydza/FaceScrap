import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecentObserver } from '../src/background/recent-observer';

// Confirmed video/audio pairs must refresh within PLAYING_GRACE_MS while suppressing interim writes.

const V = 'https://video.xx.fbcdn.net/v/t42/video-track.mp4?bytestart=0&byteend=999';
const A = 'https://video.xx.fbcdn.net/v/t42/audio-track.mp4?bytestart=0&byteend=999';

// Mirror the unexported selection window to verify refreshes across its full duration.
const PLAYING_GRACE_MS = 5 * 60 * 1000;
const SEGMENT_MS = 4_000; // a plausible steady DASH video/audio segment cadence

test('A7 repair: a confirmed, stable alternating pair still refreshes storage well inside PLAYING_GRACE_MS', async () => {
  let clock = 0;
  const writeAts: number[] = [];
  const observer = createRecentObserver(
    async (_tabId, _url, at) => {
      writeAts.push(at);
      return true;
    },
    { now: () => clock },
  );

  // Confirm the alternating pair with V, A, V.
  assert.ok(await observer.bump(1, V));
  clock += SEGMENT_MS;
  assert.ok(await observer.bump(1, A));
  clock += SEGMENT_MS;
  assert.ok(await observer.bump(1, V));
  assert.equal(writeAts.length, 3, 'sanity: the pair confirms after one full swap, as in the A7 fix test');

  // Keep alternating on a steady clock for well past PLAYING_GRACE_MS of simulated playback —
  // a long-watched reel/story on one stable DASH representation pair, never changing.
  const totalSpan = PLAYING_GRACE_MS + 2 * 60_000; // 2 minutes past the cliff, for margin
  let bumps = 0;
  let nextUrl: string = A;
  while (clock < totalSpan) {
    clock += SEGMENT_MS;
    await observer.bump(1, nextUrl);
    nextUrl = nextUrl === A ? V : A;
    bumps++;
  }

  // Periodic refreshes must keep the item active beyond PLAYING_GRACE_MS.
  assert.ok(
    writeAts.length > 3,
    'a stable alternating pair must still refresh storage periodically instead of going silent forever',
  );

  // Every write gap, including the trailing gap, must stay below the grace window.
  const gaps: number[] = [];
  for (let i = 1; i < writeAts.length; i++) gaps.push(writeAts[i] - writeAts[i - 1]);
  gaps.push(clock - writeAts[writeAts.length - 1]);
  const maxGap = Math.max(...gaps);
  assert.ok(
    maxGap < PLAYING_GRACE_MS,
    `every gap between refresh writes (and from the last write to now) must stay under ` +
      `PLAYING_GRACE_MS (${PLAYING_GRACE_MS}ms); got a max gap of ${maxGap}ms`,
  );

  // Pair suppression must keep writes well below one per alternation.
  assert.ok(
    writeAts.length < bumps / 2,
    `expected the confirmed-pair suppression to still cut writes well below one per ` +
      `alternation (${bumps} alternations produced ${writeAts.length} writes)`,
  );
});
