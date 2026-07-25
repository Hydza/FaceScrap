import assert from 'node:assert/strict';
import test from 'node:test';

import { createFrameCoalescer } from '../src/content/detection-frame';

test('coalesces a burst of image loads into one playing detection per frame', () => {
  const callbacks: Array<() => void> = [];
  const cancelled: number[] = [];
  let nextHandle = 0;
  let runs = 0;
  const coalescer = createFrameCoalescer(
    () => {
      runs++;
    },
    (callback) => {
      callbacks.push(callback);
      return ++nextHandle;
    },
    (handle) => {
      cancelled.push(handle);
    },
  );

  for (let i = 0; i < 20; i++) coalescer.request();

  assert.equal(callbacks.length, 1);
  assert.equal(runs, 0);
  callbacks.shift()?.();
  assert.equal(runs, 1);

  coalescer.request();
  assert.equal(callbacks.length, 1);
  coalescer.cancel();
  assert.deepEqual(cancelled, [2]);
});
