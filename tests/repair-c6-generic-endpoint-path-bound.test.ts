import assert from 'node:assert/strict';
import test from 'node:test';

import { mediaId, mergeMedia, sanitizeIncomingItems } from '../src/shared/media';

// Bound the complete genericEndpointId result in every branch, including
// queryless paths. The 256-character contract keeps receipt and playing IDs aligned.
const GENERIC_ID_BOUND = 256;

function base64url(json: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

test('C6 repair: mediaId bounds the query-less unknown-generic-endpoint fallback (reviewer repro)', () => {
  // Exercise a queryless ~7000-character path through the untrusted page-message entry point.
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

  // Verify the direct mediaId path as well.
  assert.ok(mediaId(url).length <= GENERIC_ID_BOUND);
});

test('C6 repair: a short query-less generic-endpoint URL keeps its exact prior id (stability half)', () => {
  // Preserve short IDs because persisted rows and Saved receipts use them as keys.
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

// Apply the same complete-candidate bound to every genericEndpointId branch.

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
  // Bound the complete candidate even when its path alone exceeds the limit.
  const url = 'https://api.xx.fbcdn.net/graphql/unknown_endpoint/' + 'e'.repeat(7000) + '?a=1&b=2';
  assert.ok(mediaId(url).length <= GENERIC_ID_BOUND);
});
