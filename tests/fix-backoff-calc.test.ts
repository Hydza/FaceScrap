// ALT4 — of FaceScrap's five capture/ack retry policies (media, theme,
// playing, bindings, pin — see acked-latest.ts's header comment for the full
// map), two are exponential: content.ts's media-relay retry (500ms base,
// capped 10s) and now-playing.ts's binding-flush retry (250ms base, capped
// 8s). Both hand-rolled the identical `Math.min(cap, base * 2 **
// Math.min(n, 5))` formula independently. Extracted the shared MATH only
// (exponentialBackoffMs) — the counter bookkeeping and cadence around it stay
// at each call site on purpose (see async.ts's doc comment); the other three
// channels' scheduling is documentation-only and not touched here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { exponentialBackoffMs } from '../src/shared/async';

const ROOT = process.cwd();
const content = readFileSync(join(ROOT, 'src', 'content', 'content.ts'), 'utf8');
const nowPlaying = readFileSync(join(ROOT, 'src', 'shared', 'now-playing.ts'), 'utf8');

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

// content.ts cannot run under node:test (see tests/fix-content.test.ts's
// header), so its call site is checked on the source text: it must now call
// through the shared helper, and the old inline formula must be gone.
test("ALT4: content.ts's pumpMedia computes its retry delay through exponentialBackoffMs", () => {
  assert.match(
    content,
    /import\s*\{[^}]*\bexponentialBackoffMs\b[^}]*\}\s*from\s*['"]\.\.\/shared\/async['"]/s,
  );
  assert.ok(
    content.includes(
      'const retryMs = exponentialBackoffMs(mediaRetryFailures - 1, MEDIA_RETRY_BASE_MS, MEDIA_RETRY_MAX_MS);',
    ),
  );
  assert.doesNotMatch(
    content,
    /MEDIA_RETRY_BASE_MS \* \(2 \*\* /,
    'the old inline exponential formula must be gone from pumpMedia',
  );
});

test("ALT4: now-playing.ts's retryBindings computes its retry delay through exponentialBackoffMs", () => {
  assert.match(
    nowPlaying,
    /import\s*\{[^}]*\bexponentialBackoffMs\b[^}]*\}\s*from\s*['"]\.\/async['"]/s,
  );
  assert.ok(
    nowPlaying.includes('const delay = exponentialBackoffMs(outbox.retry++, BIND_RETRY_MIN_MS, BIND_RETRY_MAX_MS);'),
  );
  assert.doesNotMatch(
    nowPlaying,
    /BIND_RETRY_MIN_MS \* 2 \*\* /,
    'the old inline exponential formula must be gone from retryBindings',
  );
});
