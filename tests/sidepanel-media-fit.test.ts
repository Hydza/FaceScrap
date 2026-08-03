import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { panelSource } from './panel-source';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');
const controller = panelSource();

test('shows complete media over a blurred cover background', () => {
  const foreground = css.match(
    /\.preview\s*>\s*img:not\(\.thumb-bg\),\s*\.tile-thumb\s*>\s*img:not\(\.thumb-bg\)\s*\{([^}]*)\}/,
  )?.[1];
  assert.ok(foreground, 'missing shared foreground media rule');
  assert.match(foreground, /object-fit:\s*contain/);
  assert.match(foreground, /object-position:\s*center/);

  const background = css.match(
    /\.preview\s*>\s*img\.thumb-bg,\s*\.tile-thumb\s*>\s*img\.thumb-bg\s*\{([^}]*)\}/,
  )?.[1];
  assert.ok(background, 'missing shared background media rule');
  assert.match(background, /display:\s*block/);
  assert.match(background, /object-fit:\s*cover/);
  assert.match(background, /filter:\s*blur\(14px\)/);
});

test('keeps only Story-like portrait media on the immersive cover fit', () => {
  assert.match(css, /img\.media-fit-cover:not\(\.thumb-bg\)[\s\S]*?object-fit:\s*cover/);
  // The 0.7 aspect threshold separates Story portraits from ordinary tall photos.
  assert.match(controller, /const PORTRAIT_COVER_MAX_ASPECT = 0\.7/);
});
