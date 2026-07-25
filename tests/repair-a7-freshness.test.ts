import assert from 'node:assert/strict';
import test from 'node:test';

import { createRecentObserver } from '../src/background/recent-observer';

// A7 repair: the write-storm fix in recent-observer.ts (see tests/fix-recent-observer.test.ts)
// added `altConfirmed`, which — as originally written — never expired: once a video/audio
// pair confirmed one full swap, EVERY later repeat of either member was suppressed for the
// rest of playback. An adversarial reviewer found the regression this causes. Quoting the
// finding verbatim:
//
//   now-playing.ts has no other freshness signal for a video with no DOM ids (MSE blob: src
//   is "never in ref.ids" per its own comment) and no ref.vid ("Absent on feed/story
//   surfaces" per PlayingRef.vid's doc), and its sticky window is PLAYING_GRACE_MS =
//   5*60*1000. [...] a feed-style item (ids: [], no vid) stays selected while setRecent
//   keeps arriving each tick, then — with setRecent calls stopped exactly as a confirmed
//   pair now causes for the rest of playback — selectPlaying drops it from its result set
//   ~330s later with nothing about the slide having changed.
//
// The repair bounds the suppression to ALT_CONFIRM_REFRESH_MS (recent-observer.ts) so a
// perfectly stable, still-playing alternating pair keeps writing periodically — the write
// callback here stands in for storage's recent.tracks, whose freshest timestamp is exactly
// what now-playing.ts's selectPlaying() measures against PLAYING_GRACE_MS. This test proves
// that periodic refresh survives well past PLAYING_GRACE_MS, while also proving the original
// write-storm fix (tests/fix-recent-observer.test.ts) is not undone in the process.

const V = 'https://video.xx.fbcdn.net/v/t42/video-track.mp4?bytestart=0&byteend=999';
const A = 'https://video.xx.fbcdn.net/v/t42/audio-track.mp4?bytestart=0&byteend=999';

// now-playing.ts's cliff (PLAYING_GRACE_MS = 5 * 60 * 1000) is not exported, so it cannot be
// imported here — recent-observer.ts's ALT_CONFIRM_REFRESH_MS comment documents the same
// coupling by value instead. Duplicated here, deliberately, for the same reason.
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

  // Confirm the pair exactly as tests/fix-recent-observer.test.ts's A7 case does: V, A, V.
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

  // Constraint 2 (the regression this repair closes): silence forever is not allowed. If
  // altConfirmed never expired, writeAts.length would still be exactly 3 here — every one of
  // the `bumps` alternations above would have been swallowed, and now-playing.ts's
  // selectPlaying() would have dropped this still-playing item from its result set roughly
  // PLAYING_GRACE_MS after the 3rd write, long before this loop finished.
  assert.ok(
    writeAts.length > 3,
    'a stable alternating pair must still refresh storage periodically instead of going silent forever',
  );

  // The property now-playing.ts actually depends on: at every point across the whole run,
  // the gap since the most recent write must stay comfortably under PLAYING_GRACE_MS. Check
  // every consecutive gap, plus the trailing gap from the last write to the end of the run.
  const gaps: number[] = [];
  for (let i = 1; i < writeAts.length; i++) gaps.push(writeAts[i] - writeAts[i - 1]);
  gaps.push(clock - writeAts[writeAts.length - 1]);
  const maxGap = Math.max(...gaps);
  assert.ok(
    maxGap < PLAYING_GRACE_MS,
    `every gap between refresh writes (and from the last write to now) must stay under ` +
      `PLAYING_GRACE_MS (${PLAYING_GRACE_MS}ms); got a max gap of ${maxGap}ms`,
  );

  // Constraint 1 (do not re-introduce the write-storm this repair must not undo): writes must
  // stay far below one per alternation. `bumps` alternations occurred; a write on every one of
  // them (the pre-A7 behaviour) would put writeAts.length within a handful of `bumps`.
  assert.ok(
    writeAts.length < bumps / 2,
    `expected the confirmed-pair suppression to still cut writes well below one per ` +
      `alternation (${bumps} alternations produced ${writeAts.length} writes)`,
  );
});
