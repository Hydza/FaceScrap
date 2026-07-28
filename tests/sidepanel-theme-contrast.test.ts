// The panel's fixed colours, checked against every canvas they can actually land on.
//
// The panel tint moves --cv/--sf/--sf2/--ln as a set, so "text on the canvas" is no
// longer one pairing but twelve — six tints in two themes. The text tokens themselves
// are theme-level and do NOT move with the tint, which is exactly the combination a
// hand-check misses: a token tuned against slate can fail against sand.
//
// The accent side (--ac/--onac/--ach) is computed in accent-palette.test.ts, which owns
// that palette.

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

/**
 * The pairs the handoff's own values do NOT clear, measured rather than hidden.
 *
 * The design states `--ft: #7c828a` and states that it is for faint STATIC labels. It
 * was measured against ONE neutral surface; the panel tint then introduced five more,
 * and the two lightest cards fall a little short of AA's 4.5:1. Shipping the handoff's
 * hex verbatim is a deliberate call — so the shortfall is recorded here, per pair, with
 * a floor. Every other pair still has to clear 4.5:1, and any of these getting WORSE is
 * a failure. Raising `--ft` by three points to `#7f858d` clears all of them if the
 * decision is ever revisited.
 */
const RECORDED_SHORTFALLS: ReadonlyMap<string, number> = new Map([['ft/graphite/dark/surface', 4.36]]);

test('keeps primary and supporting text at WCAG AA on every tint, in both themes', () => {
  const seen = new Set<string>();
  for (const theme of THEMES) {
    const tx = token(theme.selector, 'tx');
    const md = token(theme.selector, 'md');
    const ft = token(theme.selector, 'ft');
    for (const tint of PANEL_TINTS) {
      const [canvas, surface, surface2] = tint[theme.surfaces];
      // --ft is not measured against surface-2 on purpose: the design's rule is that it
      // only labels the canvas and the inside of a card, and anything on a raised chip
      // uses --md. The one place that rule is bent is the idle status pill, which the
      // handoff draws in --ft over a 5%-white wash — checked below.
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
  // A recorded exception that no longer applies is a stale excuse, not a pass.
  assert.deepEqual([...RECORDED_SHORTFALLS.keys()].filter((key) => !seen.has(key)), []);
});

test('records what the idle status pill costs, in the handoff’s own colours', () => {
  // The pill is --ft over rgba(255,255,255,.05) on the header surface — the design's
  // values verbatim. Composited, that lands at 3.8–4.1:1 across the six dark tints:
  // under AA for a 11px label. It is the one control the handoff's own contrast rule
  // ("anything interactive uses --md") argues against, and it is kept because the
  // handoff draws it that way. Pinned so the number cannot drift further.
  assert.match(css, /\.status-pill\.is-idle\s*\{[^}]*background:\s*rgba\(255,\s*255,\s*255,\s*0\.05\)/s);
  assert.match(css, /\.status-pill\.is-idle\s*\{[^}]*color:\s*var\(--ft\)/s);
  const ft = token(':root', 'ft');
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
    const ratio = contrast(ft, composited);
    assert.ok(ratio >= 3.8, `idle pill on ${tint.id}/dark fell to ${ratio.toFixed(2)}:1`);
  }
});

test('keeps the field interior separable from the surface it sits in', () => {
  // A field that reads as the card it is drawn on is not a field. --ei gives it depth,
  // but depth alone disappears at high contrast settings, so the fill has to differ too.
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
  // Both are read as TEXT — the capturing pill in the header, the Clear button and the
  // refusal lines inside a settings card — so both are measured against the SURFACE
  // they are drawn on, and each theme needs its own step rather than one shared colour.
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
  // The chips, the caption and the play control sit over photographs, so they are the
  // one place the panel writes literal white and literal black instead of a token: a
  // theme-following colour there would go invisible on half the thumbnails.
  assert.match(css, /\.media-dur\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*0\.55\)/s);
  assert.match(css, /\.media-dur\s*\{[^}]*color:\s*#ffffff/s);
  assert.match(css, /\.tile-title\s*\{[^}]*color:\s*#ffffff/s);
  assert.match(css, /\.tile-meta\s*\{[^}]*color:\s*rgba\(255,\s*255,\s*255,\s*0\.78\)/s);
  assert.match(css, /\.preview-format\s*\{[^}]*color:\s*rgba\(255,\s*255,\s*255,\s*0\.85\)/s);
  assert.match(css, /\.preview-play\s*\{[^}]*background:\s*rgba\(10,\s*12,\s*15,\s*0\.42\)/s);
  // The two scrims those sit on, without which none of the above is readable.
  assert.match(css, /\.preview-scrim\s*\{[^}]*linear-gradient\(transparent,\s*rgba\(6,\s*8,\s*11,\s*0\.9\)\)/s);
  assert.match(css, /\.tile-scrim\s*\{[^}]*linear-gradient\(transparent,\s*rgba\(6,\s*8,\s*11,\s*0\.92\)\)/s);
});

test('the tint is resolved by the stylesheet, never written from JS', () => {
  // applyAppearance writes ONE attribute per palette. If it went back to setting the
  // four surface properties itself, a theme flip arriving from panel-theme.ts's own
  // signals would leave the panel painting the other theme's tint until the next
  // settings write.
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
