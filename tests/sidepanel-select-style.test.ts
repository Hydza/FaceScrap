// The resolution control used to be a native <select>, and three tests here pinned the
// native contract it came with: readable <option> colours on a dark panel, a rounded
// ::picker(select), a vertically centred closed trigger.
//
// It is now a listbox the panel builds itself — the design floats it over the media, and
// a native popup cannot float over anything. Everything the native element gave for free
// therefore has to be spelled out, which is what this file now holds: the roles, the
// state attributes, and the three ways out that a native popup handled on its own.

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
  // A single leftover <select> would carry the old chevron, the old radius and the old
  // popup surface, none of which this stylesheet defines any more.
  assert.doesNotMatch(html, /<select\b/, 'the panel builds its own listbox');
  assert.doesNotMatch(css, /::picker\(select\)/, 'no native picker left to style');
  assert.doesNotMatch(css, /appearance:\s*base-select/);
});

test('the trigger announces itself as what it opens', () => {
  const trigger = html.match(/<button\b[^>]*id="now-qtrigger"[^>]*>/)?.[0];
  assert.ok(trigger, 'missing #now-qtrigger');
  assert.match(trigger, /type="button"/);
  assert.match(trigger, /aria-haspopup="listbox"/);
  // Closed on load, and the caret rotation hangs off the same attribute — one source
  // for the state, so the glyph cannot disagree with what is announced.
  assert.match(trigger, /aria-expanded="false"/);
  assert.match(css, /\.picker-trigger\[aria-expanded="true"\] \.picker-caret\s*\{[^}]*rotate\(180deg\)/s);
  // The trigger's own text is a bare "1080p"; the field's label is what says what that
  // number IS.
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
  // The tick and the accent fill are driven by that same attribute rather than by a
  // second class, so a selected row cannot look chosen and announce otherwise.
  assert.match(css, /\.picker-row\[aria-selected="true"\]\s*\{[^}]*background:\s*rgba\(var\(--acrgb\), 0\.16\)/s);
  assert.match(css, /\.picker-row\[aria-selected="true"\] \.picker-tick\s*\{[^}]*visibility:\s*visible/s);
});

test('offers the three ways out of an open list that a native popup gave for free', () => {
  // Escape, a click anywhere outside, and committing a row. Without these the list is a
  // floating panel the keyboard cannot dismiss.
  assert.match(controller, /document\.addEventListener\('pointerdown'/);
  assert.match(controller, /if \(e\.key === 'Escape'\)/);
  assert.match(controller, /closeResolutionPicker\(\)/);
  // Arrows move between rows, wrapping, because the rows are buttons and Tab would
  // otherwise walk straight out of the list.
  assert.match(controller, /e\.key !== 'ArrowDown' && e\.key !== 'ArrowUp'/);
  // Escape must not ALSO close the Settings sheet on its way past — both listen on the
  // document, and one press has one meaning.
  assert.match(controller, /e\.stopPropagation\(\); \/\/ Escape also closes the Settings sheet/);
});

test('the open list holds the render off, and cannot hold it forever', () => {
  // A capture burst rebuilds the option rows; landing one mid-pick tears the row out
  // from under the click. The hold is now simply "is the list open", because the list
  // is the panel's own DOM — but it still expires, or a busy tab could freeze the view.
  assert.match(controller, /isResolutionPickerOpen\(\) \? RENDER_HOLD_MAX_MS : 0/);
  assert.match(controller, /const RENDER_HOLD_MAX_MS = 10_000/);
  assert.match(controller, /const RENDER_HOLD_RETRY_MS = 500/);
});
