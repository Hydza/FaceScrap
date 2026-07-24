import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const media = readFileSync(join(ROOT, 'src', 'shared', 'media.ts'), 'utf8');
const content = readFileSync(join(ROOT, 'src', 'content', 'content.ts'), 'utf8');
const hook = readFileSync(join(ROOT, 'src', 'content', 'page-hook.ts'), 'utf8');
const panel = readFileSync(join(ROOT, 'src', 'sidepanel', 'sidepanel.ts'), 'utf8');

test('the media model persists bounded image width and height metadata', () => {
  assert.match(media, /width\?: number;/);
  assert.match(media, /MAX_MEDIA_DIMENSION/);
});

test('DOM image capture records natural dimensions on the emitted item', () => {
  assert.match(
    content,
    /const item = makeItem\(src, 'image', source, 'dom', now\);[\s\S]*?item\.width = img\.naturalWidth;[\s\S]*?item\.height = img\.naturalHeight;[\s\S]*?out\.push\(item\);/,
  );
});

test('a responsive image loading after the DOM scan emits its final currentSrc and dimensions', () => {
  assert.match(
    content,
    /document\.addEventListener\(\s*'load',[\s\S]*?img\.currentSrc \|\| img\.src[\s\S]*?item\.width = img\.naturalWidth;[\s\S]*?item\.height = img\.naturalHeight;[\s\S]*?relay\(\[item\]\);[\s\S]*?\{ capture: true, signal: listeners\.signal \}/,
  );
});

test('GraphQL image capture preserves the supplied dimensions', () => {
  assert.match(
    hook,
    /const image = videoUrl == null \? graphqlImageCandidate\(v, childStoryId != null\) : null;[\s\S]*?const item = tagStory\(makeItem\(image\.url, 'image', source, 'graphql', now\), storyId\);[\s\S]*?item\.width = image\.width;[\s\S]*?item\.height = image\.height;[\s\S]*?out\.add\(item\);/,
  );
});

test('Now Playing paints stored image dimensions before natural dimensions arrive', () => {
  assert.match(panel, /imageResolutionLabel = imageDimensionsLabel\(target\)/);
  assert.match(panel, /imageResolutionLabel = `\$\{image\.naturalWidth\}×\$\{image\.naturalHeight\}`;/);
});

test('Now Playing ranks image variants only within the first active canonical resource', () => {
  assert.match(panel, /const firstImage = playingItems\.find/);
  assert.match(panel, /i\.id === firstImage\.id/);
  assert.match(panel, /imagePixelArea\(candidate\) - imagePixelArea\(best\)/);
});
