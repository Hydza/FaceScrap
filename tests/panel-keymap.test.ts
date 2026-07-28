// The keymap's one hard invariant: no two panel functions may share a key.
//
// It is enforced in normalizeKeymap rather than in the Settings UI, because the UI is
// not the only writer — a keymap arrives from chrome.storage.local, which survives an
// extension update and can be edited by hand. A duplicate there would make one keypress
// run two functions (select the card AND start its download), so the coercion has to
// hold for any input at all, not just for what the capture rows can produce.

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

/** Every bound key in the map, so a duplicate shows up as a length mismatch. */
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
  // 'd' is downloadCard's default. Handing it to togglePick, which resolves first,
  // must not leave both actions answering to it.
  const map = normalizeKeymap({ togglePick: 'd' });
  assertNoDuplicates(map, 'a stored duplicate got through');
  assert.equal(map.togglePick, 'd', 'the earlier action keeps the key it asked for');
  // Its own default is now taken, so it ends up with NO key rather than sharing one:
  // a function nobody can reach is recoverable from Settings, two functions on one
  // press is not.
  assert.equal(map.downloadCard, '', 'the loser is unbound, not duplicated');
});

test('an unusable stored key falls back to its default', () => {
  // Every one of these is something a hand-edited store could hold. The multi-character
  // names are exactly the keys the panel reserves for itself — arrows move the cursor,
  // Enter activates, Escape closes — and none is a single character, which is the whole
  // reason that one rule is enough to keep them out.
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
  // '' is what the Settings row writes when Backspace clears a binding: a choice, not an absence,
  // and it has to survive the round trip rather than resolving back to the default. Grouping it
  // with "missing or unusable" would make unbinding a function impossible to persist.
  const map = normalizeKeymap({ ...DEFAULT_KEYMAP, cycleFilter: '', downloadPicks: '' });
  assert.equal(map.cycleFilter, '', 'an explicit unbind must survive the round trip');
  assert.equal(map.downloadPicks, '');
  // And the freed keys are not silently handed to anything else.
  assertNoDuplicates(map, 'unbinding created a collision');
  for (const action of KEY_ACTIONS) {
    if (action === 'cycleFilter' || action === 'downloadPicks') continue;
    assert.equal(map[action], DEFAULT_KEYMAP[action], `${action} moved when a neighbour unbound`);
  }
  // Unbinding EVERYTHING is legitimate — it is how the keyboard is handed back wholesale.
  const silent = normalizeKeymap(Object.fromEntries(KEY_ACTIONS.map((a) => [a, ''])));
  assert.deepEqual(boundKeys(silent), []);
});

test('a stored key is accepted case-insensitively and kept lowercase', () => {
  // The capture row lowercases what it stores, but a store written by an older build
  // (or by hand) may not have; panel-keys compares against a lowercased event key.
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
  // The select in Settings offers exactly these, so a value outside them can only come
  // from a hand-edited store.
  for (const choice of COLUMN_CHOICES) {
    assert.equal(normalizeSettings({ columns: choice }).columns, choice);
  }
});

// Three artifacts have to agree on which densities exist: the <select> that offers them,
// normalizeSettings which accepts them, and the CSS that lays each one out. Adding a
// fourth option to the markup alone would silently render at two columns — the setting
// would persist, the select would show it, and nothing would move. Only a cross-artifact
// read can see that, which is why it is asserted here rather than left to a screenshot.
test('every grid density offered is one the stylesheet can lay out', () => {
  const root = process.cwd();
  const html = readFileSync(join(root, 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
  const css = readFileSync(join(root, 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

  const group = html.match(/<div class="seg[^"]*" data-seg="cols"[^>]*>(.*?)<\/div>/s)?.[1];
  assert.ok(group, 'the density control must exist');
  const offered = [...group.matchAll(/data-value="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(offered, COLUMN_CHOICES, 'the control and the schema must offer the same set');

  for (const columns of COLUMN_CHOICES) {
    // The default needs no attribute rule — it is the base .grid declaration.
    if (columns === DEFAULT_SETTINGS.columns) continue;
    const rule = css.match(new RegExp(`#app\\[data-cols="${columns}"\\] \\.grid \\{([^}]*)\\}`));
    assert.ok(rule, `no layout rule for ${columns} columns`);
    assert.match(rule[1]!, /grid-template-columns:/, `${columns} columns sets no template`);
  }
  // Height used to be a tuned --card-min per density, which every new density had to
  // restate. The tile carries one aspect ratio instead, so its height follows whatever
  // width the template gives it — and a source of any shape renders unstretched.
  assert.match(css, /\.tile\s*\{[^}]*aspect-ratio:\s*9 \/ 16/s);
  assert.doesNotMatch(css, /--card-min/, 'the per-density height is gone; the aspect ratio replaced it');
  // And the base rule is the default, so no attribute at all still renders correctly —
  // which is what the panel shows for the instant before applyGridDensity runs.
  const base = css.match(/^\.grid \{([^}]*)\}/m)?.[1];
  assert.ok(base?.includes(`repeat(${DEFAULT_SETTINGS.columns},`), 'the base .grid rule must be the default');

  // The other half of the same contract, and the half no CSS read can see: the panel has
  // to write the attribute those rules select on. Nothing observable distinguishes
  // `dataset.cols` from `dataset.columns` without a browser, which is the exception this
  // repo allows a source assertion for.
  assert.match(panelSource(), /dataset\.cols = String\(settings\.columns\)/);
});

test('two rebinds resolved from the same snapshot both land', async () => {
  // A patch names only the actions it rebinds, so the second one does not carry — and therefore
  // cannot overwrite — the first one's key. Both are built from the same starting map, which is
  // what happens when a user rebinds two rows faster than the write round trip.
  await resetChromeStorage();
  const { createSettingsPatchWriter, normalizeSettings } = await import('../src/shared/settings');
  try {
    const write = createSettingsPatchWriter(chrome.storage.local);
    await Promise.all([write({ keymap: { togglePick: 'x' } }), write({ keymap: { downloadCard: 'y' } })]);

    const stored = normalizeSettings((await chrome.storage.local.get('settings')).settings);
    assert.equal(stored.keymap.togglePick, 'x');
    assert.equal(stored.keymap.downloadCard, 'y');
    // And the seven untouched actions are still on their defaults, not reset by either write.
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
  // applyPatch merges the map but replaces scalars, so a rebind must leave every other field as
  // stored rather than as its default.
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
  // DEFAULT_SETTINGS.keymap is spread shallowly on loadSettings' error path, so sharing
  // one object with DEFAULT_KEYMAP would let a single panel's edit change what every
  // later reader falls back to.
  assert.notEqual(DEFAULT_SETTINGS.keymap, DEFAULT_KEYMAP);
  assert.deepEqual(DEFAULT_SETTINGS.keymap, DEFAULT_KEYMAP);
});
