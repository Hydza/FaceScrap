import assert from 'node:assert/strict';
import test from 'node:test';

import { DIAG_REASONS, diagBump, diagDrain, sanitizeDiagCounters } from '../src/shared/diag';

// Keep the ingress-rejection reason in the runtime whitelist so it survives sanitization.
function reset(): void {
  diagDrain();
}

test('mediaIngressRejected is a registered diag reason', () => {
  assert.ok(DIAG_REASONS.includes('mediaIngressRejected'));
});

test('mediaIngressRejected counts like any other reason', () => {
  reset();

  diagBump('mediaIngressRejected', 2);
  diagBump('mediaIngressRejected');

  assert.deepEqual(diagDrain(), { mediaIngressRejected: 3 });
});

test('mediaIngressRejected survives the cross-world sanitization whitelist', () => {
  assert.deepEqual(sanitizeDiagCounters({ mediaIngressRejected: 4, notAReason: 1 }), {
    mediaIngressRejected: 4,
  });
});
