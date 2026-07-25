import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const css = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.css'), 'utf8');

test('uses one restrained play treatment across preview and cards', () => {
  assert.match(css, /--play-surface:\s*rgba\(15, 17, 20, 0\.55\)/);
  assert.match(css, /--play-line:\s*rgba\(255, 255, 255, 0\.35\)/);

  const preview = css.match(/\.preview-play\s*\{([^}]*)\}/)?.[1];
  assert.ok(preview, 'missing preview play style');
  assert.match(preview, /width:\s*60px/);
  assert.match(preview, /height:\s*60px/);
  assert.match(preview, /top:\s*var\(--play-y,\s*50%\)/);
  assert.match(preview, /left:\s*50%/);
  assert.match(preview, /background:\s*var\(--play-surface\)/);
  assert.match(preview, /border:\s*1px solid var\(--play-line\)/);

  const card = css.match(/\.card-thumb\.is-video::after\s*\{([^}]*)\}/)?.[1];
  assert.ok(card, 'missing card play style');
  assert.match(card, /top:\s*var\(--play-y,\s*50%\)/);
  assert.match(card, /left:\s*50%/);
  assert.match(card, /background-color:\s*var\(--play-surface\)/);
  assert.match(card, /border:\s*1px solid var\(--play-line\)/);
  assert.match(css, /\.preview\.play-obstructed \.preview-play\s*\{\s*visibility:\s*hidden/);
  assert.match(css, /\.card-thumb\.play-obstructed\.is-video::after\s*\{\s*visibility:\s*hidden/);
});
