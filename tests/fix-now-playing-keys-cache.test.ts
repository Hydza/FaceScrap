// EF4: keysOf (now-playing.ts) re-ran fbAssetKeys on url AND audioUrl per
// video item on every selectPlaying call with no cross-call cache, and the
// one-slot memo inside fbAssetKeys (media.ts's decodeEfg) is defeated by
// iterating several items per tick. selectPlaying reruns on every ~500ms
// panel tick, so every video item paid the full efg decode again every tick
// for as long as the panel stayed open. The fix caches the decode across
// calls, keyed by tab+item, invalidated the moment either source url changes.
//
// A purely behavioral (black-box) test cannot tell "cached, correctly
// invalidated" apart from "never cached, always freshly (and correctly)
// recomputed" — both give selectPlaying's public output, by design; that is
// the whole point of the cache being transparent. So, like
// tests/fix-content.test.ts and tests/fix-sidepanel.test.ts do for
// implementation details with no black-box signature of their own, this
// checks the fix is actually present in source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const source = readFileSync(join(ROOT, 'src', 'shared', 'now-playing.ts'), 'utf8');

test('EF4: keysOf memoizes its efg/mediaId decode in a module-scope (cross-call) cache', () => {
  assert.match(
    source,
    /const itemKeysCache = new Map</,
    'a module-scope cache must exist so the decode survives across selectPlaying calls, not just within one',
  );
  assert.match(
    source,
    /function keysOf\(tid: number, i: MediaItem\): ItemKeys \{/,
    'keysOf must be a named module-scope function (so its cache key can be tab-scoped), not a per-call local closure',
  );
});

test('EF4: a cache hit requires BOTH the video and audio source urls to be unchanged', () => {
  assert.match(
    source,
    /cached\s*!=\s*null\s*&&\s*cached\.url\s*===\s*i\.url\s*&&\s*cached\.audioUrl\s*===\s*i\.audioUrl/,
    'the cache must invalidate the moment either source url changes, or a DASH url/audioUrl swap would return stale keys',
  );
});

test('EF4: the cross-call cache is bounded (FIFO-capped), like the other per-tab maps in this module', () => {
  assert.match(source, /ITEM_KEYS_CACHE_MAX/);
  assert.match(
    source,
    /itemKeysCache\.size > ITEM_KEYS_CACHE_MAX/,
    'an unbounded cross-call cache keyed by tab+item would grow without limit across many tabs/items',
  );
});
