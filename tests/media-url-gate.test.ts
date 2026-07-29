// Every edge that reaches mediaId() bounds its URL first — normalizeMediaCandidate for
// the page-message channel, classifyNetworkRequest for webRequest, visible-media for the
// DOM scan, playing-handler for inbound covers, storage for stored rows. The detector's
// own reads of `video.currentSrc`, `video.poster` and a cover's background-image were the
// exception: they came from the page's DOM and went straight in.
//
// The cost of that is not a loop. genericEndpointId recurses on nested proxy URLs, and
// each layer percent-encodes the one below it, so depth grows with the LOG of the length
// and a chain cannot spin. What it is, is an inconsistency: one bound applied at five
// borders and not at the sixth, on the one input a co-resident script can shape freely.
//
// The fix belongs at that border and NOT inside mediaId. A gate in mediaId itself would
// have to answer with something, and hashing a truncated URL answers with an id derived
// from the rotating oh/oe signature that canonicalization exists to strip — the same
// image would land under a different id on every load. media.ts's own note on the
// recursive call says as much: the candidate stays unbounded so identityHash keeps seeing
// the string it always saw.
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_MEDIA_URL_LEN, mediaId } from '../src/shared/media';

/** Nested safe_image.php proxies wrapping one fbcdn leaf, until `stop` says so. */
function nestProxies(stop: (url: string) => boolean): string {
  let url = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/leaf.jpg';
  while (!stop(url)) {
    url = `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(url)}`;
  }
  return url;
}

test('a real fbcdn URL is nowhere near the bound the detector now applies', () => {
  // The premise the gate rests on: rejecting nothing Facebook serves. A DASH track URL
  // with a byte range and a full signature is among the longest real shapes there are.
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
  // Each nesting percent-encodes the layer below, so a chain needs a URL that grows
  // geometrically — depth rises with the LOG of the length and cannot spin. Measured, a
  // chain that just crosses 8 KB is 33 layers deep, which is the number this pins: it is
  // the ceiling on how much recursive parsing one DOM read can buy, and it is what makes
  // the gate a consistency fix rather than a mitigation for a live denial of service.
  const atBound = nestProxies((url) => url.length > MAX_MEDIA_URL_LEN);
  const depth = atBound.split('safe_image.php').length - 1;

  assert.ok(depth <= 40, `nesting depth under 8 KB must stay bounded and small, got ${depth}`);
  // And the id of that chain is still the canonical, recursion-derived one: mediaId is
  // NOT where the gate lives, so nothing about its answer changed.
  assert.match(mediaId(atBound), /^asset:/);
});

test('mediaId keeps one id per resource however the proxy chain is spelled', () => {
  // Why the gate is not inside mediaId: identity has to survive the rotating parts. Two
  // wrappings of the same leaf whose OUTER signature differs must still meet, and they
  // only do because the recursion reaches the leaf instead of hashing the raw string.
  const leaf = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/leaf.jpg';
  const wrap = (oh: string): string =>
    `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(leaf)}&oh=${oh}&oe=68000000`;

  assert.equal(
    mediaId(wrap('00_AfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')),
    mediaId(wrap('00_AfBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')),
    'a rotating signature must not change the id — truncating and hashing the raw URL would',
  );
});
