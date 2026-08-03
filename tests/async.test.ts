import assert from 'node:assert/strict';
import test from 'node:test';

import { withHeartbeat } from '../src/shared/async';

/** Return a promise that represents an active mux operation. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('resolves with the work when it finishes before going idle', async () => {
  const { promise } = withHeartbeat(Promise.resolve('done'), 50, 1000, 'timed out');

  assert.equal(await promise, 'done');
});

test('rejects once no progress arrives for the idle window', async () => {
  const { promise } = withHeartbeat(pending<string>(), 30, 1000, 'timed out');

  await assert.rejects(promise, { message: 'timed out' });
});

test('keeps waiting while progress keeps arriving', async () => {
  const { promise, beat } = withHeartbeat(pending<string>(), 40, 1000, 'timed out');
  // Regular beats keep a slow, active transfer alive past the initial wall-clock cap.
  for (let i = 0; i < 3; i++) {
    await wait(20);
    beat();
  }

  const raced = await Promise.race([promise.then(() => 'settled', () => 'rejected'), wait(1).then(() => 'still running')]);
  assert.equal(raced, 'still running');
});

test('gives up at the hard cap even while progress keeps arriving', async () => {
  const { promise, beat } = withHeartbeat(pending<string>(), 1000, 60, 'timed out');
  const beating = setInterval(beat, 10);

  await assert.rejects(promise, { message: 'timed out' });
  clearInterval(beating);
});

test('surfaces the work’s own rejection unchanged', async () => {
  const { promise } = withHeartbeat(Promise.reject(new Error('remux failed')), 50, 1000, 'timed out');

  await assert.rejects(promise, { message: 'remux failed' });
});

test('ignores beats after settling so a late report cannot rearm the timer', async (t) => {
  const { promise, beat } = withHeartbeat(Promise.resolve('done'), 20, 1000, 'timed out');
  assert.equal(await promise, 'done');

  // A beat on a settled wait must not schedule another timer.
  const spy = t.mock.method(globalThis, 'setTimeout');
  beat();
  assert.equal(spy.mock.callCount(), 0, 'a settled wait must not schedule a new idle timer');
});

test('armStarted restarts the hard cap, so queue wait is not charged to the job', async (t) => {
  // Rebase the hard cap when the queued job starts without moving its idle timer.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { promise, armStarted } = withHeartbeat(pending<string>(), 5_000, 200, 'timed out');
  let rejected = false;
  promise.catch(() => {
    rejected = true;
  });

  t.mock.timers.tick(120);
  armStarted();
  t.mock.timers.tick(120); // Pass the initial send-time deadline.
  await new Promise((r) => setImmediate(r)); // Drain rejection microtasks.
  assert.equal(rejected, false, 'the send-time hard cap must be replaced, not merely raced');

  // The rebased cap is still a cap: the wait terminates either way.
  t.mock.timers.tick(200);
  await assert.rejects(promise, { message: 'timed out' });
});

test('ignores armStarted after settling so a late job-started signal cannot rearm it', async (t) => {
  const { promise, armStarted } = withHeartbeat(Promise.resolve('done'), 20, 30, 'timed out');
  assert.equal(await promise, 'done');

  // A duplicate or delayed start event must not arm a timer for a settled wait.
  const spy = t.mock.method(globalThis, 'setTimeout');
  armStarted();
  assert.equal(spy.mock.callCount(), 0, 'a settled wait must not schedule a new hard cap');
});
