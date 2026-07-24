import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  normalizeSettings,
  parseMaxItemsInput,
  sanitizeMaxItemsInput,
  saveSettings,
} from '../src/shared/settings';

beforeEach(resetChromeStorage);

test('sanitizeMaxItemsInput keeps only ASCII decimal digits', () => {
  assert.equal(sanitizeMaxItemsInput(' 12a-٣.4e5 '), '1245');
});

test('parseMaxItemsInput accepts zero as the unlimited sentinel', () => {
  assert.equal(parseMaxItemsInput('0'), 0);
});

test('parseMaxItemsInput accepts a custom nonnegative safe integer', () => {
  assert.equal(parseMaxItemsInput('237'), 237);
});

test('parseMaxItemsInput accepts Number.MAX_SAFE_INTEGER', () => {
  assert.equal(parseMaxItemsInput(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test('parseMaxItemsInput rejects an empty value', () => {
  assert.equal(parseMaxItemsInput(''), undefined);
});

test('parseMaxItemsInput rejects non-decimal integer syntax', () => {
  for (const value of ['-1', '+1', '12.5', '1e3', ' 12 ', 'abc', '٣']) {
    assert.equal(parseMaxItemsInput(value), undefined, value);
  }
});

test('parseMaxItemsInput rejects an unsafe integer', () => {
  assert.equal(parseMaxItemsInput('9007199254740992'), undefined);
});

test('normalizeSettings preserves a custom nonnegative safe integer', () => {
  assert.equal(normalizeSettings({ maxItems: 237 }).maxItems, 237);
});

test('normalizeSettings preserves zero as the unlimited sentinel', () => {
  assert.equal(normalizeSettings({ maxItems: 0 }).maxItems, 0);
});

test('normalizeSettings replaces invalid maxItems values with the default', () => {
  const invalid = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1];
  for (const maxItems of invalid) {
    assert.equal(normalizeSettings({ maxItems }).maxItems, DEFAULT_SETTINGS.maxItems, String(maxItems));
  }
});

test('saveSettings persists a custom maxItems value through loadSettings', async () => {
  await saveSettings({ maxItems: 237 });

  assert.equal((await loadSettings()).maxItems, 237);
});

test('saveSettings preserves concurrent patches to different settings', async () => {
  await Promise.all([saveSettings({ maxItems: 237 }), saveSettings({ confirmClear: true })]);

  const stored = await loadSettings();
  assert.deepEqual(
    { maxItems: stored.maxItems, confirmClear: stored.confirmClear },
    { maxItems: 237, confirmClear: true },
  );
});

test('defaults theme preference to automatic', () => {
  assert.equal(DEFAULT_SETTINGS.theme, 'auto');
  assert.equal(normalizeSettings({}).theme, 'auto');
});

test('normalizeSettings preserves every supported theme preference', () => {
  for (const theme of ['auto', 'light', 'dark'] as const) {
    assert.equal(normalizeSettings({ theme }).theme, theme);
  }
});

test('normalizeSettings replaces an invalid theme preference with automatic', () => {
  for (const theme of ['', 'system', 'facebook', true, null]) {
    assert.equal(normalizeSettings({ theme }).theme, 'auto', String(theme));
  }
});

test('saveSettings persists a manual theme preference through loadSettings', async () => {
  await saveSettings({ theme: 'light' });

  assert.equal((await loadSettings()).theme, 'light');
});
