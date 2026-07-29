import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCounterCoalescer,
  diagBump,
  diagDrain,
  diagSnapshot,
  sanitizeDiagCounters,
} from '../src/shared/diag';

// The module keeps process-wide counters (one instance per bundled context in
// production), so every test starts from a known-empty state. Draining is now the only
// thing that empties them — there is no flag left whose clearing did it as a side effect.
function reset(): void {
  diagDrain();
}

test('accumulates repeated bumps of the same reason', () => {
  reset();

  diagBump('jsonLineTooLarge');
  diagBump('jsonLineTooLarge');
  diagBump('captureGraphql', 12);

  assert.deepEqual(diagSnapshot(), { jsonLineTooLarge: 2, captureGraphql: 12 });
});

test('drains the counters and leaves them empty', () => {
  reset();
  diagBump('scanQueueEvicted', 3);

  assert.deepEqual(diagDrain(), { scanQueueEvicted: 3 });
  assert.deepEqual(diagSnapshot(), {});
});

test('keeps only known reasons when sanitizing an untrusted payload', () => {
  assert.deepEqual(sanitizeDiagCounters({ jsonLineTooLarge: 2, notAReason: 9 }), { jsonLineTooLarge: 2 });
});

test('rejects counter values that are not usable counts', () => {
  const raw = {
    jsonLineTooLarge: -1,
    scanQueueEvicted: Number.NaN,
    harvestDepthExceeded: Number.POSITIVE_INFINITY,
    mpdParseError: 1.5,
    captureGraphql: '4',
  };

  assert.deepEqual(sanitizeDiagCounters(raw), {});
});

test('sanitizes a non-object payload to an empty report', () => {
  assert.deepEqual(sanitizeDiagCounters(null), {});
  assert.deepEqual(sanitizeDiagCounters('jsonLineTooLarge'), {});
});

test('sanitization reads only the fixed diagnostic whitelist', () => {
  const guarded = new Proxy({ captureDom: 2 }, {
    ownKeys() {
      throw new Error('must not enumerate attacker-supplied keys');
    },
  });

  assert.deepEqual(sanitizeDiagCounters(guarded), { captureDom: 2 });
});

test('counter coalescer combines reports, saturates, and drains once', () => {
  type Reason = 'graphql' | 'dom';
  const coalescer = createCounterCoalescer<Reason>();

  coalescer.add({ graphql: Number.MAX_SAFE_INTEGER - 2, dom: 1 });
  coalescer.add({ graphql: 10, dom: 2 });

  assert.deepEqual(coalescer.drain(), {
    graphql: Number.MAX_SAFE_INTEGER,
    dom: 3,
  });
  assert.deepEqual(coalescer.drain(), {});
});
