import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

test('keeps native select options readable on the dark sidepanel', () => {
  const optionRule = css.match(/\.select\s+option\s*\{([^}]*)\}/);
  assert.ok(optionRule, 'missing explicit native option colors');
  assert.match(optionRule[1]!, /color:\s*var\(--text\)/);
  assert.match(optionRule[1]!, /background-color:\s*var\(--surface\)/);
});

test('rounds every customizable Chromium select picker', () => {
  assert.match(css, /@supports\s*\(appearance:\s*base-select\)/);
  assert.match(
    css,
    /\.select::picker\(select\)\s*\{[\s\S]*?border-radius:\s*var\(--r-sm\);[\s\S]*?overflow:\s*hidden;/,
  );
  assert.match(css, /\.select,\s*\.select::picker\(select\)\s*\{\s*appearance:\s*base-select;/);
});

test('vertically centers values in every closed customizable select', () => {
  const customizableBlock = css.match(/@supports\s*\(appearance:\s*base-select\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(customizableBlock, 'missing customizable select block');
  const triggerRule = customizableBlock.match(/\.select\s*\{([^}]*)\}/)?.[1];
  assert.ok(triggerRule, 'missing customizable select trigger rule');
  assert.match(triggerRule, /display:\s*flex/);
  assert.match(triggerRule, /align-items:\s*center/);
});
