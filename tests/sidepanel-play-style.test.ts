import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

test('uses one restrained play treatment across preview and tiles', () => {
  // Use one literal media-overlay treatment for both glyph sizes.
  const preview = css.match(/\.preview-play\s*\{([^}]*)\}/)?.[1];
  assert.ok(preview, 'missing preview play style');
  assert.match(preview, /width:\s*56px/);
  assert.match(preview, /height:\s*56px/);
  assert.match(preview, /top:\s*var\(--play-y,\s*50%\)/);
  assert.match(preview, /left:\s*50%/);
  assert.match(preview, /background:\s*rgba\(10, 12, 15, 0\.42\)/);
  assert.match(preview, /border:\s*1px solid rgba\(255, 255, 255, 0\.38\)/);

  const tile = css.match(/\.tile-thumb\.is-video::after\s*\{([^}]*)\}/)?.[1];
  assert.ok(tile, 'missing tile play style');
  assert.match(tile, /width:\s*38px/);
  assert.match(tile, /height:\s*38px/);
  assert.match(tile, /top:\s*var\(--play-y,\s*50%\)/);
  assert.match(tile, /left:\s*50%/);
  assert.match(tile, /background-color:\s*rgba\(10, 12, 15, 0\.42\)/);
  assert.match(tile, /border:\s*1px solid rgba\(255, 255, 255, 0\.35\)/);

  assert.match(css, /\.preview\.play-obstructed \.preview-play\s*\{\s*visibility:\s*hidden/);
  assert.match(css, /\.tile-thumb\.play-obstructed\.is-video::after\s*\{\s*visibility:\s*hidden/);
});

test('the measured sizes are the rendered sizes', () => {
  // Keep runtime placement dimensions aligned with the rendered glyph.
  const source = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'media-play.ts'), 'utf8');
  assert.match(source, /const PREVIEW_PLAY_SIZE = 56/);
  assert.match(source, /const CARD_PLAY_SIZE = 38/);
  // Measure both media overlays when positioning the glyph.
  assert.match(source, /getElementById\('now-foot'\)/);
  assert.match(source, /querySelector<HTMLElement>\('\.tile-caption'\)/);
});
