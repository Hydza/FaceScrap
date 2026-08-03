// Verify every selectable accent against its rendered CSS values and contrast threshold.

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

/** Normalize gradient spacing before comparing colors. */
const compact = (value: string): string => value.replace(/\s+/g, '').toLowerCase();

/** Return the body of an exact stylesheet rule. */
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(body, `the stylesheet has no ${selector} rule`);
  return body;
}

/** Return one custom property from a rule body. */
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
    // Borders, focus rings, outlines, and SVG fills require a solid color.
    assert.match(accent.solid, /^#[0-9a-f]{6}$/, `${accent.id}: solid must be a flat hex`);
    assert.equal(
      accent.group === 'solid',
      accent.grad === accent.solid,
      `${accent.id}: the solid group states one colour twice, the gradient group a ramp`,
    );
    if (accent.group === 'solid') continue;
    assert.match(accent.grad, /^linear-gradient\(/, `${accent.id}: grad must be a gradient`);
    // A gradient entry must contain at least two distinct stops.
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
    // A text-free swatch requires an accessible name.
    const declared = [...i18n.matchAll(new RegExp(`^\\s+${tint.label}: '([^']+)'`, 'gm'))];
    assert.equal(declared.length, 2, `${tint.label} must be translated in both languages`);

    for (const theme of ['dark', 'light'] as const) {
      const [cv, sf, sf2, ln] = tint[theme];
      for (const colour of [cv, sf, sf2, ln]) {
        assert.match(colour, /^#[0-9a-f]{6}$/, `${tint.id}/${theme}: every surface is a flat hex`);
      }
      // Distinct tint steps preserve card boundaries.
      assert.equal(new Set([cv, sf, sf2, ln]).size, 4, `${tint.id}/${theme}: four distinct surfaces`);
    }

    // Each tint must define both theme variants.
    assert.match(css, new RegExp(`:root\\[data-tint="${tint.id}"\\]`), `no dark rule for ${tint.id}`);
    assert.match(
      css,
      new RegExp(`:root\\[data-theme="light"\\]\\[data-tint="${tint.id}"\\]`),
      `no light rule for ${tint.id}`,
    );
    // Each variant must match the four measured surface colors.
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
    // Accent text on the light canvas must use its darker step.
    assert.match(
      css,
      new RegExp(`:root\\[data-theme="light"\\]\\[data-accent="${accent.id}"\\]`),
      `no light --ach for ${accent.id}`,
    );
    // Match every palette field to the exact rule that renders it.
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
  // Accent text needs a theme-specific step to maintain 4.5:1 contrast.
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
  // Every text-free swatch needs a localized accessible name.
  const i18n = readFileSync(join(process.cwd(), 'src', 'shared', 'i18n.ts'), 'utf8');
  for (const accent of ACCENTS) {
    const declared = [...i18n.matchAll(new RegExp(`^\\s+${accent.label}: '([^']+)'`, 'gm'))];
    assert.equal(declared.length, 2, `${accent.label} must be translated in both languages`);
  }
});

test('an unknown accent falls back rather than reaching CSS', () => {
  // Normalize unknown stored IDs to the same fallback used by the palette table.
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
  // Each non-default choice requires a matching stylesheet rule.
  for (const corners of ['sharp', 'round']) {
    assert.match(css, new RegExp(`#app\\[data-corners="${corners}"\\]`), `no rule for ${corners} corners`);
  }
  for (const backdrop of ['frosted', 'glass']) {
    assert.match(css, new RegExp(`#app\\[data-backdrop="${backdrop}"\\]`), `no rule for ${backdrop}`);
  }
  // Default values belong only to the base stylesheet.
  assert.equal(DEFAULT_SETTINGS.panelCorners, 'soft');
  assert.equal(DEFAULT_SETTINGS.panelBackdrop, 'solid');
});
