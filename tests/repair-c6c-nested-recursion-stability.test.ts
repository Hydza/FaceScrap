import assert from 'node:assert/strict';
import test from 'node:test';

import { mediaId, sanitizeIncomingItems } from '../src/shared/media';

// --- C6c repair: bounding must happen ONLY at mediaId's exit, never inside
// genericEndpointId ---------------------------------------------------------
//
// Round 2 bounded genericEndpointId's three branches individually. Round 3
// added the single outer bound in mediaId() and left those per-branch bounds
// in place as redundant belt-and-braces. They were not redundant: the
// nested-url branch hashes a RECURSIVE candidate, so bounding mid-recursion
// feeds identityHash a different string than it saw before, and the outer id
// changes value while staying the same (short) length.
//
// That is worse than the overflow it was guarding: an over-long id is
// rejected loudly by sanitizeDownloadReceipt, but a silently rewritten SHORT
// id orphans every already-stored row that was keyed off the old value —
// mergeMedia's by-id dedupe treats the recomputed item as new, and
// matchesActiveMediaId's `active.has(mediaId(item.url))` stops matching.
// historicalMediaIds cannot bridge it either: it emits a path-only alias
// (`asset:/safe_image.php`), never the old hash.
//
// The golden ids below were captured from `git show main:src/shared/media.ts`
// bundled and executed side by side with the working tree. They are the
// pre-repair-series values, i.e. what a user's existing rows are keyed off.

// A realistic signed fbcdn redirector: no efg, no `url=` param, so it resolves
// through genericEndpointId's sorted-query branch. Its raw candidate is 322
// chars — over MEDIA_ID_MAX_LEN (256), which is exactly what makes a
// mid-recursion bound fire and change the outer hash's input.
const NESTED_OVERFLOWING =
  'https://z-p42-video.xx.fbcdn.net/vp/redirect?_nc_cat=110&_nc_sid=8bfeb9' +
  '&_nc_ohc=QwErTyUiOpAsDfGh1234&_nc_ht=z-p42-video.xx&_nc_gid=A1b2C3d4E5f6G7h8' +
  '&edm=AP4hL3IEAAAA&ccb=9-4&oh=00_AfB1c2D3e4F5g6H7i8J9k0L1m2N3o4P5q6R7s8T9u0V1w2X3' +
  '&oe=66ABCDEF&_nc_zt=28&vs=abcdefghijklmnopqrstuvwxyz0123456789' +
  '&_nc_vs=HBksFQIYUmlnX3hwdl9yZWVsc19wZXJtYW5lbnRfc3JfcHJvZAA';

const PROXIED_OVERFLOWING =
  'https://external.xx.fbcdn.net/safe_image.php?d=AQA' +
  `&url=${encodeURIComponent(NESTED_OVERFLOWING)}&_nc_cat=1&_nc_sid=abc123`;

test('a proxy wrapping a nested URL whose own candidate overflows keeps its exact pre-repair id', () => {
  // Guard the premise: if this stops being over 256 the test silently stops
  // exercising the recursion bound at all.
  assert.ok(
    mediaId(NESTED_OVERFLOWING).startsWith('asset:q='),
    'premise broken: the nested URL must be one whose own candidate overflows',
  );

  assert.equal(mediaId(PROXIED_OVERFLOWING), 'asset:/safe_image.php?resource=5893198cfdb5c626');
});

test('the same proxy id survives the untrusted page-message channel unchanged', () => {
  const [item] = sanitizeIncomingItems(
    [
      {
        url: PROXIED_OVERFLOWING,
        kind: 'image',
        source: 'video',
        origin: 'graphql',
        addedAt: 1_700_000_000_000,
      },
    ],
    1_700_000_000_000,
  );

  assert.equal(item?.id, 'asset:/safe_image.php?resource=5893198cfdb5c626');
});

test('two proxies wrapping different overflowing nested URLs still get different ids', () => {
  // Vary the NESTED url before encoding it — the nested string is
  // percent-encoded inside the proxy, so patching the outer string is a no-op.
  const otherNested = NESTED_OVERFLOWING.replace('/vp/redirect?', '/vp/redirect2?');
  const otherProxy =
    'https://external.xx.fbcdn.net/safe_image.php?d=AQA' +
    `&url=${encodeURIComponent(otherNested)}&_nc_cat=1&_nc_sid=abc123`;

  assert.ok(mediaId(otherNested).startsWith('asset:q='), 'premise: the sibling nested URL also overflows');
  assert.notEqual(mediaId(PROXIED_OVERFLOWING), mediaId(otherProxy));
});

test('removing the per-branch bounds does not let any id escape the contract', () => {
  // The single bound at mediaId's exit is now the only one. Prove it still
  // covers the branch that no longer bounds itself: an 8000-char path through
  // genericEndpointId's sorted-query branch.
  const huge = `https://external.xx.fbcdn.net/safe_image.php/${'a'.repeat(8000)}?z=1`;
  const id = mediaId(huge);

  assert.ok(id.length <= 256, `id escaped the bound at ${id.length} chars`);
  assert.ok(id.startsWith('asset:q='));
});

// genericEndpointId has THREE branches and the recursion can land in any of
// them. The tests above only ever recurse into the sorted-query branch, so a
// bound reintroduced into the asset-key branch alone would drift exactly like
// round 4 did and every test above would still pass. This pair watches that
// branch: an `efg`-bearing nested URL whose own candidate overflows (332 chars
// on main) via `asset:${path}?xpv:...`, wrapped in a proxy.
const EFG_XPV = Buffer.from(JSON.stringify({ xpv_asset_id: '12345678901234567' })).toString('base64');

const NESTED_ASSET_BRANCH_OVERFLOWING =
  `https://video.xx.fbcdn.net/vp/${'p'.repeat(300)}?efg=${encodeURIComponent(EFG_XPV)}&oh=abc&oe=123`;

const PROXIED_ASSET_BRANCH =
  `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(NESTED_ASSET_BRANCH_OVERFLOWING)}&_nc_sid=zz`;

test('a proxy recursing into the asset-key branch keeps its exact pre-repair id', () => {
  assert.ok(
    mediaId(NESTED_ASSET_BRANCH_OVERFLOWING).startsWith('asset:q='),
    'premise broken: the nested URL must overflow through the asset-key branch',
  );

  assert.equal(mediaId(PROXIED_ASSET_BRANCH), 'asset:/safe_image.php?resource=7ea8788e72e7a57b');
});

test('the asset-key proxy id survives the untrusted page-message channel unchanged', () => {
  const [item] = sanitizeIncomingItems(
    [
      {
        url: PROXIED_ASSET_BRANCH,
        kind: 'image',
        source: 'video',
        origin: 'graphql',
        addedAt: 1_700_000_000_000,
      },
    ],
    1_700_000_000_000,
  );

  assert.equal(item?.id, 'asset:/safe_image.php?resource=7ea8788e72e7a57b');
});

test('an ordinary short proxy id is untouched by the bounding change', () => {
  const shortNested = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/photo.jpg?oh=abc&oe=123';
  const shortProxy = `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(shortNested)}`;

  assert.equal(mediaId(shortProxy), 'asset:/safe_image.php?resource=a95c803ba32bb5db');
});
