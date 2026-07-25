import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const controller = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');
const css = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

const qualityRule = css.match(/\.quality\s*\{([^}]*)\}/)?.[1];
const singleQualityRule = css.match(/\.quality\.is-single-option\s*\{([^}]*)\}/)?.[1];
const qualitySelectRule = css.match(/#now-qselect\s*\{([^}]*)\}/)?.[1];
const compactHeightCss = css.slice(
  css.indexOf('@media (max-height: 650px)'),
  css.indexOf('@media (prefers-reduced-motion: reduce)'),
);

test('hides the quality count when Now Playing has exactly one video option', () => {
  assert.match(
    controller,
    /byId\('now-qcount'\)\.textContent = now\.options\.length > 1\s*\?\s*tn\('qualityOptionsOne', 'qualityOptions', now\.options\.length\)\s*:\s*'';/,
  );
  assert.match(controller, /byId\('now-qcount'\)\.hidden = now\.options\.length <= 1;/);
});

test('keeps a numeric quality count and enables selection when Now Playing has multiple video options', () => {
  assert.match(
    controller,
    /now\.options\.length > 1\s*\?\s*tn\('qualityOptionsOne', 'qualityOptions', now\.options\.length\)\s*:\s*''/,
  );
  assert.match(controller, /select\.disabled = now\.options\.length <= 1;/);
});

test('shows only the resolution label for a single disabled video option', () => {
  assert.match(
    controller,
    /select\.classList\.toggle\('is-single-option', now\.options\.length <= 1\);/,
  );
  assert.match(controller, /o\.textContent = resolutionOf\(opt\)\.label;/);
  assert.match(
    css,
    /#now-qselect\.is-single-option\s*\{[^}]*background-image:\s*none;[^}]*\}/s,
  );
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

test('holds rerenders only while the picker is open and bounds the legacy fallback', () => {
  assert.match(
    controller,
    /const RENDER_FALLBACK_HOLD_MAX_MS = 1_500;/,
  );
  assert.match(
    controller,
    /function qualityPickerRenderHoldMs\(\): number \{[\s\S]*?select\.matches\(':open'\)[\s\S]*?RENDER_FALLBACK_HOLD_MAX_MS[\s\S]*?\}/,
  );
  assert.match(
    controller,
    /const renderHoldMaxMs = qualityPickerRenderHoldMs\(\);[\s\S]*?if \(renderHoldMaxMs > 0\) \{/,
  );
  assert.match(
    controller,
    /select\.addEventListener\('blur', finishQualityPickerInteraction\);/,
  );
  assert.match(
    controller,
    /function toggleQualityPickerFallback\(\): void \{[\s\S]*?finishQualityPickerInteraction\(\);/,
  );
});
