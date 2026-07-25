import assert from 'node:assert/strict';
import test from 'node:test';

import { durableStoryCardKey, durableStoryMarkPortion, storyCardMark } from '../src/shared/story-mark';

const DOM_ID = 'UzM6NTU1NTU1NTU1NTU1NTU1';

// B6: storyCardMark embeds the URL's owner segment (match[1]) into the
// durable `u:` mark, but content.ts documents that segment as pinned to
// whichever card opened the tray — the SAME DOM-proven card yields a
// DIFFERENT owner-bearing string depending on entry point.
// durableStoryMarkPortion returns that whole owner-bearing string, so a
// cache/binding keyed on it misses on a different-tray revisit even though
// domId alone proves it is the same card. durableStoryCardKey is the
// owner-independent keying form fixed here.
test('B6: durableStoryCardKey gives the SAME DOM-proven card the same key from two different tray entry points', () => {
  const fromOwnerA = storyCardMark('/stories/owner-a/entry-card/', DOM_ID);
  const fromOwnerB = storyCardMark('/stories/owner-b/entry-card/', DOM_ID);

  // The owner-bearing display/compare form (durableStoryMarkPortion, left
  // unchanged by this fix) still legitimately differs by entry point...
  assert.notEqual(fromOwnerA, fromOwnerB);
  assert.equal(durableStoryMarkPortion(fromOwnerA), fromOwnerA);
  assert.equal(durableStoryMarkPortion(fromOwnerB), fromOwnerB);

  // ...but the KEYING form must not.
  assert.equal(durableStoryCardKey(fromOwnerA), durableStoryCardKey(fromOwnerB));
  assert.equal(durableStoryCardKey(fromOwnerA), `u:${DOM_ID}`);
});

test('B6: durableStoryCardKey survives the per-load #vm suffix, like durableStoryMarkPortion', () => {
  const durable = storyCardMark('/stories/owner/entry-card/', DOM_ID);
  assert.equal(durableStoryCardKey(`${durable}#vm:epoch-a:1`), `u:${DOM_ID}`);
  assert.equal(durableStoryCardKey(`${durable}#vm:epoch-b:7`), `u:${DOM_ID}`);
});

test('B6: durableStoryCardKey is undefined for a provisional (URL-only) mark and for undefined', () => {
  const provisional = storyCardMark('/stories/owner/entry-card/');
  assert.equal(durableStoryCardKey(provisional), undefined);
  assert.equal(durableStoryCardKey(undefined), undefined);
});
