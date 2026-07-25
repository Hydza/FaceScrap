// R6 — dashChain (service-worker.ts) and offscreen.ts's muxQueue independently
// grew the exact same `chain = job.catch(() => {}); return job;` serial-queue
// shape. Converged onto one shared helper (createJobChain, shared/async.ts).
// storage.ts's serialQueue, settings.ts's createSettingsPatchWriter and
// diag-observer.ts's flushChain are DIFFERENT contracts (see async.ts's own
// doc comment) and were deliberately left alone — not covered here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createJobChain } from '../src/shared/async';

const ROOT = process.cwd();
const worker = readFileSync(join(ROOT, 'src', 'background', 'service-worker.ts'), 'utf8');
const offscreen = readFileSync(join(ROOT, 'src', 'offscreen', 'offscreen.ts'), 'utf8');

test('R6: createJobChain serializes jobs — the second starts only once the first settles', async () => {
  const events: string[] = [];
  const enqueue = createJobChain<void>();
  let releaseFirst: () => void = () => {};
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueue(async () => {
    events.push('first-start');
    await firstGate;
    events.push('first-end');
  });
  const second = enqueue(async () => {
    events.push('second-start');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first-start'], 'the second job must not start before the first settles');

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start']);
});

test('R6: a rejected job does not wedge the chain, but its OWN caller still sees the rejection', async () => {
  const enqueue = createJobChain<string>();

  const failing = enqueue(async () => {
    throw new Error('boom');
  });
  const after = enqueue(async () => 'ok');

  await assert.rejects(failing, /boom/);
  assert.equal(await after, 'ok', 'a job queued behind a failed one must still run');
});

// service-worker.ts / offscreen.ts wire up chrome.* and timers as an
// unconditional module side effect and cannot run under node:test (same
// constraint as tests/fix-content.test.ts), so the convergence itself is
// checked on the source text: both must now build their chain from the
// shared helper, and the old hand-rolled `chain = job.catch(() => {})`
// reassignment must be gone from both.
test('R6: service-worker.ts builds dashChain from the shared createJobChain helper', () => {
  assert.match(
    worker,
    /import\s*\{[^}]*\bcreateJobChain\b[^}]*\}\s*from\s*['"]\.\.\/shared\/async['"]/s,
  );
  assert.ok(worker.includes('const dashChain = createJobChain<void>();'));
  assert.doesNotMatch(
    worker,
    /dashChain = job\.catch\(\(\) => \{\}\);/,
    'the old hand-rolled chain reassignment must be gone from service-worker.ts',
  );
});

test('R6: offscreen.ts builds muxQueue from the shared createJobChain helper', () => {
  assert.match(
    offscreen,
    /import\s*\{\s*createJobChain\s*\}\s*from\s*['"]\.\.\/shared\/async['"]/,
  );
  assert.ok(offscreen.includes('const muxQueue = createJobChain<string>();'));
  assert.doesNotMatch(
    offscreen,
    /muxQueue = job\.catch\(\(\) => \{\}\);/,
    'the old hand-rolled chain reassignment must be gone from offscreen.ts',
  );
});
