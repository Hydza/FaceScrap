// Bound DOM-derived media URLs before mediaId while preserving complete accepted URLs for canonical hashing.
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_MEDIA_URL_LEN, mediaId } from '../src/shared/media';

/** Wrap one media URL in proxies until `stop` returns true. */
function nestProxies(stop: (url: string) => boolean): string {
  let url = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/leaf.jpg';
  while (!stop(url)) {
    url = `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(url)}`;
  }
  return url;
}

test('a real fbcdn URL is nowhere near the bound the detector now applies', () => {
  // Accept a long signed DASH URL with a byte range.
  const real =
    'https://video-mad1-1.xx.fbcdn.net/v/t42.1790-2/10000000_123456789012345_1234567890123456789_n.mp4' +
    '?_nc_cat=104&vs=abcdef0123456789&_nc_sid=5e9851&efg=eyJ2ZW5jb2RlX3RhZyI6Inhwdl9wcm9ncmVzc2l2ZS5GQUNFQk9PSy4uQzMuNzIwLnN2ZV9zZCJ9' +
    '&ccb=9-4&oh=00_AfABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop&oe=68000000&_nc_ht=video-mad1-1.xx.fbcdn.net' +
    '&bytestart=1048576&byteend=2097151';

  assert.ok(
    real.length < MAX_MEDIA_URL_LEN / 4,
    `a real fbcdn URL must sit far under the bound, got ${real.length} of ${MAX_MEDIA_URL_LEN}`,
  );
});

test('the recursive parse is bounded by construction, not by luck', () => {
  // Bound recursive proxy parsing with a chain that crosses the URL limit.
  const atBound = nestProxies((url) => url.length > MAX_MEDIA_URL_LEN);
  const depth = atBound.split('safe_image.php').length - 1;

  assert.ok(depth <= 40, `nesting depth under 8 KB must stay bounded and small, got ${depth}`);
  // Keep identity canonicalization independent from the URL gate.
  assert.match(mediaId(atBound), /^asset:/);
});

test('mediaId keeps one id per resource however the proxy chain is spelled', () => {
  // Ignore rotating outer signatures when deriving nested identity.
  const leaf = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/leaf.jpg';
  const wrap = (oh: string): string =>
    `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(leaf)}&oh=${oh}&oe=68000000`;

  assert.equal(
    mediaId(wrap('00_AfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')),
    mediaId(wrap('00_AfBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')),
    'a rotating signature must not change the id — truncating and hashing the raw URL would',
  );
});
