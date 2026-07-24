import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mediaId,
  mergeMedia,
  sanitizeIncomingItems,
  type MediaItem,
} from '../src/shared/media';
import { resetChromeStorage } from './chrome-fake';

const IMAGE_PATH = '/v/t39.30808-6/12345678901234567_n.jpg';
const LOW_URL =
  `https://scontent.xx.fbcdn.net${IMAGE_PATH}?stp=dst-jpg_p590x590&oh=low-signature&oe=1`;
const HIGH_URL =
  `https://scontent.xx.fbcdn.net${IMAGE_PATH}?stp=dst-jpg_p944x1088&oh=high-signature&oe=2`;
const HIGH_REFRESHED_URL =
  `https://scontent.xx.fbcdn.net${IMAGE_PATH}?stp=dst-jpg_p944x1088&oh=refreshed-signature&oe=3`;
const NOW = 1_800_000_000_000;
const FIRST_STORY_ID = Buffer.from('S:_ISC:980000000000001').toString('base64');
const SECOND_STORY_ID = Buffer.from('S:_ISC:980000000000002').toString('base64');

function image(
  url: string,
  width: number,
  height: number,
  overrides: Partial<MediaItem> = {},
): MediaItem {
  return {
    id: mediaId(url),
    url,
    kind: 'image',
    source: 'story',
    origin: 'graphql',
    addedAt: NOW - 1_000,
    width,
    height,
    ...overrides,
  };
}

test('MediaItem accepts optional image width metadata', () => {
  const withoutWidth: MediaItem = {
    id: mediaId(LOW_URL),
    url: LOW_URL,
    kind: 'image',
    source: 'story',
    origin: 'graphql',
    addedAt: NOW,
  };
  const withWidth: MediaItem = { ...withoutWidth, width: 590 };

  assert.equal(withoutWidth.width, undefined);
  assert.equal(withWidth.width, 590);
});

test('sanitizeIncomingItems keeps bounded positive integer image dimensions', () => {
  const [clean] = sanitizeIncomingItems(
    [image(HIGH_URL, 944, 1_088, { addedAt: NOW })],
    Number.POSITIVE_INFINITY,
    NOW,
  );

  assert.equal(clean.width, 944);
  assert.equal(clean.height, 1_088);
});

test('sanitizeIncomingItems drops invalid dimensions without dropping the image', () => {
  const invalidDimensions = [
    { width: 0, height: 443 },
    { width: -1, height: 443 },
    { width: 590.5, height: 443 },
    { width: 1_000_000, height: 443 },
    { width: 590, height: 0 },
    { width: 590, height: -1 },
    { width: 590, height: 443.5 },
    { width: 590, height: 1_000_000 },
  ];

  for (const [index, dimensions] of invalidDimensions.entries()) {
    const url = `${LOW_URL}&case=${index}`;
    const [clean] = sanitizeIncomingItems(
      [{ ...image(url, 590, 443, { addedAt: NOW }), ...dimensions }],
      Number.POSITIVE_INFINITY,
      NOW,
    );

    assert.ok(clean, `invalid dimension case ${index} must not discard the image`);
    if (dimensions.width !== 590) assert.equal(clean.width, undefined);
    else assert.equal(clean.width, 590);
    if (dimensions.height !== 443) assert.equal(clean.height, undefined);
    else assert.equal(clean.height, 443);
  }
});

test('mergeMedia promotes a same-path image variant and preserves capture metadata', () => {
  const stored = image(LOW_URL, 590, 443, {
    source: 'story',
    origin: 'graphql',
    addedAt: NOW - 1_000,
    storyIds: [FIRST_STORY_ID],
  });
  const incoming = image(HIGH_URL, 944, 1_088, {
    source: 'page',
    origin: 'dom',
    addedAt: NOW,
    storyIds: [SECOND_STORY_ID],
  });

  const [merged, changed] = mergeMedia([stored], [incoming], NOW);

  assert.equal(changed, true);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, mediaId(HIGH_URL));
  assert.equal(merged[0].url, HIGH_URL);
  assert.equal(merged[0].width, 944);
  assert.equal(merged[0].height, 1_088);
  assert.equal(merged[0].addedAt, stored.addedAt);
  assert.equal(merged[0].source, stored.source);
  assert.equal(merged[0].origin, stored.origin);
  assert.deepEqual(merged[0].storyIds, [FIRST_STORY_ID, SECOND_STORY_ID]);
});

test('mergeMedia never degrades a high-resolution image with a lower variant', () => {
  const stored = image(HIGH_URL, 944, 1_088, {
    storyIds: [FIRST_STORY_ID],
  });
  const incoming = image(LOW_URL, 590, 443, {
    addedAt: NOW,
    source: 'page',
    storyIds: [SECOND_STORY_ID],
  });

  const [merged] = mergeMedia([stored], [incoming], NOW);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, HIGH_URL);
  assert.equal(merged[0].width, 944);
  assert.equal(merged[0].height, 1_088);
  assert.equal(merged[0].addedAt, stored.addedAt);
  assert.equal(merged[0].source, stored.source);
  assert.deepEqual(merged[0].storyIds, [FIRST_STORY_ID, SECOND_STORY_ID]);
});

test('mergeMedia refreshes an equal-resolution image URL without replacing capture metadata', () => {
  const stored = image(HIGH_URL, 944, 1_088, {
    addedAt: NOW - 1_000,
    source: 'story',
    storyIds: [FIRST_STORY_ID],
  });
  const incoming = image(HIGH_REFRESHED_URL, 944, 1_088, {
    addedAt: NOW,
    source: 'page',
    storyIds: [SECOND_STORY_ID],
  });

  const [merged, changed] = mergeMedia([stored], [incoming], NOW);

  assert.equal(changed, true);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, HIGH_REFRESHED_URL);
  assert.equal(merged[0].id, mediaId(HIGH_REFRESHED_URL));
  assert.equal(merged[0].width, 944);
  assert.equal(merged[0].height, 1_088);
  assert.equal(merged[0].addedAt, stored.addedAt);
  assert.equal(merged[0].source, stored.source);
  assert.deepEqual(merged[0].storyIds, [FIRST_STORY_ID, SECOND_STORY_ID]);
});

test('mergeMedia does not conflate different image geometry with the same pixel area', () => {
  const landscape = image(LOW_URL, 800, 600, { addedAt: NOW - 1_000 });
  const portrait = image(HIGH_URL, 600, 800, { addedAt: NOW });

  const [merged] = mergeMedia([landscape], [portrait], NOW);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].url, LOW_URL);
  assert.equal(merged[0].width, 800);
  assert.equal(merged[0].height, 600);
});

test('mergeMedia keeps images with distinct canonical paths separate', () => {
  const otherUrl =
    'https://scontent.xx.fbcdn.net/v/t39.30808-6/22345678901234567_n.jpg?stp=dst-jpg_p944x1088&oh=other';

  const [merged] = mergeMedia(
    [],
    [
      image(HIGH_URL, 944, 1_088, { addedAt: NOW }),
      image(otherUrl, 944, 1_088, { addedAt: NOW }),
    ],
    NOW,
  );

  assert.equal(merged.length, 2);
  assert.notEqual(merged[0].id, merged[1].id);
});

test('mediaId never groups different images served through one generic endpoint path', () => {
  const first =
    'https://external.xx.fbcdn.net/safe_image.php?url=https%3A%2F%2Fexample.com%2Ffirst.jpg&oh=first';
  const second =
    'https://external.xx.fbcdn.net/safe_image.php?url=https%3A%2F%2Fexample.com%2Fsecond.jpg&oh=second';

  const [merged] = mergeMedia(
    [],
    [
      image(first, 944, 1_088, { addedAt: NOW }),
      image(second, 944, 1_088, { addedAt: NOW }),
    ],
    NOW,
  );

  assert.notEqual(mediaId(first), mediaId(second));
  assert.equal(merged.length, 2);
});

test('mediaId still collapses signed variants of one WebP object', () => {
  const path = '/v/t39.30808-6/12345678901234567_n.webp';
  const low = `https://scontent.xx.fbcdn.net${path}?stp=dst-webp_p590x443&oh=low`;
  const high = `https://scontent.xx.fbcdn.net${path}?stp=dst-webp_p944x1088&oh=high`;

  assert.equal(mediaId(low), mediaId(high));
});

test('the storage capture lane persists a low-to-high image promotion', async () => {
  await resetChromeStorage();
  const { addMedia, getMedia } = await import('../src/shared/storage');
  await new Promise<void>((resolve) => setImmediate(resolve));
  const tabId = 91_001;
  const capturedAt = Date.now();
  const low = image(LOW_URL, 590, 443, { addedAt: capturedAt - 1_000 });
  const high = image(HIGH_URL, 944, 1_088, { addedAt: capturedAt });

  assert.equal(await addMedia(tabId, [low]), 1);
  assert.equal(await addMedia(tabId, [high]), 1);

  const stored = await getMedia(tabId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].url, HIGH_URL);
  assert.equal(stored[0].width, 944);
  assert.equal(stored[0].height, 1_088);
  assert.equal(stored[0].addedAt, low.addedAt);
});
