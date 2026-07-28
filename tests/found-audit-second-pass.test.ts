// Defects found by the line-by-line audit pass. Each test fails without its fix.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import './chrome-fake';
import { resetChromeStorage } from './chrome-fake';
import { addMedia, getMedia, setPlaying } from '../src/shared/storage';
import { makeItem, sanitizeIncomingItems, type MediaItem } from '../src/shared/media';
import { parseTracks } from '../src/shared/mp4-remux';

// ── mp4-remux: a fragmented trun count is a wire value like any other ─────────
//
// The progressive reader bounds every table against MAX_SAMPLES_PER_TRACK. The
// fragmented path did not, and a trun whose flags request no per-sample fields
// advances the cursor zero bytes per iteration — so a declared count of four
// billion is an unbounded loop in a box small enough to arrive in one packet.

test('a fragmented trun declaring four billion samples terminates instead of expanding', async () => {
  // The real fixture, corrupted at exactly one field — a truncated or garbled
  // fbcdn response is what this parser is hardened against, and the file is
  // otherwise valid so the reader reaches the fragment loop at all.
  const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'track-video.mp4')));
  const at = findBoxBody(bytes, 'trun');
  assert.ok(at > 0, 'the fixture must be fragmented for this test to mean anything');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // version+flags = 0: no per-sample fields, so each iteration of the loop reads
  // ZERO bytes and the cursor can never run out to stop it.
  view.setUint32(at, 0);
  view.setUint32(at + 4, 0xffffffff); // sample_count

  const started = Date.now();
  // Either outcome is acceptable — refusing it, or reading a bounded table. What
  // is NOT acceptable is taking four billion iterations to decide.
  await parseTracks(new Blob([bytes])).catch(() => undefined);
  assert.ok(Date.now() - started < 10_000, 'the declared count must be bounded, not expanded');
});

/** Byte offset of the first body of a box of this type, or -1. */
function findBoxBody(bytes: Uint8Array, type: string): number {
  const want = [...type].map((c) => c.charCodeAt(0));
  for (let i = 0; i + 8 <= bytes.length; i += 1) {
    if (want.every((code, k) => bytes[i + 4 + k] === code)) return i + 8;
  }
  return -1;
}

// ── storage: retention must not evict what the partition reserved ────────────

// The eviction splice cut from the front of [ordinary, ...reserved] by a count
// derived from the whole array, so it only stayed inside `ordinary` while
// `ordinary` happened to be longer than the overshoot. Make the reserved set
// LARGER than the cap — a low maxItems plus one slide's worth of representations
// — and the same splice runs straight through into the rows the partition exists
// to protect, evicting the video being watched.
test('the per-tab cap never evicts rows the retention partition reserved', async () => {
  await resetChromeStorage();
  const tabId = 41;
  await chrome.storage.local.set({ settings: { maxItems: 2 } });

  const playing: MediaItem[] = [];
  for (let i = 0; i < 6; i += 1) {
    playing.push(
      makeItem(`https://scontent.xx.fbcdn.net/v/t42/playing${i}_n.mp4`, 'video', 'reel', 'graphql', 1000 + i, true),
    );
  }
  // BEFORE the capture: retention can only reserve what it already knows is
  // playing, so a ref written afterwards would arrive past the first trim.
  await setPlaying(tabId, { ids: playing.map((item) => item.id), hasVideo: true, at: 2000 }, 2000);
  await addMedia(tabId, playing);

  const flood: MediaItem[] = [];
  for (let i = 0; i < 40; i += 1) {
    flood.push(makeItem(`https://scontent.xx.fbcdn.net/v/t42/flood${i}_n.mp4`, 'video', 'reel', 'graphql', 3000 + i, true));
  }
  await addMedia(tabId, flood);

  const stored = await getMedia(tabId);
  const survived = playing.filter((item) => stored.some((row) => row.id === item.id));
  assert.equal(survived.length, playing.length, 'every reserved row survived, even past the cap');
});

// ── media: one bad track id must not cost an item all of them ────────────────

test('a malformed track id drops itself, not the whole list', () => {
  const [item] = sanitizeIncomingItems(
    [
      {
        id: 'fb:x',
        url: 'https://scontent.xx.fbcdn.net/v/t42/v_n.mp4',
        kind: 'video',
        source: 'reel',
        origin: 'graphql',
        addedAt: Date.now(),
        trackIds: ['keep-me', 'x'.repeat(600), 'keep-me-too'],
      },
    ],
    1_000_000,
  );

  assert.deepEqual(item?.trackIds, ['keep-me', 'keep-me-too']);
});

