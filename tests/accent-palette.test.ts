// Every accent has to be readable, and the accent is now a user choice.
//
// The panel's fixed colours are checked by sidepanel-theme-contrast.test.ts, which reads the
// tokens straight out of the stylesheet. That cannot see this palette: applyAppearance writes
// --accent / --on-accent at runtime, so seven pairs bypass those assertions entirely. Two of
// these entries (the reaction yellow, the signup green) are light enough that white text on
// them lands near 2:1 — a single hardcoded white would have shipped two unreadable buttons.
//
// So the ratio is COMPUTED here for every entry rather than eyeballed when the hex was
// picked, and a new accent cannot be added without clearing the same bar.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { ACCENTS, accentById, DEFAULT_ACCENT } from '../src/shared/appearance';
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
    // `solid` is what borders, focus rings and 1px outlines take — none of those can carry a
    // gradient — so it must always be a plain hex, even on a gradient entry.
    assert.match(accent.solid, /^#[0-9a-f]{6}$/, `${accent.id}: solid must be a flat hex`);
    if (accent.grad === accent.solid) continue;
    assert.match(accent.grad, /^linear-gradient\(/, `${accent.id}: grad must be flat or a gradient`);
    // Every stop a real colour, and the flat fallback among them: a gradient whose stops
    // wandered off the flat colour would make the button and its own border disagree.
    assert.ok(accent.grad.includes(accent.solid), `${accent.id}: the ramp must include its flat colour`);
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
  // this build no longer has. applyAppearance writes accentById's answer straight into a
  // style property, and `undefined` there would silently drop the accent for the session.
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
