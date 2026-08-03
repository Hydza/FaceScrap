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

test('refuses a report that names no real tab', async () => {
  // Reject reports that cannot be associated with a tab.
  const { observer, scheduled, writes } = harness();

  assert.equal(observer.report(-1, { captureGraphql: 5 }), false);
  assert.equal(scheduled.length, 0);
  await observer.flush();
  assert.deepEqual(writes, []);
});

test('coalesces tabs and worker counters into one bounded write', async () => {
  const writes: DiagCounters[] = [];
  const observer = createDiagObserver({
    maxCountPerReason: 10,
    workerCounters: { drain: () => ({ captureNetwork: 4 }) },
    write: async (delta) => {
      writes.push({ ...delta });
    },
    schedule: () => 1,
    cancel: () => {},
  });

  assert.equal(observer.report(1, { captureGraphql: 6, notAReason: 99 }), true);
  assert.equal(observer.report(1, { captureGraphql: 7 }), true);
  assert.equal(observer.report(2, { captureDom: 3 }), true);
  await observer.flush();

  assert.deepEqual(writes, [{ captureGraphql: 10, captureDom: 3, captureNetwork: 4 }]);
});

test('bounds pending tabs and removes a closed tab before flush', async () => {
  const { observer, writes } = harness({ maxTabs: 2 });

  assert.equal(observer.report(10, { captureDom: 1 }), true);
  assert.equal(observer.report(11, { captureDom: 2 }), true);
  assert.equal(observer.report(12, { captureDom: 4 }), false);
  observer.removeTab(10);
  await observer.flush();

  assert.deepEqual(writes, [{ captureDom: 2 }]);
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
  observer.report(1, { captureGraphql: 3 });

  await assert.rejects(observer.flush(), /local storage busy/);
  await observer.flush();
  assert.deepEqual(writes, [{ captureGraphql: 3 }]);
});

test('a counter the worker raises itself joins the renderer write', async () => {
  // Persist renderer reports and worker counters in one write.
  const { diagBump, diagDrain } = await import('../src/shared/diag');
  const writes: DiagCounters[] = [];
  const observer = createDiagObserver({
    write: async (delta) => {
      writes.push({ ...delta });
    },
    workerCounters: { drain: diagDrain },
    schedule: () => 1,
    cancel: () => {},
  });
  diagDrain(); // Reset module-level counters shared by this suite.

  diagBump('captureNetwork');
  diagBump('buttonHidden', 3);
  await observer.flush();

  assert.deepEqual(writes, [{ captureNetwork: 1, buttonHidden: 3 }]);
});
