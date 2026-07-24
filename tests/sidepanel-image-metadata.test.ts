import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const markup = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.html'), 'utf8');
const controller = readFileSync(join(process.cwd(), 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

test('image Now Playing hides the duration metric instead of showing a dash', () => {
  assert.match(markup, /<div id="m-duration-metric" class="metric">/);
  assert.match(controller, /const isImage = now\.kind === 'image';/);
  assert.match(controller, /byId\('m-duration-metric'\)\.hidden = isImage;/);
  assert.match(
    controller,
    /byId\('m-duration'\)\.textContent = isImage\s*\?\s*''\s*:\s*now\.durationSec != null\s*\?\s*formatDuration\(now\.durationSec\)\s*:\s*'—';/,
  );
});

test('image Now Playing paints the loaded image natural dimensions', () => {
  assert.match(
    controller,
    /imageResolutionLabel = `\$\{image\.naturalWidth\}×\$\{image\.naturalHeight\}`;/,
  );
  assert.match(
    controller,
    /if \(now\.kind !== 'image' \|\| !image\.isConnected \|\| image\.naturalWidth <= 0 \|\| image\.naturalHeight <= 0\) return;/,
  );
  assert.match(
    controller,
    /target\.kind === 'video' \? resolutionOf\(target\)\.label : imageResolutionLabel \?\? '—'/,
  );
});

test('a refreshed signed URL invalidates the Now Playing render signature', () => {
  assert.match(
    controller,
    /\.map\(\(o\) => `\$\{o\.id\}:\$\{o\.url\}:\$\{o\.width \?\? ''\}x\$\{o\.height \?\? ''\}`\)/,
  );
});
