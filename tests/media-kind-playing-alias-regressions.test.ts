import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import {
  classifyNetworkRequest,
  makeItem,
  mediaId,
  mergeMedia,
  type MediaItem,
} from '../src/shared/media';

const NOW = 1_800_000_000_000;

test('network classification keeps fbcdn JPG and WebP resources as images', () => {
  const urls = [
    'https://scontent.xx.fbcdn.net/v/t39.30808-6/12345678901234567_n.jpg?oh=jpg-signature',
    'https://scontent.xx.fbcdn.net/v/t39.30808-6/12345678901234567_n.webp?oh=webp-signature',
  ];

  for (const url of urls) {
    const classified = classifyNetworkRequest(url, NOW);

    assert.ok(classified, `expected ${url} to remain a capture candidate`);
    assert.equal(classified.kind, 'image');
  }
});

test('an image extension wins over a contradictory video MIME parameter', () => {
  const url =
    'https://scontent.xx.fbcdn.net/v/t39.30808-6/photo.jpg?mime_type=video%2Fmp4&oh=signature';

  assert.equal(makeItem(url, 'video', 'video', 'network', NOW).kind, 'image');
});

test('a video container never becomes an image from a contradictory MIME parameter', () => {
  const url =
    'https://video.xx.fbcdn.net/v/t42/video-track.mp4?mime=image%2Fjpeg&oh=signature';

  assert.equal(makeItem(url, 'image', 'page', 'dom', NOW).kind, 'video');
});

test('DOM image evidence repairs an ambiguous network-video row with the same canonical id', () => {
  const path = '/v/t39.30808-6/12345678901234567_n.jpg';
  const lowUrl = `https://scontent.xx.fbcdn.net${path}?stp=dst-jpg_p590x443&oh=low`;
  const highUrl = `https://scontent.xx.fbcdn.net${path}?stp=dst-jpg_p944x1088&oh=high`;
  const ambiguous = makeItem(lowUrl, 'video', 'video', 'network', NOW);
  const image = makeItem(highUrl, 'image', 'page', 'dom', NOW + 1);
  image.width = 944;
  image.height = 1_088;

  assert.equal(ambiguous.id, image.id);

  const [merged] = mergeMedia([ambiguous], [image], NOW + 1);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'image');
  assert.equal(merged[0].url, highUrl);
  assert.equal(merged[0].width, 944);
  assert.equal(merged[0].height, 1_088);
});

test('image-shaped evidence never converts a canonical MP4 video row to image', () => {
  const url = 'https://video.xx.fbcdn.net/v/t42/12345678901234567.mp4?oh=video-signature';
  const video = makeItem(url, 'video', 'video', 'network', NOW);
  const misleadingImage = makeItem(url, 'image', 'page', 'dom', NOW + 1);
  misleadingImage.width = 944;
  misleadingImage.height = 1_088;

  const [merged] = mergeMedia([video], [misleadingImage], NOW + 1);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'video');
  assert.equal(merged[0].url, url);
});

test('an explicit audio hint keeps an audio-only MP4 track classified as audio', () => {
  const url = 'https://video.xx.fbcdn.net/v/t42/audio-track.mp4?oh=audio-signature';

  assert.equal(makeItem(url, 'audio', 'video', 'network', NOW).kind, 'audio');
});

test('an audio MIME discriminator overrides an ambiguous generic MP4 endpoint', () => {
  const url =
    'https://video.xx.fbcdn.net/video_redirect/?xpv=12345678901234567&mime_type=audio%2Fmp4';

  assert.equal(makeItem(url, 'video', 'video', 'network', NOW).kind, 'audio');
});

test('network capture recognizes an audio-only generic endpoint from its efg metadata', () => {
  const efg = Buffer.from(JSON.stringify({
    xpv_asset_id: '12345678901234567',
    is_audio: true,
    mime_type: 'audio/mp4',
  })).toString('base64url');
  const url = `https://video.xx.fbcdn.net/video_redirect/?efg=${efg}&oh=audio-signature`;

  assert.equal(classifyNetworkRequest(url, NOW)?.kind, 'audio');
});

test('selectPlaying recognizes the path-only generic endpoint id after storage migration', async () => {
  await resetChromeStorage();
  const { getMedia, setPlaying } = await import('../src/shared/storage');
  const { purgeTabBindings, selectPlaying } = await import('../src/shared/now-playing');
  const tabId = 99_201;
  const oldId = 'asset:/safe_image.php';
  const url =
    'https://external.xx.fbcdn.net/safe_image.php?' +
    'url=https%3A%2F%2Fexample.com%2Fsame.jpg&oh=rotating-signature&oe=1';
  const oldRow: MediaItem = {
    id: oldId,
    url,
    kind: 'image',
    source: 'story',
    origin: 'dom',
    addedAt: NOW,
  };

  try {
    await chrome.storage.session.set({ [`media_${tabId}`]: [oldRow] });
    await setPlaying(tabId, { ids: [oldId], hasVideo: false, at: NOW }, NOW);

    const migrated = await getMedia(tabId);
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].id, mediaId(url));
    assert.notEqual(migrated[0].id, oldId);
    assert.deepEqual(await selectPlaying(tabId, migrated), migrated);
  } finally {
    purgeTabBindings(tabId);
    await resetChromeStorage();
  }
});
