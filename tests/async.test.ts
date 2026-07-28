import assert from 'node:assert/strict';
import test from 'node:test';

import { withHeartbeat } from '../src/shared/async';

/** A promise that never settles — stands in for a mux the offscreen is still working on. */
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
  // Three beats inside the idle window carry this well past a 40ms wall-clock cap —
  // the case the old MUX_TIMEOUT_MS killed: a large track on a slow-but-steady link.
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

  // A rearmed timer could never SURFACE — the race already settled and its
  // rejection would land handled — so observe the timer itself: a beat on a
  // settled wait must not schedule anything.
  const spy = t.mock.method(globalThis, 'setTimeout');
  beat();
  assert.equal(spy.mock.callCount(), 0, 'a settled wait must not schedule a new idle timer');
});

test('armStarted restarts the hard cap, so queue wait is not charged to the job', async (t) => {
  // The panel arms this at send time and rebases it when the worker reports the job
  // has actually left dashChain. Without the rebase, a request queued behind a long
  // merge burns its whole budget queueing and is tagged Failed over work the worker
  // is still entitled to finish. A beat cannot express this: it moves the IDLE timer.
  // Mocked timers: the margins are logical, so a slow event loop cannot flake this.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { promise, armStarted } = withHeartbeat(pending<string>(), 5_000, 200, 'timed out');
  let rejected = false;
  promise.catch(() => {
    rejected = true;
  });

  t.mock.timers.tick(120);
  armStarted();
  t.mock.timers.tick(120); // now past the original 200ms send-time deadline
  await new Promise((r) => setImmediate(r)); // drain the microtasks a rejection rides
  assert.equal(rejected, false, 'the send-time hard cap must be replaced, not merely raced');

  // The rebased cap is still a cap: the wait terminates either way.
  t.mock.timers.tick(200);
  await assert.rejects(promise, { message: 'timed out' });
});

test('ignores armStarted after settling so a late job-started signal cannot rearm it', async (t) => {
  const { promise, armStarted } = withHeartbeat(Promise.resolve('done'), 20, 30, 'timed out');
  assert.equal(await promise, 'done');

  // A duplicate or delayed FACESCRAP_DASH_JOB_STARTED must not arm a timer against a
  // promise nobody is awaiting anymore — same guard as the beat, other entry point.
  // Observed at the timer, like the beat test above: the settled race would swallow
  // any late rejection, so a scheduled timeout is the only tell.
  const spy = t.mock.method(globalThis, 'setTimeout');
  armStarted();
  assert.equal(spy.mock.callCount(), 0, 'a settled wait must not schedule a new hard cap');
});
