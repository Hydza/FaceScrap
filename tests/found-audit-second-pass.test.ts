// Validate parser bounds, retention reservations, and per-track sanitization.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import './chrome-fake';
import { resetChromeStorage } from './chrome-fake';
import { addMedia, getMedia, setPlaying } from '../src/shared/storage';
import { makeItem, sanitizeIncomingItems, type MediaItem } from '../src/shared/media';
import { parseTracks } from '../src/shared/mp4-remux';

// ── mp4-remux: bound fragmented trun counts from untrusted media ──────────────
// A trun with no per-sample fields advances zero bytes per declared sample, so
// its count must be bounded independently of the box cursor.

test('a fragmented trun declaring four billion samples terminates instead of expanding', async () => {
  // Corrupt only the trun count so the parser reaches the fragment loop.
  const bytes = new Uint8Array(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'track-video.mp4')));
  const at = findBoxBody(bytes, 'trun');
  assert.ok(at > 0, 'the fixture must be fragmented for this test to mean anything');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // version+flags = 0: no per-sample fields, so each iteration of the loop reads
  // ZERO bytes and the cursor can never run out to stop it.
  view.setUint32(at, 0);
  view.setUint32(at + 4, 0xffffffff); // sample_count

  const started = Date.now();
  // Either rejection or a bounded table is acceptable, but parsing must terminate.
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

// Reserved rows may outnumber the cap; eviction must remove only ordinary rows.
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
  // Register playing rows before capture so retention can reserve them during
  // the first trim.
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
