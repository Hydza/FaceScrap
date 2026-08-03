// Media and binding retries share exponentialBackoffMs while keeping
// channel-specific counters, base delays, caps, and scheduling cadence.
import assert from 'node:assert/strict';
import test from 'node:test';

import { exponentialBackoffMs } from '../src/shared/async';

test("ALT4: exponentialBackoffMs matches the media channel's 500ms base, 10s cap formula", () => {
  const base = 500;
  const cap = 10_000;
  assert.equal(exponentialBackoffMs(0, base, cap), 500, 'the first retry must be exactly the base delay');
  assert.equal(exponentialBackoffMs(1, base, cap), 1_000);
  assert.equal(exponentialBackoffMs(2, base, cap), 2_000);
  assert.equal(exponentialBackoffMs(3, base, cap), 4_000);
  assert.equal(exponentialBackoffMs(4, base, cap), 8_000);
  assert.equal(exponentialBackoffMs(5, base, cap), 10_000, 'clamped by the cap, not 500 * 2^5 = 16000');
  assert.equal(exponentialBackoffMs(50, base, cap), 10_000, 'a huge attempt count must not overflow the exponent');
});

test("ALT4: exponentialBackoffMs matches the bindings channel's 250ms base, 8s cap formula", () => {
  const base = 250;
  const cap = 8_000;
  assert.equal(exponentialBackoffMs(0, base, cap), 250);
  assert.equal(exponentialBackoffMs(1, base, cap), 500);
  assert.equal(exponentialBackoffMs(4, base, cap), 4_000);
  assert.equal(exponentialBackoffMs(5, base, cap), 8_000, '250 * 2^5 = 8000, exactly the cap');
  assert.equal(exponentialBackoffMs(6, base, cap), 8_000, 'the exponent must stay clamped past 5');
});

test('ALT4: a negative attempt still clamps to the base delay', () => {
  assert.equal(exponentialBackoffMs(-1, 500, 10_000), 500);
});
