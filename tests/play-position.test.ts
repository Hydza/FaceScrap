import assert from 'node:assert/strict';
import test from 'node:test';
import { computePlayCenterY, createPlayPositionBatcher } from '../src/sidepanel/play-position';

test('centers landscape contain media inside its sharp letterboxed area', () => {
  assert.equal(
    computePlayCenterY({
      frameWidth: 400,
      frameHeight: 700,
      mediaWidth: 1600,
      mediaHeight: 900,
      fit: 'contain',
      unobscuredBottom: 560,
      badgeSize: 50,
      clearance: 12,
    }),
    350,
  );
});

test('moves portrait cover media above the overlaid controls', () => {
  assert.equal(
    computePlayCenterY({
      frameWidth: 400,
      frameHeight: 700,
      mediaWidth: 1080,
      mediaHeight: 1920,
      fit: 'cover',
      unobscuredBottom: 560,
      badgeSize: 50,
      clearance: 12,
    }),
    280,
  );
});

test('uses only the unobscured portion when controls overlap contained media', () => {
  assert.equal(
    computePlayCenterY({
      frameWidth: 400,
      frameHeight: 700,
      mediaWidth: 1000,
      mediaHeight: 1000,
      fit: 'contain',
      unobscuredBottom: 500,
      badgeSize: 50,
      clearance: 12,
    }),
    325,
  );
});

test('hides the badge when the safe visible area is too small', () => {
  assert.equal(
    computePlayCenterY({
      frameWidth: 320,
      frameHeight: 180,
      fit: 'cover',
      unobscuredBottom: 60,
      badgeSize: 50,
      clearance: 12,
    }),
    null,
  );
});

test('batches only the media containers whose thumbnails loaded', () => {
  const frames: Array<() => void> = [];
  const flushed: Array<readonly string[] | null> = [];
  const batcher = createPlayPositionBatcher<string>(
    (callback) => {
      frames.push(callback);
      return frames.length;
    },
    (targets) => flushed.push(targets),
  );

  batcher.schedule('card-a');
  batcher.schedule('card-a');
  batcher.schedule('card-b');

  assert.equal(frames.length, 1);
  frames[0]();
  assert.deepEqual(flushed, [['card-a', 'card-b']]);
});

test('a global resize supersedes pending per-card measurements', () => {
  const frames: Array<() => void> = [];
  const flushed: Array<readonly string[] | null> = [];
  const batcher = createPlayPositionBatcher<string>(
    (callback) => {
      frames.push(callback);
      return frames.length;
    },
    (targets) => flushed.push(targets),
  );

  batcher.schedule('card-a');
  batcher.schedule();
  batcher.schedule('card-b');
  frames[0]();

  assert.deepEqual(flushed, [null]);
});
