import assert from 'node:assert/strict';
import test from 'node:test';

import { combineVideoMark, createVideoMarkFactory } from '../src/shared/video-mark';

test('keeps one marker per load and advances for a new load', () => {
  const mark = createVideoMarkFactory('epoch-a');
  const firstLoad = {};

  assert.equal(mark(firstLoad, 'blob:first'), 'vm:epoch-a:1');
  assert.equal(mark(firstLoad, 'blob:first'), 'vm:epoch-a:1');
  assert.equal(mark({}, 'blob:second'), 'vm:epoch-a:2');
});

test('does not recycle vm:1 across content-script epochs', () => {
  const key = {};

  assert.notEqual(createVideoMarkFactory('epoch-a')(key, ''), createVideoMarkFactory('epoch-b')(key, ''));
});

test('preserves and bounds progressive source markers', () => {
  const mark = createVideoMarkFactory('epoch-a');
  const source = `https://video.xx.fbcdn.net/${'a'.repeat(220)}`;

  assert.equal(mark({}, source), source.slice(0, 200));
});

test('advances the mark between reels even when the load key is reused', () => {
  const mark = createVideoMarkFactory('epoch-a');
  // Do not let a shared MediaSource marker collapse two reel IDs.
  const reusedKey = {};
  const first = combineVideoMark(mark(reusedKey, ''), '111111111');
  const second = combineVideoMark(mark(reusedKey, ''), '222222222');

  assert.notEqual(first, second);
});

test('leaves the mark untouched where no reel id exists', () => {
  // Omitted video IDs must not alter Story markers.
  assert.equal(combineVideoMark('vm:epoch-a:1', undefined), 'vm:epoch-a:1');
});

test('keeps the reel id clear of the story/video mark separator', () => {
  // Remove inner separators before joining Story and video markers.
  assert.equal(combineVideoMark('vm:epoch-a:1', '123456789').includes('#'), false);
});

test('strips an inner "#" from a progressive source mark before capping it', () => {
  // Remove URL fragments that could mimic the Story/video separator.
  const mark = createVideoMarkFactory('epoch-a');

  assert.equal(mark({}, 'https://video.xx.fbcdn.net/clip.mp4#t=10').includes('#'), false);
});
