// The custom resolution listbox must expose native-equivalent roles, state, and dismissal behavior.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { panelSource } from './panel-source';

const ROOT = process.cwd();
const html = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
const css = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.css'), 'utf8');
const controller = panelSource();

test('no native select survives anywhere in the panel', () => {
  // Keep the custom listbox as the only resolution control.
  assert.doesNotMatch(html, /<select\b/, 'the panel builds its own listbox');
  assert.doesNotMatch(css, /::picker\(select\)/, 'no native picker left to style');
  assert.doesNotMatch(css, /appearance:\s*base-select/);
});

test('the trigger announces itself as what it opens', () => {
  const trigger = html.match(/<button\b[^>]*id="now-qtrigger"[^>]*>/)?.[0];
  assert.ok(trigger, 'missing #now-qtrigger');
  assert.match(trigger, /type="button"/);
  assert.match(trigger, /aria-haspopup="listbox"/);
  // Use one expanded attribute for initial state and caret rotation.
  assert.match(trigger, /aria-expanded="false"/);
  assert.match(css, /\.picker-trigger\[aria-expanded="true"\] \.picker-caret\s*\{[^}]*rotate\(180deg\)/s);
  // Associate the value-only trigger with the field label.
  assert.match(trigger, /aria-labelledby="now-quality-label now-qlabel"/);

  const list = html.match(/<div\b[^>]*id="now-qlist"[^>]*>/)?.[0];
  assert.ok(list, 'missing #now-qlist');
  assert.match(list, /role="listbox"/);
  assert.match(list, /\bhidden\b/, 'the list opens closed');
  assert.match(list, /data-i18n-aria="ariaResolutionList"/);
});

test('every row is an option that states whether it is the chosen one', () => {
  assert.match(controller, /row\.setAttribute\('role',\s*'option'\)/);
  assert.match(controller, /row\.setAttribute\('aria-selected',\s*String\(option\.id === target\.id\)\)/);
  // Drive visual and announced selection from the same attribute.
  assert.match(css, /\.picker-row\[aria-selected="true"\]\s*\{[^}]*background:\s*rgba\(var\(--acrgb\), 0\.16\)/s);
  assert.match(css, /\.picker-row\[aria-selected="true"\] \.picker-tick\s*\{[^}]*visibility:\s*visible/s);
});

test('offers the three ways out of an open list that a native popup gave for free', () => {
  // Dismiss on Escape, outside clicks, and committed selections.
  assert.match(controller, /document\.addEventListener\('pointerdown'/);
  assert.match(controller, /if \(e\.key === 'Escape'\)/);
  assert.match(controller, /closeResolutionPicker\(\)/);
  // Wrap arrow-key navigation across option rows.
  assert.match(controller, /e\.key !== 'ArrowDown' && e\.key !== 'ArrowUp'/);
  // Stop Escape after closing the list so it does not close Settings too.
  assert.match(controller, /e\.stopPropagation\(\); \/\/ Escape also closes the Settings sheet/);
});

test('the open list holds the render off, and cannot hold it forever', () => {
  // Hold option updates while the list is open, with an expiry for busy tabs.
  assert.match(controller, /isResolutionPickerOpen\(\) \? RENDER_HOLD_MAX_MS : 0/);
  assert.match(controller, /const RENDER_HOLD_MAX_MS = 10_000/);
  assert.match(controller, /const RENDER_HOLD_RETRY_MS = 500/);
});
