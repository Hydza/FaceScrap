// Geometry of the Now Playing resolution field. The CSS is the artifact here —
// these are numeric bounds on it, which nothing else can check without a browser.
//
// Four tests that mirrored sidepanel.ts's source lines (which ternary sets the
// count, which classList.toggle runs, how the render hold is computed) were
// dropped: they broke on refactors of correct code and could not observe a wrong
// count. The states they described are captured for real by `npm run qa:sidepanel`,
// which drives the built panel over CDP in both languages.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

const qualityRule = css.match(/\.quality\s*\{([^}]*)\}/)?.[1];
const singleQualityRule = css.match(/\.quality\.is-single-option\s*\{([^}]*)\}/)?.[1];
const qualitySelectRule = css.match(/#now-qselect\s*\{([^}]*)\}/)?.[1];
const compactHeightCss = css.slice(
  css.indexOf('@media (max-height: 650px)'),
  css.indexOf('@media (prefers-reduced-motion: reduce)'),
);

test('drops the picker chevron when there is only one option to pick', () => {
  assert.match(css, /#now-qselect\.is-single-option\s*\{[^}]*background-image:\s*none;[^}]*\}/s);
});

test('keeps the Now Playing resolution field a comfortable tap target without ballooning', () => {
  assert.ok(qualitySelectRule, 'missing #now-qselect rule');

  const height = Number(qualitySelectRule.match(/height:\s*(\d+)px;/)?.[1]);

  // The redesign promotes this from a compact select into a prominent monospace
  // resolution field (design ≈ 46px). Guard the touch target from either
  // extreme — the original bug was an oversized control, so keep a sane ceiling.
  assert.ok(Number.isFinite(height), 'missing pixel height for #now-qselect');
  assert.ok(
    height >= 40 && height <= 52,
    `expected #now-qselect height within the 40–52px field range, received ${height}px`,
  );
});

test('does not reserve the current 112px right padding in the Now Playing quality control', () => {
  assert.ok(qualitySelectRule, 'missing #now-qselect rule');

  const rightPadding = Number(qualitySelectRule.match(/padding-right:\s*(\d+)px;/)?.[1]);

  assert.ok(Number.isFinite(rightPadding), 'missing pixel right padding for #now-qselect');
  assert.ok(
    rightPadding < 112,
    `expected #now-qselect right padding below 112px, received ${rightPadding}px`,
  );
});

test('spans the resolution field full width in both option states', () => {
  assert.ok(qualityRule, 'missing .quality rule');
  assert.ok(singleQualityRule, 'missing .quality.is-single-option rule');

  // The redesign makes the resolution field full width — level with the download
  // button below it — instead of the earlier capped, single-narrower control.
  // Neither state may reintroduce a min(100%, Npx) width cap.
  assert.match(qualityRule, /width:\s*100%/);
  assert.match(singleQualityRule, /width:\s*100%/);
  assert.doesNotMatch(qualityRule, /width:\s*min\(100%,\s*\d+px\)/);
  assert.doesNotMatch(singleQualityRule, /width:\s*min\(100%,\s*\d+px\)/);
});

test('keeps the numeric multi-option count visible in short panels', () => {
  assert.ok(compactHeightCss.startsWith('@media (max-height: 650px)'), 'missing short-panel rules');
  assert.doesNotMatch(
    compactHeightCss,
    /\.quality-head\s*\{[^}]*display:\s*none;/s,
    'short panels must not hide the multi-option count',
  );
});
