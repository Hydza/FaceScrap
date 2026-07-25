import assert from 'node:assert/strict';
import test from 'node:test';

import { createSuccessDeduper, isRecentlyCompleted, withCompletion } from '../src/shared/success-deduper';

test('an interrupted attempt is never cached and Retry invokes the task again', async () => {
  let calls = 0;
  let clock = 10;
  const deduper = createSuccessDeduper(1_000, () => clock);
  const task = async (): Promise<void> => {
    calls++;
    if (calls === 1) throw new Error('interrupted');
  };

  await assert.rejects(deduper.run('pair', task), /interrupted/);
  await deduper.run('pair', task);
  assert.equal(calls, 2);
  assert.equal(deduper.inFlightCount, 0);

  await deduper.run('pair', task);
  assert.equal(calls, 2, 'a genuinely completed attempt is deduplicated');
  clock += 1_001;
  await deduper.run('pair', task);
  assert.equal(calls, 3);
});

test('concurrent duplicates share one terminal promise', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const deduper = createSuccessDeduper(1_000, () => 100);
  const first = deduper.run('pair', async () => {
    calls++;
    await gate;
  });
  const second = deduper.run('pair', async () => {
    calls++;
  });

  assert.equal(first, second);
  assert.equal(deduper.inFlightCount, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('a backwards clock sample invalidates success suppression', async () => {
  let clock = 100;
  let calls = 0;
  const deduper = createSuccessDeduper(1_000, () => clock);
  await deduper.run('pair', async () => {
    calls++;
  });
  clock = 50;
  await deduper.run('pair', async () => {
    calls++;
  });
  assert.equal(calls, 2);
});

// DedupSnapshot mirrors the in-memory `completed` map above into a plain,
// serializable object (see success-deduper.ts) so a caller can persist it
// (e.g. chrome.storage.session) and recognize success across a worker
// restart, which the Maps above cannot survive. Wall-clock-keyed by design —
// these tests use plain millisecond numbers standing in for Date.now().

test('isRecentlyCompleted matches a key within its window and rejects an elapsed or backwards-clock sample', () => {
  const snapshot = { 'pair-a': 1_000 };
  assert.equal(isRecentlyCompleted(snapshot, 'pair-a', 1_400, 500), true);
  assert.equal(isRecentlyCompleted(snapshot, 'pair-a', 1_600, 500), false, 'window elapsed');
  assert.equal(isRecentlyCompleted(snapshot, 'pair-a', 999, 500), false, 'backwards clock sample');
  assert.equal(isRecentlyCompleted(snapshot, 'pair-b', 1_400, 500), false, 'never recorded');
});

test('withCompletion prunes expired entries, keeps live ones, and never mutates its input', () => {
  const snapshot = { 'pair-a': 1_000, 'pair-b': 1_700 };
  const next = withCompletion(snapshot, 'pair-c', 1_800, 500);
  // pair-a (800ms old) is past the 500ms window and is dropped; pair-b (100ms
  // old) is still live and kept; pair-c is the fresh completion.
  assert.deepEqual(next, { 'pair-b': 1_700, 'pair-c': 1_800 });
  assert.deepEqual(snapshot, { 'pair-a': 1_000, 'pair-b': 1_700 }, 'withCompletion must not mutate its input');
});
