import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalizeHistoricalMediaId, historicalMediaIds, mediaId } from '../src/shared/media';

function efg(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

test('generic query endpoints ignore rotating signatures without merging distinct resources', () => {
  const first =
    'https://external.xx.fbcdn.net/safe_image.php?url=https%3A%2F%2Fexample.com%2Ffirst.jpg&oh=signature-a&oe=1';
  const refreshed =
    'https://external-other.xx.fbcdn.net/safe_image.php?oe=2&oh=signature-b&url=https%3A%2F%2Fexample.com%2Ffirst.jpg';
  const different =
    'https://external.xx.fbcdn.net/safe_image.php?url=https%3A%2F%2Fexample.com%2Fsecond.jpg&oh=signature-c&oe=3';

  assert.equal(mediaId(first), mediaId(refreshed));
  assert.notEqual(mediaId(first), mediaId(different));
});

test('safe-image proxies canonicalize rotating signatures inside a nested fbcdn rendition', () => {
  const lowNested =
    'https://scontent-a.xx.fbcdn.net/v/t39.30808-6/photo-123_n.jpg?' +
    'stp=dst-jpg_p590x443&oh=nested-a&oe=1';
  const highNested =
    'https://scontent-b.xx.fbcdn.net/v/t39.30808-6/photo-123_n.jpg?' +
    'stp=dst-jpg_p944x1088&oh=nested-b&oe=2';
  const otherNested =
    'https://scontent-a.xx.fbcdn.net/v/t39.30808-6/photo-456_n.jpg?' +
    'stp=dst-jpg_p944x1088&oh=nested-c&oe=3';
  const proxy = (nested: string, signature: string): string =>
    `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(nested)}&oh=${signature}`;

  assert.equal(mediaId(proxy(lowNested, 'outer-a')), mediaId(proxy(highNested, 'outer-b')));
  assert.notEqual(mediaId(proxy(lowNested, 'outer-a')), mediaId(proxy(otherNested, 'outer-c')));
});

test('generic video endpoints use stable efg asset identity instead of fragmenting on rotating query data', () => {
  const firstAsset = efg({
    xpv_asset_id: '12345678901234567',
    video_id: '99887766554433221',
  });
  const sameAsset = efg({
    video_id: '99887766554433221',
    xpv_asset_id: '12345678901234567',
  });
  const otherAsset = efg({
    xpv_asset_id: '22345678901234567',
    video_id: '88776655443322110',
  });
  const first =
    `https://video.xx.fbcdn.net/video_redirect/?efg=${firstAsset}&oh=signature-a&oe=1&token=route-a`;
  const refreshed =
    `https://video-other.xx.fbcdn.net/video_redirect/?token=route-b&oe=2&oh=signature-b&efg=${sameAsset}`;
  const different =
    `https://video.xx.fbcdn.net/video_redirect/?efg=${otherAsset}&oh=signature-c&oe=3&token=route-c`;

  assert.equal(mediaId(first), mediaId(refreshed));
  assert.notEqual(mediaId(first), mediaId(different));
});

test('generic video endpoints keep representations of the same asset distinct', () => {
  const video720 = efg({
    xpv_asset_id: '12345678901234567',
    vencode_tag: 'dash.720.video',
    mime_type: 'video/mp4',
  });
  const video1080 = efg({
    xpv_asset_id: '12345678901234567',
    vencode_tag: 'dash.1080.video',
    mime_type: 'video/mp4',
  });
  const audio = efg({
    xpv_asset_id: '12345678901234567',
    is_audio: true,
    mime_type: 'audio/mp4',
  });
  const refreshed720 = efg({
    mime_type: 'video/mp4',
    vencode_tag: 'dash.720.video',
    xpv_asset_id: '12345678901234567',
  });

  const base = 'https://video.xx.fbcdn.net/video_redirect/';
  const url720 = `${base}?efg=${video720}&oh=signature-a&oe=1`;
  const url1080 = `${base}?efg=${video1080}&oh=signature-b&oe=2`;
  const audioUrl = `${base}?efg=${audio}&oh=signature-c&oe=3`;
  const refreshedUrl720 =
    `https://video-other.xx.fbcdn.net/video_redirect/?oe=4&efg=${refreshed720}&oh=signature-d`;

  assert.equal(mediaId(url720), mediaId(refreshedUrl720));
  assert.notEqual(mediaId(url720), mediaId(url1080));
  assert.notEqual(mediaId(url720), mediaId(audioUrl));
  assert.notEqual(mediaId(url1080), mediaId(audioUrl));
});

test('non-/v/ audio and video extensions stay stable across rotating signatures', () => {
  // mediaKindFromUrl already recognizes these kinds; mediaId must agree and key
  // them by their unique filename instead of fragmenting on oh/oe rotation.
  for (const ext of ['aac', 'mp3', 'ogg', 'opus', 'wav', 'mov', 'm4v']) {
    assert.equal(
      mediaId(`https://cdn.xx.fbcdn.net/o1/clip.${ext}?oh=sig-a&oe=1`),
      mediaId(`https://cdn.xx.fbcdn.net/o1/clip.${ext}?oh=sig-b&oe=2`),
      `${ext} identity must ignore rotating signatures`,
    );
  }
  // Distinct filenames behind the same endpoint must never collapse together.
  assert.notEqual(
    mediaId('https://cdn.xx.fbcdn.net/o1/clip.aac?oh=x&oe=1'),
    mediaId('https://cdn.xx.fbcdn.net/o1/other.aac?oh=y&oe=2'),
  );
});

test('safe-image proxies canonicalize a nested generic video redirector', () => {
  const asset = efg({ xpv_asset_id: '12345678901234567' });
  const nested = (signature: string): string =>
    `https://video.xx.fbcdn.net/video_redirect/?efg=${asset}&oh=${signature}&oe=1`;
  const proxy = (inner: string, outerSignature: string): string =>
    `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(inner)}&oh=${outerSignature}`;

  // Both the outer proxy signature and the nested redirector signature rotate;
  // identity must come from the nested asset, not the raw signed nested string.
  assert.equal(
    mediaId(proxy(nested('nested-a'), 'outer-a')),
    mediaId(proxy(nested('nested-b'), 'outer-b')),
  );
  // A genuinely different nested asset stays distinct.
  const otherAsset = efg({ xpv_asset_id: '99999999999999999' });
  assert.notEqual(
    mediaId(proxy(nested('nested-a'), 'outer-a')),
    mediaId(proxy(`https://video.xx.fbcdn.net/video_redirect/?efg=${otherAsset}&oh=z&oe=9`, 'outer-c')),
  );
});

test('historicalMediaIds emits only asset-scheme aliases that round-trip through canonicalize', () => {
  // A tagged simple video is keyed video-*, never a path-only asset id, so it
  // must not produce a misleading historical alias that canonicalize would
  // round-trip to a different identity.
  const taggedVideo = 'https://video.xx.fbcdn.net/v/t42/abc123.mp4?tag=hd_720p&oh=1&oe=2';
  assert.deepEqual(historicalMediaIds(taggedVideo), []);

  // Whatever alias a generic endpoint does emit must canonicalize back to an
  // asset id — never diverge into a video-*/invalid shape.
  const generic =
    'https://external.xx.fbcdn.net/safe_image.php?url=https%3A%2F%2Fexample.com%2Fx.jpg&oh=a&oe=1';
  const aliases = historicalMediaIds(generic);
  assert.ok(aliases.length >= 1);
  for (const alias of aliases) {
    assert.ok(
      canonicalizeHistoricalMediaId(alias)?.startsWith('asset:'),
      `${alias} must round-trip to an asset id`,
    );
  }
});
