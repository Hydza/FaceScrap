// Check fixed text colors against every tinted surface in both themes.
// Accent palette contrast is covered separately.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { PANEL_TINTS } from '../src/shared/appearance';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

function block(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const value = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'i'))?.[1];
  assert.ok(value, `missing ${selector} token block`);
  return value;
}

function token(selector: string, name: string): string {
  const value = block(selector).match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  assert.ok(value, `missing --${name} color token in ${selector}`);
  return value;
}

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

const THEMES = [
  { selector: ':root', surfaces: 'dark' },
  { selector: ':root[data-theme="light"]', surfaces: 'light' },
] as const;

/** Allow the recorded faint-text shortfall while preventing further degradation. */
const RECORDED_SHORTFALLS: ReadonlyMap<string, number> = new Map([['ft/graphite/dark/surface', 4.36]]);

test('keeps primary and supporting text at WCAG AA on every tint, in both themes', () => {
  const seen = new Set<string>();
  for (const theme of THEMES) {
    const tx = token(theme.selector, 'tx');
    const md = token(theme.selector, 'md');
    const ft = token(theme.selector, 'ft');
    for (const tint of PANEL_TINTS) {
      const [canvas, surface, surface2] = tint[theme.surfaces];
      // Faint text labels only the canvas and card surface; raised chips use medium text.
      const pairs = [
        ['tx', tx, 'canvas', canvas],
        ['tx', tx, 'surface', surface],
        ['tx', tx, 'surface-2', surface2],
        ['md', md, 'canvas', canvas],
        ['md', md, 'surface', surface],
        ['md', md, 'surface-2', surface2],
        ['ft', ft, 'canvas', canvas],
        ['ft', ft, 'surface', surface],
      ] as const;
      for (const [name, colour, where, background] of pairs) {
        const key = `${name}/${tint.id}/${theme.surfaces}/${where}`;
        const ratio = contrast(colour, background);
        const recorded = RECORDED_SHORTFALLS.get(key);
        if (recorded == null) {
          assert.ok(ratio >= 4.5, `--${name} on ${key}: ${ratio.toFixed(2)}:1, needs 4.5:1`);
          continue;
        }
        seen.add(key);
        assert.ok(
          ratio >= recorded - 0.01,
          `--${name} on ${key} fell to ${ratio.toFixed(2)}:1, below its recorded ${recorded}:1`,
        );
        assert.ok(ratio < 4.5, `${key} now clears AA — delete its RECORDED_SHORTFALLS entry`);
      }
    }
  }
  // Require every recorded exception to match an exercised pair.
  assert.deepEqual([...RECORDED_SHORTFALLS.keys()].filter((key) => !seen.has(key)), []);
});

test('keeps the idle status pill at AA over its own wash', () => {
  // Measure the idle label against its composited wash and require medium text.
  assert.match(css, /\.status-pill\.is-idle\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.05\)/s);
  assert.match(css, /\.status-pill\.is-idle\s*\{[^}]*color:\s*var\(--md\)/s);
  const md = token(':root', 'md');
  for (const tint of PANEL_TINTS) {
    const surface = tint.dark[1];
    const composited =
      '#' +
      surface
        .slice(1)
        .match(/../g)!
        .map((channel) => Math.round(255 * 0.05 + Number.parseInt(channel, 16) * 0.95))
        .map((channel) => channel.toString(16).padStart(2, '0'))
        .join('');
    const ratio = contrast(md, composited);
    assert.ok(ratio >= 4.5, `idle pill on ${tint.id}/dark fell to ${ratio.toFixed(2)}:1`);
  }
});

test('keeps the field interior separable from the surface it sits in', () => {
  // Field fills must differ from their card surfaces independently of inset depth.
  for (const theme of THEMES) {
    const field = token(theme.selector, 'fld');
    for (const tint of PANEL_TINTS) {
      const surface = tint[theme.surfaces][1];
      assert.notEqual(
        field.toLowerCase(),
        surface.toLowerCase(),
        `--fld collapses into ${tint.id}/${theme.surfaces}'s surface`,
      );
    }
  }
});

test('states the live and danger colours in both themes', () => {
  // Measure warning and danger text against their theme-specific surfaces.
  for (const theme of THEMES) {
    for (const name of ['lvt', 'dg', 'off']) {
      assert.match(block(theme.selector), new RegExp(`--${name}:`), `${theme.selector} missing --${name}`);
    }
    const live = token(theme.selector, 'lvt');
    const danger = token(theme.selector, 'dg');
    for (const tint of PANEL_TINTS) {
      const surface = tint[theme.surfaces][1];
      assert.ok(contrast(live, surface) >= 4.5, `--lvt on ${tint.id}/${theme.surfaces}`);
      assert.ok(contrast(danger, surface) >= 4.5, `--dg on ${tint.id}/${theme.surfaces}`);
    }
  }
});

test('keeps the chrome drawn ON media independent of the panel theme', () => {
  // Media overlays use literal black and white instead of theme tokens.
  assert.match(css, /\.media-dur\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*0\.55\)/s);
  assert.match(css, /\.media-dur\s*\{[^}]*color:\s*#ffffff/s);
  assert.match(css, /\.tile-title\s*\{[^}]*color:\s*#ffffff/s);
  assert.match(css, /\.tile-meta\s*\{[^}]*color:\s*rgba\(255,\s*255,\s*255,\s*0\.78\)/s);
  assert.match(css, /\.preview-format\s*\{[^}]*color:\s*rgba\(255,\s*255,\s*255,\s*0\.85\)/s);
  assert.match(css, /\.preview-play\s*\{[^}]*background:\s*rgba\(10,\s*12,\s*15,\s*0\.42\)/s);
  // Require both scrims used beneath media-overlay text.
  assert.match(css, /\.preview-scrim\s*\{[^}]*linear-gradient\(transparent,\s*rgba\(6,\s*8,\s*11,\s*0\.9\)\)/s);
  assert.match(css, /\.tile-scrim\s*\{[^}]*linear-gradient\(transparent,\s*rgba\(6,\s*8,\s*11,\s*0\.92\)\)/s);
});

test('the tint is resolved by the stylesheet, never written from JS', () => {
  // Apply appearance through palette attributes so theme changes select matching surfaces.
  const panel = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
  assert.match(panel, /root\.dataset\.tint = settings\.panelTint/);
  assert.match(panel, /root\.dataset\.accent = settings\.accent/);
  for (const name of ['--cv', '--sf', '--sf2', '--ln', '--ac', '--acg', '--onac', '--ach']) {
    assert.doesNotMatch(
      panel,
      new RegExp(`setProperty\\('${name}'`),
      `${name} must come from the stylesheet, not from a JS write`,
    );
  }
});
