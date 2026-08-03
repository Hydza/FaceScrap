import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_MEDIA_ITEM_BYTES,
  MAX_MEDIA_BATCH_BYTES,
  MAX_TRACK_IDS,
  NUMERIC_MEDIA_ID_RE,
  NUMERIC_MEDIA_ID_SOURCE,
  classifyNetworkRequest,
  fileExtensionFor,
  historicalAliasOwners,
  historicalMediaIds,
  isNumericMediaId,
  matchesActiveMediaId,
  mediaId,
  mediaItemWeight,
  mediaSourceFromLocation,
  mergeMedia,
  sanitizeIncomingItems,
  widenDashUrl,
  type MediaItem,
} from '../src/shared/media';

const URL = 'https://video.xx.fbcdn.net/v/t42.1790-2/12345678901234567_n.mp4';

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'fb:12345678901234567',
    url: URL,
    kind: 'video',
    source: 'story',
    origin: 'graphql',
    addedAt: 1,
    ...overrides,
  };
}

test('sanitizeIncomingItems inspects only the bounded track-id prefix', () => {
  const backing = Array.from({ length: MAX_TRACK_IDS + 10_000 }, (_, index) => `track-${index}`);
  const guarded = new Proxy(backing, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property) && Number(property) >= MAX_TRACK_IDS) {
        throw new Error('read beyond bounded prefix');
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const clean = sanitizeIncomingItems([item({ trackIds: guarded })]);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].trackIds?.length, MAX_TRACK_IDS);
});

test('sanitizeIncomingItems rejects a MediaItem above the serialized byte bound', () => {
  const oversized = item({
    id: 'á'.repeat(256),
    url: `${URL}?x=${'á'.repeat(8_000)}`,
    audioUrl: `${URL}?a=${'á'.repeat(8_000)}`,
    thumbUrl: `https://scontent.xx.fbcdn.net/v/t1.0-9/12345678901234567_n.jpg?t=${'á'.repeat(8_000)}`,
    trackIds: Array.from({ length: MAX_TRACK_IDS }, () => 'á'.repeat(512)),
  });

  assert.ok(mediaItemWeight(oversized) > MAX_MEDIA_ITEM_BYTES);
  assert.deepEqual(sanitizeIncomingItems([oversized]), []);
});

test('sanitizeIncomingItems enforces an aggregate runtime-message byte budget', () => {
  const first = item({ id: 'first', trackIds: Array.from({ length: 4 }, () => 'a'.repeat(512)) });
  const second = item({ id: 'second', trackIds: Array.from({ length: 4 }, () => 'b'.repeat(512)) });
  const now = 1_800_000_000_000;
  const canonicalFirst = sanitizeIncomingItems([first], Number.POSITIVE_INFINITY, now)[0];
  const firstBytes = mediaItemWeight(canonicalFirst);

  assert.ok(firstBytes < MAX_MEDIA_BATCH_BYTES);
  assert.deepEqual(
    sanitizeIncomingItems([first, second], firstBytes + 10, now).map((entry) => entry.id),
    [mediaId(URL)],
  );
});

test('mergeMedia bounds track ids and rejects oversized persisted candidates defensively', () => {
  const bounded = mergeMedia([], [item({
    trackIds: Array.from({ length: MAX_TRACK_IDS + 50 }, (_, index) => `track-${index}`),
  })])[0];
  assert.equal(bounded[0].trackIds?.length, MAX_TRACK_IDS);

  const oversized = item({ extra: 'á'.repeat(MAX_MEDIA_ITEM_BYTES) } as Partial<MediaItem>);
  assert.deepEqual(mergeMedia([], [oversized]), [[], false]);
});

test('sanitizeIncomingItems derives one canonical id for the same URL regardless of forged ids', () => {
  const now = 1_800_000_000_000;
  const [first, second] = sanitizeIncomingItems([
    item({ id: 'forged-a', addedAt: now }),
    item({ id: 'forged-b', addedAt: now }),
  ], Number.POSITIVE_INFINITY, now);

  assert.equal(first.id, mediaId(URL));
  assert.equal(second.id, first.id);
});

test('canonical media ids do not collide when two URLs carry the same forged id', () => {
  const now = 1_800_000_000_000;
  const otherUrl = 'https://video.xx.fbcdn.net/v/t42.1790-2/22345678901234567_n.mp4';
  const clean = sanitizeIncomingItems([
    item({ id: 'shared-forgery', addedAt: now }),
    item({ id: 'shared-forgery', url: otherUrl, addedAt: now }),
  ], Number.POSITIVE_INFINITY, now);

  assert.equal(clean.length, 2);
  assert.notEqual(clean[0].id, clean[1].id);

  const [merged] = mergeMedia([], clean, now);
  assert.equal(merged.length, 2);
});

test('mediaId keeps DASH representations distinct but ignores routing and signature rotation', () => {
  const first = 'https://video.xx.fbcdn.net/v/t42/12345678901234567/video-720.mp4?bytestart=0&byteend=99&oh=a&oe=1';
  const routed = 'https://video-other.xx.fbcdn.net/o1/v/t42/12345678901234567/video-720.mp4?bytestart=100&byteend=199&oh=b&oe=2';
  const otherRepresentation = 'https://video.xx.fbcdn.net/v/t42/12345678901234567/video-1080.mp4?oh=c&oe=3';

  assert.equal(mediaId(first), mediaId(routed));
  assert.notEqual(mediaId(first), mediaId(otherRepresentation));
});

test('sanitizeIncomingItems normalizes remote and future dates while preserving in-flight dates', () => {
  const now = 1_800_000_000_000;
  const legitimate = now - 30_000;
  const urls = [
    URL,
    'https://video.xx.fbcdn.net/v/t42.1790-2/22345678901234567_n.mp4',
    'https://video.xx.fbcdn.net/v/t42.1790-2/32345678901234567_n.mp4',
  ];
  const clean = sanitizeIncomingItems([
    item({ url: urls[0], addedAt: legitimate }),
    item({ url: urls[1], addedAt: now - 86_400_000 }),
    item({ url: urls[2], addedAt: now + 86_400_000 }),
  ], Number.POSITIVE_INFINITY, now);

  assert.deepEqual(clean.map((entry) => entry.addedAt), [legitimate, now, now]);
});

test('mergeMedia canonicalizes ids and dates even when callers bypass sanitization', () => {
  const now = 1_800_000_000_000;
  const [merged] = mergeMedia([], [
    item({ id: 'first-forgery', addedAt: now - 86_400_000 }),
    item({ id: 'second-forgery', addedAt: now + 86_400_000 }),
  ], now);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, mediaId(URL));
  assert.equal(merged[0].addedAt, now);
});

test('mergeMedia compacts legacy rows that assigned different ids to the same URL', () => {
  const now = 1_800_000_000_000;
  const [merged, changed] = mergeMedia([
    item({ id: 'legacy-a', addedAt: now }),
    item({ id: 'legacy-b', addedAt: now }),
  ], [], now);

  assert.equal(changed, true);
  assert.deepEqual(merged.map((entry) => entry.id), [mediaId(URL)]);
});

test('mergeMedia enriches near-limit rows transactionally without dropping stored fields', () => {
  const now = 1_800_000_000_000;
  const largeUrl = `${URL}?stable=${'á'.repeat(7_000)}`;
  const storedThumb = `https://scontent.xx.fbcdn.net/v/t1.0-9/12345678901234567_n.jpg?thumb=${'á'.repeat(7_000)}`;
  const incomingAudio = `https://video.xx.fbcdn.net/v/t42.1790-2/92345678901234567_n.mp4?audio=${'á'.repeat(7_000)}`;
  const incomingTracks = Array.from({ length: 28 }, (_, index) => `${index}-${'á'.repeat(508)}`);
  const storyId = Buffer.from('S:_ISC:980000000009999').toString('base64');
  const stored = item({
    id: 'stored-id-is-not-authority',
    url: largeUrl,
    thumbUrl: storedThumb,
    addedAt: now,
  });
  const incoming = item({
    id: 'incoming-id-is-not-authority',
    url: largeUrl,
    audioUrl: incomingAudio,
    trackIds: incomingTracks,
    storyIds: [storyId],
    addedAt: now,
  });

  assert.ok(mediaItemWeight(stored) <= MAX_MEDIA_ITEM_BYTES);
  assert.ok(mediaItemWeight(incoming) <= MAX_MEDIA_ITEM_BYTES);
  assert.ok(mediaItemWeight({ ...stored, ...incoming, thumbUrl: storedThumb }) > MAX_MEDIA_ITEM_BYTES);

  const [merged, changed] = mergeMedia([stored], [incoming], now);
  const result = merged[0];

  assert.equal(changed, true);
  assert.ok(mediaItemWeight(result) <= MAX_MEDIA_ITEM_BYTES);
  assert.equal(result.thumbUrl, storedThumb, 'an existing low-priority field is never discarded');
  assert.deepEqual(result.storyIds, [storyId], 'the strongest exact association is retained');
  assert.equal(result.audioUrl, incomingAudio, 'linked audio is preferred before new low-priority metadata');
  assert.ok((result.trackIds?.length ?? 0) > 0, 'a useful bounded track prefix is retained');
  assert.ok((result.trackIds?.length ?? 0) < incomingTracks.length, 'the overweight track tail is dropped');
});

test('mediaSourceFromLocation anchors the highlight check to a real path segment', () => {
  assert.equal(mediaSourceFromLocation('/stories/highlights/123', ''), 'highlight');
  assert.equal(mediaSourceFromLocation('/someuser/highlights', ''), 'highlight');
  assert.equal(mediaSourceFromLocation('/watch/HIGHLIGHT/123', ''), 'highlight', 'case-insensitive');
  // Do not match "highlight" inside a larger vanity slug.
  assert.equal(mediaSourceFromLocation('/football.highlights.daily/videos/123', ''), 'video');
  assert.equal(mediaSourceFromLocation('/mypagehighlights/videos/123', ''), 'video');
});

test('mediaSourceFromLocation keeps the highlight > stories > reel > video precedence', () => {
  assert.equal(mediaSourceFromLocation('/stories/highlights/123', ''), 'highlight', 'highlight beats stories');
  assert.equal(mediaSourceFromLocation('/stories/123', ''), 'story');
  assert.equal(mediaSourceFromLocation('/reel/123', ''), 'reel');
  assert.equal(mediaSourceFromLocation('/watch/', ''), 'video');
});

// Profile highlights use a story path with a query marker.
test('mediaSourceFromLocation reads the profile-highlight marker out of the query', () => {
  // Split the fixture manually because this file shadows the global URL constructor.
  assert.equal(mediaSourceFromLocation('/stories/976731645401448/', '?source=profile_highlight'), 'highlight');

  // Accept either leading delimiter and any parameter order.
  assert.equal(mediaSourceFromLocation('/stories/123/', '?source=profile_highlight'), 'highlight');
  assert.equal(mediaSourceFromLocation('/stories/123/', 'source=profile_highlight'), 'highlight');
  assert.equal(mediaSourceFromLocation('/stories/123/', '?foo=1&source=profile_highlight&bar=2'), 'highlight');
  assert.equal(mediaSourceFromLocation('/stories/123/', '?source=highlights'), 'highlight');
});

test('mediaSourceFromLocation leaves other story entry points alone', () => {
  // Only the highlight marker may override the story path.
  for (const search of ['', '?source=story_tray', '?source=permalink', '?source=notification', '?source=feed_story']) {
    assert.equal(mediaSourceFromLocation('/stories/123/', search), 'story', `search=${search || '(none)'}`);
  }
  // Require a complete highlight marker boundary.
  assert.equal(mediaSourceFromLocation('/stories/123/', '?source=spotlighted'), 'story');
  assert.equal(mediaSourceFromLocation('/stories/123/', '?source=nothighlighted'), 'story');
  // The path must still identify a media-bearing page.
  assert.equal(mediaSourceFromLocation('/reel/123', '?source=story_tray'), 'reel');
});

test('fileExtensionFor derives the extension from the URL pathname when it matches the item kind', () => {
  assert.equal(
    fileExtensionFor({ url: 'https://scontent.xx.fbcdn.net/v/t1.0-9/photo.png?oh=a&oe=b', kind: 'image' }),
    'png',
  );
  assert.equal(
    fileExtensionFor({ url: 'https://scontent.xx.fbcdn.net/v/t1.0-9/photo.WEBP?oh=a', kind: 'image' }),
    'webp',
    'uppercase extensions are recognized and normalized to lowercase',
  );
  assert.equal(
    fileExtensionFor({ url: 'https://video.xx.fbcdn.net/v/t42/track.ogg?oh=a#frag', kind: 'audio' }),
    'ogg',
    'query strings and fragments are stripped before matching',
  );
  assert.equal(
    fileExtensionFor({ url: 'https://video.xx.fbcdn.net/v/t42/clip.webm?oh=a', kind: 'video' }),
    'webm',
  );
});

test('fileExtensionFor falls back to the per-kind default', () => {
  assert.equal(
    fileExtensionFor({ url: 'https://video.xx.fbcdn.net/v/t42/clip', kind: 'video' }),
    'mp4',
    'no extension at all',
  );
  assert.equal(
    fileExtensionFor({ url: 'not a url', kind: 'image' }),
    'jpg',
    'an unparseable URL never throws',
  );
  assert.equal(
    fileExtensionFor({ url: 'https://scontent.xx.fbcdn.net/v/t1.0-9/photo.jpg', kind: 'audio' }),
    'm4a',
    'an extension recognized for a different kind does not leak across kinds',
  );
  assert.equal(
    fileExtensionFor({ url: URL, kind: 'audio' }),
    'm4a',
    'a .mp4 URL on an audio item falls back instead of mislabeling the container',
  );
});

test('matchesActiveMediaId matches by id, by recomputed mediaId, and by legacyMediaId', () => {
  const it = item({ id: 'forged-id' });
  const noAliases = new Map<string, Set<string>>();

  assert.equal(matchesActiveMediaId(it, new Set(['forged-id']), noAliases), true, 'exact id match');
  assert.equal(matchesActiveMediaId(it, new Set([mediaId(URL)]), noAliases), true, 'recomputed mediaId match');
  assert.equal(
    matchesActiveMediaId(it, new Set(['fb:12345678901234567']), noAliases),
    true,
    'legacyMediaId match',
  );
  assert.equal(matchesActiveMediaId(it, new Set(['unrelated']), noAliases), false, 'no match');
});

test('historicalAliasOwners + matchesActiveMediaId honour an unambiguous alias but refuse an ambiguous one', () => {
  const now = 1_800_000_000_000;
  const taggedA = `${URL}?tag=abc_720p`;
  const taggedB = `${URL}?tag=xyz_480p`;
  const alias = historicalMediaIds(taggedA)[0];
  assert.ok(alias, 'the tagged URL carries a path-only historical alias');
  assert.equal(alias, mediaId(URL));

  const itemA = item({ id: mediaId(taggedA), url: taggedA, addedAt: now });
  const itemB = item({ id: mediaId(taggedB), url: taggedB, addedAt: now });
  const active = new Set([alias]);

  const soleOwner = historicalAliasOwners([itemA]);
  assert.equal(matchesActiveMediaId(itemA, active, soleOwner), true, 'a single current owner may use the alias');

  const ambiguousOwners = historicalAliasOwners([itemA, itemB]);
  assert.equal(
    matchesActiveMediaId(itemA, active, ambiguousOwners),
    false,
    'two current owners make the alias ambiguous',
  );
  assert.equal(
    matchesActiveMediaId(itemB, active, ambiguousOwners),
    false,
    'ambiguity blocks every owner, not just one',
  );
});

// Media item weight memoization

test('mediaItemWeight memoizes by object identity so a later mutation does not change the cached weight', () => {
  const candidate: Record<string, unknown> = { a: 'x' };
  const first = mediaItemWeight(candidate);
  candidate.a = 'x'.repeat(10_000);

  assert.equal(
    mediaItemWeight(candidate),
    first,
    'the SAME object reference must return its memoized weight, not one reflecting the later mutation',
  );
  assert.ok(
    mediaItemWeight({ ...candidate }) > first,
    'an object the cache has never seen before is still computed fresh',
  );
});

test('mediaItemWeight never throws for a non-object value (the identity cache must not require an object key)', () => {
  assert.equal(mediaItemWeight(undefined), Number.POSITIVE_INFINITY);
  assert.doesNotThrow(() => mediaItemWeight(42));
  assert.doesNotThrow(() => mediaItemWeight('plain string'));
  assert.doesNotThrow(() => mediaItemWeight(null));
  assert.doesNotThrow(() => mediaItemWeight(true));
});

// Generic endpoint identity bounds

test('mediaId bounds the unknown-generic-endpoint fallback so an over-long query cannot break the shared 256-char id contract', () => {
  const longQuery = `https://api.xx.fbcdn.net/graphql/unknown_endpoint/?a=${'x'.repeat(2000)}&b=2`;
  const otherLongQuery = `https://api.xx.fbcdn.net/graphql/unknown_endpoint/?a=${'y'.repeat(2000)}&b=2`;
  const shortQuery = 'https://api.xx.fbcdn.net/graphql/unknown_endpoint/?a=1&b=2';

  const id = mediaId(longQuery);

  // Keep IDs within the shared transport and receipt limit.
  assert.ok(id.length <= 256, `bounded id must fit the shared 256-char id contract, got ${id.length}`);
  assert.equal(mediaId(longQuery), id, 'the same URL must hash to a stable id across calls');
  assert.notEqual(id, mediaId(otherLongQuery), 'two different overlong queries must not collide into one id');
  assert.equal(
    mediaId(shortQuery),
    'asset:/graphql/unknown_endpoint/?a=1&b=2',
    'a URL that already produces a short id keeps its exact prior shape (overflow-only bounding)',
  );
});

// Shared media sanitization

test('every optional MediaItem field survives sanitizeIncomingItems and then a getMedia-style re-merge', () => {
  const now = 1_800_000_000_000;
  const raw = {
    id: 'ignored-forged-id',
    url: URL,
    kind: 'video',
    source: 'story',
    origin: 'graphql',
    addedAt: now,
    dash: true,
    audioUrl: `${URL}?audio=1`,
    thumbUrl: 'https://scontent.xx.fbcdn.net/v/t1.0-9/12345678901234567_n.jpg',
    width: 720,
    height: 1280,
    durationSec: 12.5,
    trackIds: ['track-a', 'track-b'],
    storyIds: [Buffer.from('S:_ISC:980000000009999').toString('base64')],
  };

  const sanitized = sanitizeIncomingItems([raw], Number.POSITIVE_INFINITY, now)[0];
  assert.ok(sanitized, 'the raw candidate must sanitize into one clean item');
  // Anchor parity checks to the original input values.
  assert.equal(sanitized.dash, raw.dash);
  assert.equal(sanitized.audioUrl, raw.audioUrl);
  assert.equal(sanitized.thumbUrl, raw.thumbUrl);
  assert.equal(sanitized.width, raw.width);
  assert.equal(sanitized.height, raw.height);
  assert.equal(sanitized.durationSec, raw.durationSec);
  assert.deepEqual(sanitized.trackIds, raw.trackIds);
  assert.deepEqual(sanitized.storyIds, raw.storyIds);

  // Reading stored media must preserve every accepted field.
  const [reread] = mergeMedia([sanitized], [], now);
  const result = reread[0];

  for (const key of [
    'dash', 'audioUrl', 'thumbUrl', 'width', 'height', 'durationSec', 'trackIds', 'storyIds',
  ] as const) {
    assert.deepEqual(result[key], sanitized[key], `${key} must survive the getMedia-style re-merge unchanged`);
  }
});

test('normalizeMediaCandidate threads allowHistorical correctly for both mergeMedia sides after consolidation', () => {
  const now = 1_800_000_000_000;
  const historical = now - 30 * 24 * 60 * 60 * 1000; // Outside the ten-minute freshness window.

  // Preserve a persisted timestamp during a no-op merge.
  const stored = item({ id: mediaId(URL), addedAt: historical });
  const [merged] = mergeMedia([stored], [], now);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].addedAt, historical, 'an existing stored row keeps its historical addedAt');

  // Clamp stale timestamps on newly received items.
  const sanitized = sanitizeIncomingItems([item({ addedAt: historical })], Number.POSITIVE_INFINITY, now)[0];
  assert.equal(sanitized.addedAt, now, 'a fresh incoming item never keeps a historical addedAt');

  // Apply the same clamp on the incoming side of a merge.
  const [mergedIncoming] = mergeMedia([], [item({ addedAt: historical })], now);
  assert.equal(mergedIncoming.length, 1);
  assert.equal(mergedIncoming[0].addedAt, now, 'a fresh item merged directly via mergeMedia is clamped the same way');
});

// Cross-file invariants

test('widenDashUrl and classifyNetworkRequest share one DASH byte-range param source', () => {
  const segment = `${URL}?bytestart=100&byteend=199&oh=a&oe=1`;
  const widened = widenDashUrl(segment);

  assert.ok(!/[?&](bytestart|byteend)=/.test(widened), 'byte-range params are stripped');
  assert.ok(widened.includes('oh=a') && widened.includes('oe=1'), 'unrelated params survive widening');
  assert.equal(widenDashUrl(URL), URL, 'a URL with neither param is returned unchanged');

  const classified = classifyNetworkRequest(segment, 1_800_000_000_000);
  assert.equal(classified?.dash, true, 'a byte-range request is classified as a DASH segment');
  const progressive = classifyNetworkRequest(URL, 1_800_000_000_000);
  assert.equal(progressive?.dash, false, 'a plain request is not misclassified as DASH');
});

test('NUMERIC_MEDIA_ID exports serve both the anchored whole-string check and an embedded-pattern use', () => {
  assert.equal(isNumericMediaId('123456'), true);
  assert.equal(isNumericMediaId('1234'), false, 'below the 5-digit floor');
  assert.equal(isNumericMediaId('1'.repeat(21)), false, 'above the 20-digit ceiling');
  assert.equal(isNumericMediaId('123abc'), false, 'not purely numeric');
  assert.equal(NUMERIC_MEDIA_ID_RE.test('123456'), true);

  // Preserve matching behavior when the source is embedded in a larger pattern.
  const embedded = new RegExp(`/reel/(${NUMERIC_MEDIA_ID_SOURCE})(?=[/?#]|$)`);
  const match = '/reel/9876543210'.match(embedded);
  assert.equal(match?.[1], '9876543210');
  assert.equal('/reel/12'.match(embedded), null, 'the embedded pattern keeps the same 5-digit floor');
});
