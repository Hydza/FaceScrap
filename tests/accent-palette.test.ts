// Every accent has to be readable, and the accent is now a user choice.
//
// The panel's fixed colours are checked by sidepanel-theme-contrast.test.ts, which reads the
// tokens straight out of the stylesheet. It does not reach this palette: the accent and the
// tint are one attribute-selected rule per entry, and it measures none of them. Two of these
// entries (the reaction yellow, the signup green) are light enough that white text on them
// lands near 2:1 — a single hardcoded white would have shipped two unreadable buttons.
//
// So the ratio is COMPUTED here for every entry rather than eyeballed when the hex was
// picked, and a new accent cannot be added without clearing the same bar.
//
// Every ratio below is computed over the table in appearance.ts, and the panel paints the
// stylesheet's copy of it — of the fields those ratios are made of, only `grad` has a reader
// in src/ (settings-sheet.ts fills the swatch with it). A guarantee proved on the copy that
// does not render is worth nothing, so every value of both palettes is also asserted equal to
// the CSS declaration that does.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  ACCENTS,
  accentById,
  DEFAULT_ACCENT,
  DEFAULT_TINT,
  PANEL_TINTS,
  tintById,
} from '../src/shared/appearance';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared/settings';

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The gradients are declared with a space after each comma and stated here without any, and
 *  a rule may be written on one line or on six. Both sides of every comparison below are
 *  compacted so the parity assertions test colours, not formatting. */
const compact = (value: string): string => value.replace(/\s+/g, '').toLowerCase();

/** One rule body out of the stylesheet, by exact selector. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body, `the stylesheet has no ${selector} rule`);
  return body;
}

/** One custom property out of that rule. */
function cssValue(css: string, selector: string, property: string): string {
  const value = ruleBody(css, selector).match(new RegExp(`--${property}:\\s*([^;]+);`))?.[1];
  assert.ok(value, `${selector} declares no --${property}`);
  return compact(value);
}

test('every accent carries text that clears WCAG AA on it', () => {
  for (const accent of ACCENTS) {
    const ratio = contrast(accent.onAccent, accent.solid);
    assert.ok(
      ratio >= 4.5,
      `${accent.id}: ${accent.onAccent} on ${accent.solid} is ${ratio.toFixed(2)}:1, needs 4.5:1`,
    );
  }
});

test('the flat entries state one colour twice and the gradients state a real ramp', () => {
  for (const accent of ACCENTS) {
    // `solid` is what borders, focus rings, 1px outlines and the logo's SVG fill take —
    // none of those can carry a gradient — so it must always be a plain hex, even on a
    // gradient entry.
    assert.match(accent.solid, /^#[0-9a-f]{6}$/, `${accent.id}: solid must be a flat hex`);
    assert.equal(
      accent.group === 'solid',
      accent.grad === accent.solid,
      `${accent.id}: the solid group states one colour twice, the gradient group a ramp`,
    );
    if (accent.group === 'solid') continue;
    assert.match(accent.grad, /^linear-gradient\(/, `${accent.id}: grad must be a gradient`);
    // Two real stops at least. How the flat fallback relates to them is a judgement no
    // cheap metric captures — messenger's is one stop of a four-stop rainbow, dusk's is a
    // hue midpoint that is darker than either end — so what is asserted is that the ramp
    // IS a ramp. That the fallback is readable is test one's job, and it covers every
    // entry either way.
    const stops = [...accent.grad.matchAll(/#[0-9a-f]{6}/g)];
    assert.ok(stops.length >= 2, `${accent.id}: a ramp needs at least two stops`);
  }
});

test('every tint moves all four surfaces, in both themes', () => {
  const ids = PANEL_TINTS.map((tint) => tint.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate tint id');
  const labels = PANEL_TINTS.map((tint) => tint.label);
  assert.equal(new Set(labels).size, labels.length, 'two tints share a label');

  const i18n = readFileSync(join(process.cwd(), 'src', 'shared', 'i18n.ts'), 'utf8');
  const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');
  for (const tint of PANEL_TINTS) {
    // A swatch has no text, so its label IS its accessible name.
    const declared = [...i18n.matchAll(new RegExp(`^\\s+${tint.label}: '([^']+)'`, 'gm'))];
    assert.equal(declared.length, 2, `${tint.label} must be translated in both languages`);

    for (const theme of ['dark', 'light'] as const) {
      const [cv, sf, sf2, ln] = tint[theme];
      for (const colour of [cv, sf, sf2, ln]) {
        assert.match(colour, /^#[0-9a-f]{6}$/, `${tint.id}/${theme}: every surface is a flat hex`);
      }
      // Four DISTINCT steps. A tint whose canvas and surface collapsed to one colour
      // would erase the card edges the whole panel is built on.
      assert.equal(new Set([cv, sf, sf2, ln]).size, 4, `${tint.id}/${theme}: four distinct surfaces`);
    }

    // The stylesheet, not applyAppearance, resolves the tint — it depends on the theme,
    // which arrives from its own async path. Both halves of the pair must exist, or
    // picking the tint would persist and change nothing in one of the two themes.
    assert.match(css, new RegExp(`:root\\[data-tint="${tint.id}"\\]`), `no dark rule for ${tint.id}`);
    assert.match(
      css,
      new RegExp(`:root\\[data-theme="light"\\]\\[data-tint="${tint.id}"\\]`),
      `no light rule for ${tint.id}`,
    );
    // And each half has to state THESE four surfaces. Existence alone would let the rule
    // drift to colours the contrast assertions above never measured.
    for (const [selector, surfaces] of [
      [`:root[data-tint="${tint.id}"]`, tint.dark],
      [`:root[data-theme="light"][data-tint="${tint.id}"]`, tint.light],
    ] as const) {
      const declared = ['cv', 'sf', 'sf2', 'ln'].map((name) => cssValue(css, selector, name));
      assert.deepEqual(declared, surfaces.map(compact), `${selector} paints a different ${tint.id}`);
    }
  }

  assert.equal(tintById('no-such-tint').id, DEFAULT_TINT);
  for (const bad of ['slate ', 'SLATE', 42, null, {}]) {
    assert.equal(normalizeSettings({ panelTint: bad }).panelTint, DEFAULT_SETTINGS.panelTint);
  }
  for (const tint of PANEL_TINTS) {
    assert.equal(normalizeSettings({ panelTint: tint.id }).panelTint, tint.id);
  }
});

test('the stylesheet carries every accent the schema accepts, per theme', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');
  for (const accent of ACCENTS) {
    assert.match(css, new RegExp(`:root\\[data-accent="${accent.id}"\\]`), `no rule for ${accent.id}`);
    // --ach is the ONLY place an accent is allowed to be text, and it needs the darker
    // step on the light canvas. A missing light rule leaves the dark step there, which is
    // exactly the pairing that fails AA.
    assert.match(
      css,
      new RegExp(`:root\\[data-theme="light"\\]\\[data-accent="${accent.id}"\\]`),
      `no light --ach for ${accent.id}`,
    );
    // Every field of the entry, against the rule that renders it. `css.includes(…)` stood
    // here and passed on a value declared under some OTHER accent — which is exactly how
    // the two copies drift without anything going red.
    const dark = `:root[data-accent="${accent.id}"]`;
    const light = `:root[data-theme="light"][data-accent="${accent.id}"]`;
    assert.equal(cssValue(css, dark, 'ac'), compact(accent.solid), `${accent.id}: --ac`);
    assert.equal(cssValue(css, dark, 'acg'), compact(accent.grad), `${accent.id}: --acg`);
    assert.equal(cssValue(css, dark, 'onac'), compact(accent.onAccent), `${accent.id}: --onac`);
    assert.equal(cssValue(css, dark, 'ach'), compact(accent.softDark), `${accent.id}: dark --ach`);
    assert.equal(cssValue(css, dark, 'acrgb'), compact(accent.rgb), `${accent.id}: --acrgb`);
    assert.equal(cssValue(css, light, 'ach'), compact(accent.softLight), `${accent.id}: light --ach`);
  }
});

test('the accent-as-text step clears WCAG AA on the canvas it is used on', () => {
  // --ach carries the picker's selected row, the "Save as…" hover, the active nav label
  // and the filename preview. Each theme gets its own step because no single colour
  // clears 4.5:1 against both canvases.
  for (const accent of ACCENTS) {
    for (const tint of PANEL_TINTS) {
      const dark = contrast(accent.softDark, tint.dark[0]);
      assert.ok(dark >= 4.5, `${accent.id} on ${tint.id} (dark): ${dark.toFixed(2)}:1`);
      const light = contrast(accent.softLight, tint.light[0]);
      assert.ok(light >= 4.5, `${accent.id} on ${tint.id} (light): ${light.toFixed(2)}:1`);
    }
  }
});

test('ids are unique and every one has its own label', () => {
  const ids = ACCENTS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate accent id');
  const labels = ACCENTS.map((a) => a.label);
  assert.equal(new Set(labels).size, labels.length, 'two accents share a label');
  // A swatch has no text, so its label IS its accessible name. An accent with no entry in
  // both dictionaries would be a button screen readers cannot name.
  const i18n = readFileSync(join(process.cwd(), 'src', 'shared', 'i18n.ts'), 'utf8');
  for (const accent of ACCENTS) {
    const declared = [...i18n.matchAll(new RegExp(`^\\s+${accent.label}: '([^']+)'`, 'gm'))];
    assert.equal(declared.length, 2, `${accent.label} must be translated in both languages`);
  }
});

test('an unknown accent falls back rather than reaching CSS', () => {
  // The stored value is a bare string, so a hand-edited store or a downgrade can hold an id
  // this build no longer has. What keeps it off the panel is normalizeSettings: applyAppearance
  // writes `settings.accent` into a root attribute, and an unknown one there selects no rule at
  // all. accentById has no caller in src/ today; it is asserted alongside so the table's own
  // fallback cannot drift away from the schema's.
  assert.equal(accentById('no-such-accent').id, DEFAULT_ACCENT);
  assert.equal(accentById('').id, DEFAULT_ACCENT);
  for (const bad of ['brand ', 'BRAND', 42, null, {}]) {
    assert.equal(normalizeSettings({ accent: bad }).accent, DEFAULT_SETTINGS.accent);
  }
  for (const accent of ACCENTS) {
    assert.equal(normalizeSettings({ accent: accent.id }).accent, accent.id);
  }
});

test('the shape and depth choices are coerced to what the stylesheet can render', () => {
  const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');
  for (const bad of ['square', '', 12, null]) {
    assert.equal(normalizeSettings({ panelCorners: bad }).panelCorners, DEFAULT_SETTINGS.panelCorners);
    assert.equal(normalizeSettings({ panelBackdrop: bad }).panelBackdrop, DEFAULT_SETTINGS.panelBackdrop);
  }
  // Each non-default choice needs a rule, or picking it would persist and change nothing.
  for (const corners of ['sharp', 'round']) {
    assert.match(css, new RegExp(`#app\\[data-corners="${corners}"\\]`), `no rule for ${corners} corners`);
  }
  for (const backdrop of ['frosted', 'glass']) {
    assert.match(css, new RegExp(`#app\\[data-backdrop="${backdrop}"\\]`), `no rule for ${backdrop}`);
  }
  // The defaults are the base stylesheet, so they carry no attribute rule of their own —
  // asserted so a future "sharp is now the default" change has to move both halves.
  assert.equal(DEFAULT_SETTINGS.panelCorners, 'soft');
  assert.equal(DEFAULT_SETTINGS.panelBackdrop, 'solid');
});
