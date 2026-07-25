import assert from 'node:assert/strict';
import test from 'node:test';

import {
  facebookThemeKey,
  facebookThemeRefAtReceipt,
  inferFacebookTheme,
  parseCssColor,
  resolveEffectiveTheme,
} from '../src/shared/theme';

test('facebookThemeKey namespaces the signal by tab', () => {
  assert.equal(facebookThemeKey(42), 'facebook_theme_42');
});

test('parseCssColor accepts computed rgb syntax and rejects transparent colors', () => {
  assert.deepEqual(parseCssColor('rgb(24, 25, 26)'), { red: 24, green: 25, blue: 26, alpha: 1 });
  assert.equal(parseCssColor('rgba(255, 255, 255, 0.8)'), undefined);
  assert.equal(parseCssColor('rgba(0, 0, 0, 0)'), undefined);
  assert.equal(parseCssColor('rgba(0, 0, 0, 0.1)'), undefined);
  assert.equal(parseCssColor('rgba(0, 0, 0, 0.74)'), undefined);
  assert.equal(parseCssColor('transparent'), undefined);
});

test('facebookThemeRefAtReceipt replaces an untrusted renderer timestamp with worker time', () => {
  assert.deepEqual(
    facebookThemeRefAtReceipt({ theme: 'dark', at: Number.MAX_SAFE_INTEGER }, 2_000),
    { theme: 'dark', at: 2_000 },
  );
  assert.equal(facebookThemeRefAtReceipt({ theme: 'dim', at: 1_000 }, 2_000), undefined);
  assert.equal(facebookThemeRefAtReceipt({ theme: 'light', at: 1_000 }, Number.NaN), undefined);
});

test('inferFacebookTheme uses document colors before the semantic main fallback', () => {
  assert.equal(inferFacebookTheme(['rgba(0, 0, 0, 0)', 'rgb(24, 25, 26)'], 'rgb(255, 255, 255)'), 'dark');
  assert.equal(inferFacebookTheme(['rgb(250, 250, 250)'], 'rgb(24, 25, 26)'), 'light');
});

test('inferFacebookTheme ignores ambiguous colors and then uses the semantic main fallback', () => {
  assert.equal(inferFacebookTheme(['rgb(128, 128, 128)', 'transparent'], 'rgb(18, 18, 18)'), 'dark');
  assert.equal(inferFacebookTheme(['rgb(128, 128, 128)'], 'rgb(130, 130, 130)'), undefined);
});

test('inferFacebookTheme treats conflicting document roots as ambiguous and consults main', () => {
  assert.equal(
    inferFacebookTheme(['rgb(250, 250, 250)', 'rgb(24, 25, 26)'], 'rgb(24, 25, 26)'),
    'dark',
  );
  assert.equal(
    inferFacebookTheme(['rgb(250, 250, 250)', 'rgb(24, 25, 26)'], 'rgb(128, 128, 128)'),
    undefined,
  );
});

test('resolveEffectiveTheme gives manual preference priority, then Facebook, then the system preference', () => {
  assert.equal(resolveEffectiveTheme('light', 'dark', 'dark'), 'light');
  assert.equal(resolveEffectiveTheme('dark', 'light', 'light'), 'dark');
  assert.equal(resolveEffectiveTheme('auto', 'dark', 'light'), 'dark');
  assert.equal(resolveEffectiveTheme('auto', undefined, 'dark'), 'dark');
  assert.equal(resolveEffectiveTheme('auto', undefined, 'light'), 'light');
});

test('parseCssColor reads CSS Color 4 space and slash-alpha forms and stays ambiguous when translucent', () => {
  // Space-separated channels, no alpha.
  assert.deepEqual(parseCssColor('rgb(24 25 26)'), { red: 24, green: 25, blue: 26, alpha: 1 });
  // Opaque slash alpha.
  assert.deepEqual(parseCssColor('rgba(10 20 30 / 1)'), { red: 10, green: 20, blue: 30, alpha: 1 });
  // Percentage channels resolve onto 0-255 (rounded to dodge 2.55x float noise).
  const pct = parseCssColor('rgb(0% 40% 80%)');
  assert.equal(pct?.red, 0);
  assert.equal(Math.round(pct?.green ?? -1), 102);
  assert.equal(Math.round(pct?.blue ?? -1), 204);
  // A translucent root cannot be classified without compositing every surface
  // beneath it → ambiguous, never a guessed theme.
  assert.equal(parseCssColor('rgb(0 0 0 / 0.5)'), undefined);
});
