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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { beforeEach } from 'node:test';

import { persistNowPlayingMessage } from '../src/background/playing-handler';
import { isNumericMediaId } from '../src/shared/media';
import { isStoryDomId, storyDomIdFromGraphqlNode } from '../src/shared/story-mark';
import { getPlaying } from '../src/shared/storage';
import { resetChromeStorage } from './chrome-fake';

const ROOT = process.cwd();
const content = readFileSync(join(ROOT, 'src', 'content', 'content.ts'), 'utf8');
const storyMark = readFileSync(join(ROOT, 'src', 'shared', 'story-mark.ts'), 'utf8');
const playingHandler = readFileSync(join(ROOT, 'src', 'background', 'playing-handler.ts'), 'utf8');

beforeEach(resetChromeStorage);

// A pure boundary test (below) can't distinguish this fix from the ORIGINAL
// hand-spelled regexes it replaced — both enforce the identical 5-20 bound,
// so behaviourally they're indistinguishable. What actually regresses on a
// revert is the DEDUPLICATION itself: the shared forms stop being imported
// and the literals come back. Check that directly, on the source text, so
// reverting either file makes this fail for a reason a behavioural check
// alone cannot catch.
test('R5: story-mark.ts imports isNumericMediaId from the shared model, and the old literals are gone', () => {
  assert.match(storyMark, /import\s*\{\s*isNumericMediaId\s*\}\s*from\s*['"]\.\/media['"]/);
  assert.equal(storyMark.includes('/^\\d{5,20}$/'), false, 'the old anchored hand-spelled literal must be gone');
  assert.equal(
    storyMark.includes('/^(?:S:_ISC:|S3:)\\d{5,20}$/'),
    false,
    'the old embedded hand-spelled literal must be gone',
  );
});

test('R5: playing-handler.ts imports isNumericMediaId from the shared model, and the old literal is gone', () => {
  assert.match(playingHandler, /import\s*\{[^}]*\bisNumericMediaId\b[^}]*\}\s*from\s*['"]\.\.\/shared\/media['"]/s);
  assert.ok(playingHandler.includes('vid: isNumericMediaId(message.vid) ? message.vid : undefined,'));
  assert.equal(playingHandler.includes('/^\\d{5,20}$/'), false, 'the old hand-spelled literal must be gone');
});

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
test('R5: content.ts imports the shared numeric-id forms from media.ts', () => {
  assert.match(
    content,
    /import\s*\{[^}]*\bisNumericMediaId\b[^}]*\}\s*from\s*['"]\.\.\/shared\/media['"]/s,
  );
  assert.match(
    content,
    /import\s*\{[^}]*\bNUMERIC_MEDIA_ID_SOURCE\b[^}]*\}\s*from\s*['"]\.\.\/shared\/media['"]/s,
  );
});

test('R5: reelVideoId uses isNumericMediaId instead of a re-spelled anchored regex', () => {
  assert.ok(
    content.includes("return closestAttrValue(video, 'data-video-id', isNumericMediaId);"),
    'reelVideoId must delegate straight to the shared predicate',
  );
});

test('R5: urlVideoId builds its path regex from NUMERIC_MEDIA_ID_SOURCE and validates ?v= with isNumericMediaId', () => {
  // Checked as separate unambiguous substrings, not one long literal: the real
  // line is built from a template literal whose escaped slashes (\\/) are two
  // characters in the FILE'S raw text but decode to one at runtime, and a
  // single hand-matched literal here is exactly the kind of mismatch that trap
  // invites. ${NUMERIC_MEDIA_ID_SOURCE} below is plain text inside a
  // single-quoted string (no interpolation triggers outside a template
  // literal), so it matches the source's own interpolation syntax literally.
  assert.ok(content.includes('const URL_VIDEO_ID_RE = new RegExp(`'));
  assert.ok(content.includes('(?:reel|videos?)'));
  assert.ok(
    content.includes('${NUMERIC_MEDIA_ID_SOURCE}'),
    'the embedded path pattern must splice in the shared source, not \\d{5,20} directly',
  );
  assert.ok(content.includes('(?=[/?#]|$)`);'));
  assert.ok(
    content.includes('if (isNumericMediaId(v)) return v;'),
    'the ?v= query param must be checked with the shared predicate',
  );
});

test('R5: no re-spelled \\d{5,20} literal remains anywhere in content.ts', () => {
  assert.equal(content.includes('/^\\d{5,20}$/'), false, 'anchored hand-spelled literal must be gone');
  assert.equal(content.includes('(\\d{5,20})'), false, 'embedded hand-spelled literal must be gone');
});
