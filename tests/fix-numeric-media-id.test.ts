// Share the 5–20 digit media-ID validator and call it lazily across the media/story-mark cycle.
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { persistNowPlayingMessage } from '../src/background/playing-handler';
import { isNumericMediaId } from '../src/shared/media';
import { isStoryDomId, storyDomIdFromGraphqlNode } from '../src/shared/story-mark';
import { getPlaying } from '../src/shared/storage';
import { resetChromeStorage } from './chrome-fake';

beforeEach(resetChromeStorage);

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

// Check content-script integration through source because importing it starts browser-only side effects.
