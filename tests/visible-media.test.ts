import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { visibleMediaCandidate } from '../src/content/visible-media';

const NOW = 1_800_000_000_000;
const VIDEO = 'https://video.xx.fbcdn.net/v/t42/visible.mp4?token=one';
const IMAGE = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/visible.jpg?token=one';

test('captures the direct video that is visibly active', () => {
  const item = visibleMediaCandidate(
    { hasVideo: true, videoUrl: VIDEO, videoHeight: 1080, imageUrl: IMAGE },
    'story',
    NOW,
  );

  assert.deepEqual(
    item,
    {
      id: 'video-visible',
      url: VIDEO,
      kind: 'video',
      source: 'story',
      origin: 'dom',
      dash: false,
      addedAt: NOW,
      height: 1080,
    },
  );
});

test('never mistakes a video poster for the active photo', () => {
  assert.equal(
    visibleMediaCandidate({ hasVideo: true, videoUrl: 'blob:https://www.facebook.com/player', imageUrl: IMAGE }, 'story', NOW),
    undefined,
  );
});

test('captures the visible photo even when GraphQL omitted dimensions', () => {
  const item = visibleMediaCandidate(
    { hasVideo: false, imageUrl: IMAGE, imageWidth: 944, imageHeight: 1088 },
    'story',
    NOW,
  );

  assert.equal(item?.kind, 'image');
  assert.equal(item?.url, IMAGE);
  assert.equal(item?.width, 944);
  assert.equal(item?.height, 1088);
});

test('rejects static UI assets and invalid natural dimensions', () => {
  assert.equal(
    visibleMediaCandidate(
      {
        hasVideo: false,
        imageUrl: 'https://static.xx.fbcdn.net/rsrc.php/v4/yP/r/sprite.png',
        imageWidth: 944,
        imageHeight: 1088,
      },
      'page',
      NOW,
    ),
    undefined,
  );
  const item = visibleMediaCandidate(
    { hasVideo: false, imageUrl: IMAGE, imageWidth: -1, imageHeight: Number.POSITIVE_INFINITY },
    'page',
    NOW,
  );
  assert.equal(item?.width, undefined);
  assert.equal(item?.height, undefined);
});

test('rejects an over-length URL before parsing it', () => {
  const suffix = 'a'.repeat(9000); // pushes the URL past MAX_MEDIA_URL_LEN (8192)
  assert.equal(
    visibleMediaCandidate({ hasVideo: true, videoUrl: `${VIDEO}&pad=${suffix}` }, 'story', NOW),
    undefined,
  );
  assert.equal(
    visibleMediaCandidate({ hasVideo: false, imageUrl: `${IMAGE}&pad=${suffix}` }, 'story', NOW),
    undefined,
  );
});

test('the DOM integration classifies only the centred video as video evidence', () => {
  const content = fs.readFileSync(path.join(process.cwd(), 'src', 'content', 'content.ts'), 'utf8');

  assert.match(content, /visibleMediaCandidate\(\s*\{\s*hasVideo: videoEl != null,/);
  assert.doesNotMatch(
    content,
    /visibleMediaCandidate\(\s*\{\s*hasVideo,\s*videoUrl:/,
    'an unrelated playing video elsewhere in the viewport must not suppress the centred photo',
  );
});
