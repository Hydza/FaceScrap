import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiagObserver } from '../src/background/diag-observer';
import type { DiagCounters } from '../src/shared/diag';

function harness(options: { maxTabs?: number; maxCountPerReason?: number } = {}) {
  const writes: DiagCounters[] = [];
  const scheduled: Array<() => void> = [];
  const observer = createDiagObserver({
    write: async (delta) => {
      writes.push({ ...delta });
    },
    schedule: (task) => {
      scheduled.push(task);
      return task;
    },
    cancel: (handle) => {
      const index = scheduled.indexOf(handle as () => void);
      if (index >= 0) scheduled.splice(index, 1);
    },
    ...options,
  });
  return { observer, scheduled, writes };
}

test('ignores page reports while diagnostics are disabled', async () => {
  const { observer, scheduled, writes } = harness();

  assert.equal(observer.report(1, { captureGraphql: 5 }), false);
  assert.equal(scheduled.length, 0);
  await observer.flush();
  assert.deepEqual(writes, []);
});

test('coalesces tabs and worker counters into one bounded write', async () => {
  const writes: DiagCounters[] = [];
  const observer = createDiagObserver({
    maxCountPerReason: 10,
    workerCounters: { drain: () => ({ captureNetwork: 4 }), setEnabled: () => {} },
    write: async (delta) => {
      writes.push({ ...delta });
    },
    schedule: () => 1,
    cancel: () => {},
  });
  observer.setEnabled(true);

  assert.equal(observer.report(1, { captureGraphql: 6, notAReason: 99 }), true);
  assert.equal(observer.report(1, { captureGraphql: 7 }), true);
  assert.equal(observer.report(2, { captureDom: 3 }), true);
  await observer.flush();

  assert.deepEqual(writes, [{ captureGraphql: 10, captureDom: 3, captureNetwork: 4 }]);
});

test('bounds pending tabs and removes a closed tab before flush', async () => {
  const { observer, writes } = harness({ maxTabs: 2 });
  observer.setEnabled(true);

  assert.equal(observer.report(10, { captureDom: 1 }), true);
  assert.equal(observer.report(11, { captureDom: 2 }), true);
  assert.equal(observer.report(12, { captureDom: 4 }), false);
  observer.removeTab(10);
  await observer.flush();

  assert.deepEqual(writes, [{ captureDom: 2 }]);
});

test('disabling clears pending reports and the scheduled flush', async () => {
  const { observer, scheduled, writes } = harness();
  observer.setEnabled(true);
  observer.report(1, { scanQueueEvicted: 2 });
  assert.equal(scheduled.length, 1);

  observer.setEnabled(false);
  assert.equal(scheduled.length, 0);
  await observer.flush();
  assert.deepEqual(writes, []);
});

test('retains the aggregate when a storage write fails transiently', async () => {
  const writes: DiagCounters[] = [];
  let attempts = 0;
  const observer = createDiagObserver({
    write: async (delta) => {
      attempts++;
      if (attempts === 1) throw new Error('local storage busy');
      writes.push({ ...delta });
    },
    schedule: () => 1,
    cancel: () => {},
  });
  observer.setEnabled(true);
  observer.report(1, { captureGraphql: 3 });

  await assert.rejects(observer.flush(), /local storage busy/);
  await observer.flush();
  assert.deepEqual(writes, [{ captureGraphql: 3 }]);
});

test('a counter the worker raises itself is persisted once diagnostics are on', async () => {
  // The observer owns two flags, and only one of them was ever set. `enabled` decides
  // whether renderer reports are persisted; diag.ts's own flag decides whether a
  // diagBump in the WORKER counts at all — and while it stayed false, every counter
  // the worker raises for itself was a no-op that reached the panel as zero.
  const { diagBump, diagDrain, setDiagEnabled } = await import('../src/shared/diag');
  const writes: DiagCounters[] = [];
  const observer = createDiagObserver({
    write: async (delta) => {
      writes.push({ ...delta });
    },
    workerCounters: { drain: diagDrain, setEnabled: setDiagEnabled },
    schedule: () => 1,
    cancel: () => {},
  });
  try {
    observer.setEnabled(true);
    diagBump('captureNetwork');
    diagBump('buttonHidden', 3);
    await observer.flush();
    assert.deepEqual(writes, [{ captureNetwork: 1, buttonHidden: 3 }]);

    // Re-asserting the same value must not clear what has accumulated since: the worker
    // calls setEnabled on every settings write, and diag.ts clears its counters whenever
    // its flag is set. Losing them there would empty the report whenever the user changed
    // any unrelated setting mid-reproduction.
    diagBump('captureNetwork', 2);
    observer.setEnabled(true);
    await observer.flush();
    assert.deepEqual(writes[1], { captureNetwork: 2 });
  } finally {
    observer.setEnabled(false);
  }
});

test('turning diagnostics off stops counting in the worker too', async () => {
  const { diagBump, diagDrain, setDiagEnabled } = await import('../src/shared/diag');
  const writes: DiagCounters[] = [];
  const observer = createDiagObserver({
    write: async (delta) => {
      writes.push({ ...delta });
    },
    workerCounters: { drain: diagDrain, setEnabled: setDiagEnabled },
    schedule: () => 1,
    cancel: () => {},
  });
  observer.setEnabled(true);
  observer.setEnabled(false);
  diagBump('captureNetwork');
  observer.setEnabled(true);
  await observer.flush();
  assert.deepEqual(writes, [], 'a bump raised while off must not surface when it is turned back on');
  observer.setEnabled(false);
});
