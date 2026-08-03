// Normalize every stored keymap so no two panel actions share a key.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { panelSource } from './panel-source';
import {
  COLUMN_CHOICES,
  DEFAULT_KEYMAP,
  DEFAULT_SETTINGS,
  isAssignableKey,
  KEY_ACTIONS,
  normalizeKeymap,
  normalizeSettings,
} from '../src/shared/settings';

/** Return every non-empty key binding. */
function boundKeys(map: Record<string, string>): string[] {
  return KEY_ACTIONS.map((action) => map[action]!).filter((key) => key !== '');
}

function assertNoDuplicates(map: Record<string, string>, why: string): void {
  const bound = boundKeys(map);
  assert.equal(new Set(bound).size, bound.length, `${why}: ${JSON.stringify(map)}`);
}

test('the shipped defaults bind every function to a distinct key', () => {
  assertNoDuplicates(DEFAULT_KEYMAP, 'defaults collide');
  assert.equal(boundKeys(DEFAULT_KEYMAP).length, KEY_ACTIONS.length, 'every function ships bound');
  for (const action of KEY_ACTIONS) {
    assert.ok(isAssignableKey(DEFAULT_KEYMAP[action]), `${action} ships an unassignable key`);
  }
});

test('a stored duplicate never survives normalization', () => {
  // Reassigning `d` to togglePick must unbind downloadCard.
  const map = normalizeKeymap({ togglePick: 'd' });
  assertNoDuplicates(map, 'a stored duplicate got through');
  assert.equal(map.togglePick, 'd', 'the earlier action keeps the key it asked for');
  // Leave the conflicting action unbound instead of sharing a key.
  assert.equal(map.downloadCard, '', 'the loser is unbound, not duplicated');
});

test('an unusable stored key falls back to its default', () => {
  // Reject values that cannot represent one printable shortcut key.
  const map = normalizeKeymap({
    downloadCard: 'Tab',
    selectAll: 'ArrowUp',
    downloadPicks: ' ',
    viewNow: 42,
    viewLibrary: null,
    viewSaved: 'ab',
    cycleFilter: 'xy',
  });
  assertNoDuplicates(map, 'garbage produced a collision');
  for (const action of KEY_ACTIONS) {
    assert.equal(map[action], DEFAULT_KEYMAP[action], `${action} did not fall back`);
  }
});

test('an action deliberately left unbound stays unbound', () => {
  // Preserve an explicit empty binding written by Backspace.
  const map = normalizeKeymap({ ...DEFAULT_KEYMAP, cycleFilter: '', downloadPicks: '' });
  assert.equal(map.cycleFilter, '', 'an explicit unbind must survive the round trip');
  assert.equal(map.downloadPicks, '');
  // Do not reassign freed keys implicitly.
  assertNoDuplicates(map, 'unbinding created a collision');
  for (const action of KEY_ACTIONS) {
    if (action === 'cycleFilter' || action === 'downloadPicks') continue;
    assert.equal(map[action], DEFAULT_KEYMAP[action], `${action} moved when a neighbour unbound`);
  }
  // Allow every action to be unbound.
  const silent = normalizeKeymap(Object.fromEntries(KEY_ACTIONS.map((a) => [a, ''])));
  assert.deepEqual(boundKeys(silent), []);
});

test('a stored key is accepted case-insensitively and kept lowercase', () => {
  // Normalize stored key case to match keyboard events.
  const map = normalizeKeymap({ ...DEFAULT_KEYMAP, togglePick: 'Z' });
  assert.equal(map.togglePick, 'z');
  assertNoDuplicates(map, 'case folding created a collision');
});

test('normalization is deterministic, so the same store always resolves alike', () => {
  const stored = { togglePick: 'd', selectAll: 'q', viewSaved: 'Tab', cycleFilter: 9 };
  assert.deepEqual(normalizeKeymap(stored), normalizeKeymap(stored));
});

test('rejects a key that is not one printable character', () => {
  for (const key of ['Tab', 'Enter', 'Escape', 'ArrowLeft', 'PageDown', 'Backspace', ' ', '', 'ab']) {
    assert.equal(isAssignableKey(key), false, `${JSON.stringify(key)} must not be bindable`);
  }
  for (const key of ['a', 'Z', '1', ',', '/', '<']) {
    assert.ok(isAssignableKey(key), `${key} must be bindable`);
  }
  assert.equal(isAssignableKey(undefined), false);
  assert.equal(isAssignableKey(7), false);
});

test('the grid density is coerced to a real choice', () => {
  assert.equal(normalizeSettings({ columns: 3 }).columns, 3);
  for (const bad of [0, 5, 2.5, -1, '2', null, NaN]) {
    assert.equal(
      normalizeSettings({ columns: bad }).columns,
      DEFAULT_SETTINGS.columns,
      `columns: ${JSON.stringify(bad)} must not reach the grid`,
    );
  }
  // Reject density values outside the Settings options.
  for (const choice of COLUMN_CHOICES) {
    assert.equal(normalizeSettings({ columns: choice }).columns, choice);
  }
});

// Keep density options aligned across markup, settings normalization, and CSS.
test('every grid density offered is one the stylesheet can lay out', () => {
  const root = process.cwd();
  const html = readFileSync(join(root, 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
  const css = readFileSync(join(root, 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

  const group = html.match(/<div class="seg[^"]*" data-seg="cols"[^>]*>(.*?)<\/div>/s)?.[1];
  assert.ok(group, 'the density control must exist');
  const offered = [...group.matchAll(/data-value="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(offered, COLUMN_CHOICES, 'the control and the schema must offer the same set');

  for (const columns of COLUMN_CHOICES) {
    // The default density uses the base grid declaration.
    if (columns === DEFAULT_SETTINGS.columns) continue;
    const rule = css.match(new RegExp(`#app\\[data-cols="${columns}"\\] \\.grid \\{([^}]*)\\}`));
    assert.ok(rule, `no layout rule for ${columns} columns`);
    assert.match(rule[1]!, /grid-template-columns:/, `${columns} columns sets no template`);
  }
  // Fix the aspect ratio so tile height follows column width.
  assert.match(css, /\.tile\s*\{[^}]*aspect-ratio:\s*9 \/ 16/s);
  assert.doesNotMatch(css, /--card-min/, 'the per-density height is gone; the aspect ratio replaced it');
  // Validate the base grid before applying density attributes.
  const base = css.match(/^\.grid \{([^}]*)\}/m)?.[1];
  assert.ok(base?.includes(`repeat(${DEFAULT_SETTINGS.columns},`), 'the base .grid rule must be the default');

  // Confirm that the panel writes the attribute selected by the CSS rules.
  assert.match(panelSource(), /dataset\.cols = String\(settings\.columns\)/);
});

test('two rebinds resolved from the same snapshot both land', async () => {
  // Merge concurrent partial rebinding patches from the same starting map.
  await resetChromeStorage();
  const { createSettingsPatchWriter, normalizeSettings } = await import('../src/shared/settings');
  try {
    const write = createSettingsPatchWriter(chrome.storage.local);
    await Promise.all([write({ keymap: { togglePick: 'x' } }), write({ keymap: { downloadCard: 'y' } })]);

    const stored = normalizeSettings((await chrome.storage.local.get('settings')).settings);
    assert.equal(stored.keymap.togglePick, 'x');
    assert.equal(stored.keymap.downloadCard, 'y');
    // Preserve untouched default bindings.
    for (const action of KEY_ACTIONS) {
      if (action === 'togglePick' || action === 'downloadCard') continue;
      assert.equal(stored.keymap[action], DEFAULT_KEYMAP[action], `${action} moved`);
    }
    assertNoDuplicates(stored.keymap, 'concurrent rebinds collided');
  } finally {
    await resetChromeStorage();
  }
});

test('a keymap patch cannot quietly reset an unrelated setting', async () => {
  // A keymap patch must preserve all stored scalar settings.
  await resetChromeStorage();
  const { createSettingsPatchWriter, normalizeSettings } = await import('../src/shared/settings');
  try {
    const write = createSettingsPatchWriter(chrome.storage.local);
    await write({ columns: 4, accent: 'grow', maxItems: 7 });
    await write({ keymap: { cycleFilter: '' } });

    const stored = normalizeSettings((await chrome.storage.local.get('settings')).settings);
    assert.equal(stored.columns, 4);
    assert.equal(stored.accent, 'grow');
    assert.equal(stored.maxItems, 7);
    assert.equal(stored.keymap.cycleFilter, '', 'the unbind still has to persist');
  } finally {
    await resetChromeStorage();
  }
});

test('a keymap edit cannot rewrite the shipped defaults', () => {
  // Default keymap objects must not share mutable references.
  assert.notEqual(DEFAULT_SETTINGS.keymap, DEFAULT_KEYMAP);
  assert.deepEqual(DEFAULT_SETTINGS.keymap, DEFAULT_KEYMAP);
});
