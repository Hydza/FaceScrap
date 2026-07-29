import assert from 'node:assert/strict';
import test from 'node:test';

import { DIAG_REASONS, diagBump, diagDrain, sanitizeDiagCounters } from '../src/shared/diag';

// B3 (foundations half): content.ts's mediaIngressBudget.tryTake() rejection
// used to drop an already-sanitized batch with no matching DiagReason, so the
// discard was unobservable. This locks in the vocabulary entry the
// content-script lane wires diagBump up to. Registering a reason takes two
// steps in this file — the DiagReason union member and the DIAG_REASONS
// array entry — and dropping either half silently makes the counter
// invisible again (a type-only union member never survives
// sanitizeDiagCounters's array-driven whitelist; an array-only entry never
// type-checks at a diagBump call site).
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
