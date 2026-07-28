import assert from 'node:assert/strict';
import test from 'node:test';

import {
  durableStoryMarkPortion,
  isDurableStoryMark,
  isProvisionalStoryMark,
  isStoryDomId,
  isStoryPath,
  storyCardMark,
} from '../src/shared/story-mark';

// A profile highlight opens at /stories/<set>/ with the card only in the query —
// one path segment, not two. Requiring two meant this surface produced no mark at
// all, so Now Playing had nothing to anchor a highlight on and stayed empty while
// the Library filled with the very same captures.
const HIGHLIGHT_PATH = '/stories/976731645401448/';
const CARD_DOM_ID = 'UzM6NTU1NTU1NTU1NTU1NTU1';

test('a profile highlight path is a story path, with or without a trailing card segment', () => {
  assert.equal(isStoryPath(HIGHLIGHT_PATH), true, 'one-segment highlight');
  assert.equal(isStoryPath('/stories/976731645401448'), true, 'without the trailing slash');
  assert.equal(isStoryPath('/stories/owner-name/url-card-id/'), true, 'the two-segment tray form');
  assert.equal(isStoryPath('/reel/123456789/'), false);
});

test('a highlight card still earns a durable mark from its DOM id', () => {
  // The DOM id is what makes a mark durable; the URL's second segment is only the
  // fallback. A highlight has no second segment, so before this it got neither.
  assert.equal(storyCardMark(HIGHLIGHT_PATH, CARD_DOM_ID), `u:976731645401448/${CARD_DOM_ID}`);
  assert.equal(isDurableStoryMark(storyCardMark(HIGHLIGHT_PATH, CARD_DOM_ID)), true);
});

test('a highlight with no DOM id yields no mark rather than one every slide shares', () => {
  // `p:976731645401448/undefined` would give every slide of the highlight the same
  // provisional identity — worse than none, because it compares equal across cards.
  assert.equal(storyCardMark(HIGHLIGHT_PATH), '');
});

test('uses a durable u: marker when the active story card exposes a DOM id', () => {
  assert.equal(
    storyCardMark('/stories/owner-name/url-card-id/', 'UzM6NTU1NTU1NTU1NTU1NTU1'),
    'u:owner-name/UzM6NTU1NTU1NTU1NTU1NTU1',
  );
});

test('uses a provisional p: marker when only the tray-pinned URL card is available', () => {
  assert.equal(storyCardMark('/stories/owner-name/url-card-id/'), 'p:owner-name/url-card-id');
});

test('rejects a Uz-shaped data id that does not decode to a Story card', () => {
  const unrelated = Buffer.from('S4:555555555555555').toString('base64');

  assert.equal(isStoryDomId(unrelated), false);
  assert.equal(storyCardMark('/stories/owner-name/url-card-id/', unrelated), 'p:owner-name/url-card-id');
});

test('returns no story marker away from a story path', () => {
  assert.equal(storyCardMark('/reel/123456789/'), '');
});

test('isStoryPath agrees with storyCardMark on which paths yield a marker', () => {
  assert.equal(isStoryPath('/stories/owner-name/url-card-id/'), true);
  assert.equal(isStoryPath('/reel/123456789/'), false);
  assert.equal(isStoryPath('/'), false);
});

test('classifies durable and provisional marks by their minted prefix', () => {
  const durable = storyCardMark('/stories/owner/card/', 'UzM6NTU1NTU1NTU1NTU1NTU1');
  const provisional = storyCardMark('/stories/owner/card/');

  assert.equal(isDurableStoryMark(durable), true);
  assert.equal(isProvisionalStoryMark(durable), false);
  assert.equal(isDurableStoryMark(provisional), false);
  assert.equal(isProvisionalStoryMark(provisional), true);
});

test('strips MediaSource lifecycle noise only from a DOM-proven Story marker', () => {
  const durable = storyCardMark('/stories/owner/card/', 'UzM6NTU1NTU1NTU1NTU1NTU1');

  assert.equal(durableStoryMarkPortion(`${durable}#vm:epoch-a:1`), durable);
  assert.equal(durableStoryMarkPortion(`${durable}#https://video.xx.fbcdn.net/v/progressive.mp4`), durable);
  assert.equal(durableStoryMarkPortion(`${durable}#bounded-progressive-tail`), durable);
  assert.equal(isDurableStoryMark(`${durable}#vm:epoch-a:1`), true);
});

test('keeps legacy URL-derived u: markers ephemeral', () => {
  const legacy = 'u:owner/url-card#vm:epoch-a:1';

  assert.equal(durableStoryMarkPortion(legacy), undefined);
  assert.equal(isDurableStoryMark(legacy), false);
  assert.equal(durableStoryMarkPortion('u:/UzM6NTU1NTU1NTU1NTU1NTU1#vm:1'), undefined);
  assert.equal(durableStoryMarkPortion('u:owner/nested/UzM6NTU1NTU1NTU1NTU1NTU1#vm:1'), undefined);
});

test('an undefined or empty mark is neither durable nor provisional', () => {
  assert.equal(isDurableStoryMark(undefined), false);
  assert.equal(isProvisionalStoryMark(undefined), false);
  assert.equal(isDurableStoryMark(''), false);
  assert.equal(isProvisionalStoryMark(''), false);
});
