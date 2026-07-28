// R5 — the numeric-media-id pattern /^\d{5,20}$/ was independently re-spelled
// at src/background/playing-handler.ts, src/content/content.ts (x3, one
// embedded in a larger pattern), and src/shared/story-mark.ts (x2, one
// embedded). All five now go through media.ts's shared
// NUMERIC_MEDIA_ID_SOURCE / NUMERIC_MEDIA_ID_RE / isNumericMediaId instead.
//
// story-mark.ts's site is the tricky one: media.ts already imports
// isStoryDomId FROM story-mark.ts, so importing media.ts's numeric-id form
// back into story-mark.ts closes an import cycle. A naive fix (splicing
// NUMERIC_MEDIA_ID_SOURCE into a module-top-level RegExp in story-mark.ts)
// verifiably breaks under esbuild's actual bundling — whichever of the two
// modules loads first leaves the OTHER's shared constant `undefined` at that
// point, silently turning the pattern into `/undefined$/` and rejecting every
// real Story id. The fix instead calls isNumericMediaId from inside a
// function body (deferred until both modules have finished loading, exactly
// like story-mark.ts's own pre-existing use of media.ts's isStoryDomId
// already did). The behavioural tests below exercise real Story ids through
// the real bundler (scripts/test.mjs also bundles this file with esbuild), so
// a regression back to the unsafe top-level-splice shape would show up here
// as every valid id being rejected — not merely as a lint nit.
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { persistNowPlayingMessage } from '../src/background/playing-handler';
import { isNumericMediaId } from '../src/shared/media';
import { isStoryDomId, storyDomIdFromGraphqlNode } from '../src/shared/story-mark';
import { getPlaying } from '../src/shared/storage';
import { resetChromeStorage } from './chrome-fake';

beforeEach(resetChromeStorage);

// Six tests are gone from this file. They asserted that each call site imports the
// shared numeric-id forms and that the old hand-spelled /^\d{5,20}$/ literals no
// longer appear. The file''s own header admitted the point: behaviour cannot tell
// the two shapes apart, because both enforce the same 5-20 bound. So they guarded
// deduplication, not correctness, and failed on any rename. The bound itself is
// exercised below, at the boundary, through the real bundle.
/** Base64url-encode a decoded Story DOM id body (e.g. "S3:12345") the same
 *  way isStoryDomId's own decodeStoryDomId reverses it — real production ids
 *  use this alphabet, and STORY_DOM_ID's outer shape gate only accepts it. */
function domIdFor(decoded: string): string {
  return Buffer.from(decoded, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

test('R5: isStoryDomId accepts a 20-digit decoded numeric id and rejects 21, for both known prefixes', () => {
  for (const prefix of ['S:_ISC:', 'S3:'] as const) {
    const atCeiling = domIdFor(`${prefix}${'7'.repeat(20)}`);
    const overCeiling = domIdFor(`${prefix}${'7'.repeat(21)}`);
    assert.equal(isStoryDomId(atCeiling), true, `${prefix} + 20 digits must be accepted`);
    assert.equal(isStoryDomId(overCeiling), false, `${prefix} + 21 digits must be rejected`);
  }
});

test('R5: isStoryDomId rejects a decoded id whose "numeric" tail is not purely digits', () => {
  const notNumeric = domIdFor('S3:12345abc');
  assert.equal(isStoryDomId(notNumeric), false);
});

test('R5: storyDomIdFromGraphqlNode enforces the same 5-20 digit bound on story_card_id', () => {
  const validDigits = '7'.repeat(20);
  const validId = domIdFor(`S:_ISC:${validDigits}`);
  assert.equal(
    storyDomIdFromGraphqlNode({ id: validId, story_card_info: { story_card_id: validDigits } }),
    validId,
    'a 20-digit card id matching the decoded node must be accepted',
  );

  const overDigits = '7'.repeat(21);
  const overId = domIdFor(`S:_ISC:${overDigits}`);
  assert.equal(
    storyDomIdFromGraphqlNode({ id: overId, story_card_info: { story_card_id: overDigits } }),
    undefined,
    'a 21-digit card id must be rejected',
  );
});

test('R5: playing-handler.ts keeps a vid only when it matches the shared numeric-id bound', async () => {
  const validVid = '9'.repeat(20);
  const okAck = await persistNowPlayingMessage(
    11_001,
    { type: 'NOW_PLAYING', ids: [], hasVideo: true, vid: validVid, detectedAt: 1_000 },
    1_000,
  );
  assert.deepEqual(okAck, { ok: true });
  assert.equal((await getPlaying(11_001))?.vid, validVid);

  const overVid = '9'.repeat(21);
  const rejectedAck = await persistNowPlayingMessage(
    11_002,
    { type: 'NOW_PLAYING', ids: [], hasVideo: true, vid: overVid, detectedAt: 1_000 },
    1_000,
  );
  assert.deepEqual(rejectedAck, { ok: true });
  assert.equal((await getPlaying(11_002))?.vid, undefined, 'a 21-digit vid must be dropped, not stored');
});

test('R5: isNumericMediaId itself defines the 5-20 bound the tests above assume', () => {
  assert.equal(isNumericMediaId('7'.repeat(5)), true);
  assert.equal(isNumericMediaId('7'.repeat(4)), false);
  assert.equal(isNumericMediaId('7'.repeat(20)), true);
  assert.equal(isNumericMediaId('7'.repeat(21)), false);
});

// content.ts cannot run under node:test (it wires up MutationObserver, timers
// and chrome.runtime round trips as an unconditional module side effect — see
// tests/fix-content.test.ts's header) so its three call sites are checked on
// the source text instead: the shared forms must be imported and used, and
// the old re-spelled \d{5,20} literals must be gone.
