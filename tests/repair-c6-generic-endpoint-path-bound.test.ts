import assert from 'node:assert/strict';
import test from 'node:test';

import { mediaId, mergeMedia, sanitizeIncomingItems } from '../src/shared/media';

// --- C6 repair: genericEndpointId's `path` must be bounded in EVERY branch,
// not only guarded by a check on the query string ------------------------
//
// The earlier C6 fix added GENERIC_ENDPOINT_ID_MAX_LEN (256) and bounded the
// "unknown generic endpoint" fallback with:
//
//   return whole.length <= GENERIC_ENDPOINT_ID_MAX_LEN || serialized === ''
//     ? whole
//     : `asset:${path}?q=${identityHash(serialized)}`;
//
// An adversarial review found this incomplete: `|| serialized === ''`
// unconditionally exempts every query-LESS URL, even though
// `whole = asset:${path}` in that branch is bounded only by the outer
// MAX_MEDIA_URL_LEN (8192), not by the 256-char id contract. Worse, the
// SAME unbounded `path` is embedded raw in the other two genericEndpointId
// branches (the efg-asset-key branch and the nested-`url`-resource branch),
// which only ever bounded their own discriminator/hash suffix — never `path`
// itself — so all three branches could overflow the shared bound.
//
// Why the bound matters: an id past 256 chars makes sanitizeDownloadReceipt
// reject the download outright ("Invalid download request."), and PlayingRef
// ids are truncated at 256 by playing-handler.ts while the panel compares
// UNtruncated — so a long id also silently breaks now-playing matching.
const GENERIC_ID_BOUND = 256;

function base64url(json: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('C6 repair: mediaId bounds the query-less unknown-generic-endpoint fallback (reviewer repro)', () => {
  // The reviewer's exact end-to-end reproduction: a graphql unknown-endpoint
  // URL with a ~7000-char path and NO query string, run through the real
  // untrusted page-message entry point.
  const now = 1_800_000_000_000;
  const url = 'https://api.xx.fbcdn.net/graphql/unknown_endpoint/' + 'a'.repeat(7000);

  const sanitized = sanitizeIncomingItems(
    [{ url, kind: 'image', source: 'story', origin: 'graphql', addedAt: now }],
    Number.POSITIVE_INFINITY,
    now,
  );

  assert.equal(sanitized.length, 1, 'a well-formed fbcdn item must still be accepted');
  assert.ok(
    sanitized[0].id.length <= GENERIC_ID_BOUND,
    `id must fit the shared 256-char id contract, got ${sanitized[0].id.length}`,
  );

  // mergeMedia must keep the SAME bounded id on re-merge, not regenerate a
  // fresh (and possibly differently-shaped) one on every read.
  const [merged] = mergeMedia([], sanitized, now);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, sanitized[0].id, 're-merging must not change the bounded id');
  assert.ok(merged[0].id.length <= GENERIC_ID_BOUND);

  // The bare mediaId() call the reviewer used directly.
  assert.ok(mediaId(url).length <= GENERIC_ID_BOUND);
});

test('C6 repair: a short query-less generic-endpoint URL keeps its exact prior id (stability half)', () => {
  // A URL that already produces a short id must keep producing THE SAME id —
  // persisted rows and Saved receipts key off it. This is the half a careless
  // overflow-only fix (e.g. bounding by hashing `path` unconditionally) breaks.
  assert.equal(
    mediaId('https://api.xx.fbcdn.net/graphql/unknown_endpoint/'),
    'asset:/graphql/unknown_endpoint/',
    'a URL whose id already fits must be returned byte-for-byte unchanged',
  );
});

test('C6 repair: two different overlong query-less paths never collide into the same bounded id', () => {
  const idA = mediaId('https://api.xx.fbcdn.net/graphql/unknown_endpoint/' + 'a'.repeat(7000));
  const idB = mediaId('https://api.xx.fbcdn.net/graphql/unknown_endpoint/' + 'b'.repeat(7000));
  assert.ok(idA.length <= GENERIC_ID_BOUND && idB.length <= GENERIC_ID_BOUND);
  assert.notEqual(idA, idB, 'two distinct overlong resources must not be grouped under one id');
  assert.equal(
    mediaId('https://api.xx.fbcdn.net/graphql/unknown_endpoint/' + 'a'.repeat(7000)),
    idA,
    'the same overlong URL must hash to a stable id across calls',
  );
});

// --- Same escape, other branches --------------------------------------
// The reviewer's report named the query-less fallback branch specifically,
// but `path` is embedded just as unconditionally in genericEndpointId's other
// two branches. Each is reachable from the same untrusted channel and must be
// bounded too, or the "same escape" simply reopens one branch over.

test('C6 repair: the efg-asset-key branch also bounds an over-long path', () => {
  const efg = base64url({ xpv_asset_id: '12345678901234567' });
  const url = 'https://api.xx.fbcdn.net/graphql/unknown_endpoint/' + 'c'.repeat(7000) + '?efg=' + efg;
  assert.ok(mediaId(url).length <= GENERIC_ID_BOUND);
});

test('C6 repair: the efg-asset-key branch also bounds a forged over-long discriminator', () => {
  // The untrusted page-message channel controls the whole URL, including
  // `efg` — fbAssetKeys' `(\d+)` match has no length cap of its own, so a
  // SHORT path does not save this branch either.
  const efg = base64url({ xpv_asset_id: '9'.repeat(6000) });
  const url = 'https://api.xx.fbcdn.net/graphql/unknown_endpoint/?efg=' + efg;
  assert.ok(mediaId(url).length <= GENERIC_ID_BOUND);
});

test('C6 repair: the nested-url resource branch also bounds an over-long path', () => {
  const url =
    'https://api.xx.fbcdn.net/graphql/unknown_endpoint/' +
    'd'.repeat(7000) +
    '?url=' +
    encodeURIComponent('https://example.com/x');
  assert.ok(mediaId(url).length <= GENERIC_ID_BOUND);
});

test('C6 repair: an over-long path WITH a query still bounds (hashing the query alone is not enough)', () => {
  // Proves the fix bounds the whole candidate rather than special-casing
  // "hash the query when whole.length overflows": hashing only the query
  // cannot help when `path` alone already exceeds the shared bound.
  const url = 'https://api.xx.fbcdn.net/graphql/unknown_endpoint/' + 'e'.repeat(7000) + '?a=1&b=2';
  assert.ok(mediaId(url).length <= GENERIC_ID_BOUND);
});
