import assert from 'node:assert/strict';
import test from 'node:test';

import { durableStoryCardKey, durableStoryMarkPortion, storyCardMark } from '../src/shared/story-mark';

const DOM_ID = 'UzM6NTU1NTU1NTU1NTU1NTU1';

// Key durable cards by their DOM-proven ID while preserving owner-bearing display marks.
test('B6: durableStoryCardKey gives the SAME DOM-proven card the same key from two different tray entry points', () => {
  const fromOwnerA = storyCardMark('/stories/owner-a/entry-card/', DOM_ID);
  const fromOwnerB = storyCardMark('/stories/owner-b/entry-card/', DOM_ID);

  // Owner-bearing display forms may differ by entry point.
  assert.notEqual(fromOwnerA, fromOwnerB);
  assert.equal(durableStoryMarkPortion(fromOwnerA), fromOwnerA);
  assert.equal(durableStoryMarkPortion(fromOwnerB), fromOwnerB);

  // Durable keys must remain owner-independent.
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
