import assert from 'node:assert/strict';
import test from 'node:test';

import { legacyMediaId, mediaId, mergeMedia, sanitizeIncomingItems } from '../src/shared/media';

// --- C6b repair: mediaId's OWN branches must be bounded too, not only
// genericEndpointId's ------------------------------------------------------
//
// repair-c6-generic-endpoint-path-bound.test.ts (round 2) bounded all three
// branches INSIDE genericEndpointId via what was then boundGenericEndpointId.
// An adversarial review found mediaId() has TWO MORE return branches that
// never call into genericEndpointId at all, so round 2's fix never touched
// them:
//
//   - the `simpleVideo` branch (a strict `/v/t42/<name>.mp4`, no extra
//     slash): `return `video-${simpleVideo[1]}...`` embeds the captured
//     filename with no length cap of its own.
//   - the final "real CDN object" fallback — reached either by a `/v/` path
//     that does NOT match the strict simpleVideo shape, or by ANY path
//     (inside or outside `/v/`) that matches KNOWN_MEDIA_EXTENSION_RE:
//     `return `asset:${path}...`` embeds the whole `path` with no cap.
//
// Verified end-to-end through sanitizeIncomingItems (the real untrusted
// page-message channel) against the code as it stood before this repair: a
// 7506-char id and two ~7520-char ids were all accepted and returned as
// MediaItem.id — 27x past the 256-char contract documented at media.ts's
// MEDIA_ID_MAX_LEN (id.length <= ID_BOUND below).
//
// The repair does not add a third per-branch call (the pattern that missed a
// sibling branch twice already). It bounds the WHOLE candidate ONCE, at the
// single point every id leaves mediaId(): mediaIdCandidate() computes the
// raw, unbounded value exactly as the old mediaId() body did, and the new
// public mediaId() wraps it with boundMediaId() before returning.
const ID_BOUND = 256;

test('C6b repair: the simpleVideo branch bounds an over-long captured filename (reviewer repro #1)', () => {
  const now = 1_800_000_000_000;
  const url = 'https://video.xx.fbcdn.net/v/t42/' + 'a'.repeat(7500) + '.mp4';

  const bare = mediaId(url);
  assert.ok(bare.length <= ID_BOUND, `bare mediaId() must fit the bound, got ${bare.length}`);

  const sanitized = sanitizeIncomingItems(
    [{ url, kind: 'video', source: 'reel', origin: 'graphql', addedAt: now }],
    Number.POSITIVE_INFINITY,
    now,
  );
  assert.equal(sanitized.length, 1, 'a well-formed fbcdn item must still be accepted');
  assert.ok(
    sanitized[0].id.length <= ID_BOUND,
    `id must fit the shared 256-char id contract, got ${sanitized[0].id.length}`,
  );
  assert.equal(sanitized[0].id, bare, 'sanitizeIncomingItems must key off the same mediaId()');

  // mergeMedia re-derives the id from the URL on every merge; it must not
  // regenerate a different (or unbounded) id on re-merge.
  const [merged] = mergeMedia([], sanitized, now);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, sanitized[0].id, 're-merging must not change the bounded id');
});

test('C6b repair: the final asset: fallback bounds an over-long /v/ path that does not match simpleVideo (reviewer repro #2)', () => {
  const now = 1_800_000_000_000;
  // /v/-prefixed, but the extra `/sub/` segment means this can never match
  // simpleVideo's strict `^\/v\/t42\/([^/]+)\.mp4$` pattern — it falls
  // through to the final "real CDN object" branch instead.
  const url = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/sub/' + 'b'.repeat(7500) + '.mp4';

  const bare = mediaId(url);
  assert.ok(bare.length <= ID_BOUND, `bare mediaId() must fit the bound, got ${bare.length}`);

  const sanitized = sanitizeIncomingItems(
    [{ url, kind: 'video', source: 'reel', origin: 'graphql', addedAt: now }],
    Number.POSITIVE_INFINITY,
    now,
  );
  assert.equal(sanitized.length, 1, 'a well-formed fbcdn item must still be accepted');
  assert.ok(sanitized[0].id.length <= ID_BOUND, `got ${sanitized[0].id.length}`);

  const [merged] = mergeMedia([], sanitized, now);
  assert.equal(merged[0].id, sanitized[0].id, 're-merging must not change the bounded id');
});

test('C6b repair: the final asset: fallback bounds an over-long path OUTSIDE /v/ with a known media extension (reviewer repro #3)', () => {
  const now = 1_800_000_000_000;
  // No /v/ prefix anywhere — this reaches the final fallback purely because
  // the path ends in a KNOWN_MEDIA_EXTENSION_RE extension (.jpg).
  const url = 'https://scontent.xx.fbcdn.net/notv/' + 'c'.repeat(7500) + '.jpg';

  const bare = mediaId(url);
  assert.ok(bare.length <= ID_BOUND, `bare mediaId() must fit the bound, got ${bare.length}`);

  const sanitized = sanitizeIncomingItems(
    [{ url, kind: 'image', source: 'story', origin: 'graphql', addedAt: now }],
    Number.POSITIVE_INFINITY,
    now,
  );
  assert.equal(sanitized.length, 1, 'a well-formed fbcdn item must still be accepted');
  assert.ok(sanitized[0].id.length <= ID_BOUND, `got ${sanitized[0].id.length}`);

  const [merged] = mergeMedia([], sanitized, now);
  assert.equal(merged[0].id, sanitized[0].id, 're-merging must not change the bounded id');
});

test('C6b repair: two different overlong simpleVideo filenames never collide into the same bounded id', () => {
  const idA = mediaId('https://video.xx.fbcdn.net/v/t42/' + 'a'.repeat(7500) + '.mp4');
  const idB = mediaId('https://video.xx.fbcdn.net/v/t42/' + 'x'.repeat(7500) + '.mp4');
  assert.ok(idA.length <= ID_BOUND && idB.length <= ID_BOUND);
  assert.notEqual(idA, idB, 'two distinct overlong resources must not be grouped under one id');
  assert.equal(
    mediaId('https://video.xx.fbcdn.net/v/t42/' + 'a'.repeat(7500) + '.mp4'),
    idA,
    'the same overlong URL must hash to a stable id across calls',
  );
});

test('C6b repair: two different overlong final-asset: paths never collide into the same bounded id', () => {
  const idA = mediaId('https://scontent.xx.fbcdn.net/v/t39.30808-6/sub/' + 'b'.repeat(7500) + '.mp4');
  const idB = mediaId('https://scontent.xx.fbcdn.net/v/t39.30808-6/sub/' + 'y'.repeat(7500) + '.mp4');
  assert.ok(idA.length <= ID_BOUND && idB.length <= ID_BOUND);
  assert.notEqual(idA, idB, 'two distinct overlong resources must not be grouped under one id');
});

// --- Stability half: every URL shape that already produced a short id keeps
// producing THE SAME id, byte for byte. These literal expected values were
// captured directly from mediaId()/legacyMediaId() BEFORE this repair — they
// are not invented, they are what the pre-repair code actually returned — so
// a fix that re-hashes an already-short id (rather than only bounding the
// overflowing ones) fails these. ---------------------------------------

test('C6b repair: short simpleVideo URLs keep their exact prior id (stability)', () => {
  assert.equal(
    mediaId('https://video.xx.fbcdn.net/v/t42/abc123.mp4'),
    'video-abc123',
    'a URL whose id already fits must be returned byte-for-byte unchanged',
  );
  assert.equal(
    mediaId('https://video.xx.fbcdn.net/v/t42/abc123.mp4?tag=hd_720p&oh=1&oe=2'),
    'video-abc123?tag=hd_720p',
  );
});

test('C6b repair: short final asset: URLs keep their exact prior id (stability)', () => {
  // The module's own baseline fixture URL, reused across media.test.ts's
  // `URL` constant — every test asserting equality against mediaId(URL)
  // depends on this exact value never moving.
  assert.equal(
    mediaId('https://video.xx.fbcdn.net/v/t42.1790-2/12345678901234567_n.mp4'),
    'asset:/v/t42.1790-2/12345678901234567_n.mp4',
  );
  // Non-/v/ known-extension shape (audio).
  assert.equal(
    mediaId('https://cdn.xx.fbcdn.net/o1/clip.aac?oh=sig-a&oe=1'),
    'asset:/o1/clip.aac',
  );
  // /v/ shape that fails simpleVideo (an extra path segment) but carries a tag.
  assert.equal(
    mediaId('https://video.xx.fbcdn.net/v/t42/12345678901234567/video-720.mp4?tag=x'),
    'asset:/v/t42/12345678901234567/video-720.mp4?tag=x',
  );
});

// --- legacyMediaId: the same unbounded-URL-input shape, called out
// explicitly as another id producer in this file that needs the same
// treatment. Not a MediaItem.id itself, but matchesActiveMediaId and
// sidepanel.ts's legacy-alias re-linking both key off it, so it shares the
// same "attacker controls an unbounded pathname/digit run" flaw. -----------

test('C6b repair: legacyMediaId bounds an over-long numeric run', () => {
  const url = 'https://video.xx.fbcdn.net/v/t1.0-9/' + '9'.repeat(7000) + '_n.jpg';
  const id = legacyMediaId(url);
  assert.ok(id != null, 'a well-formed fbcdn URL must still resolve to a legacy id');
  assert.ok(id.length <= ID_BOUND, `got ${id.length}`);
});

test('C6b repair: legacyMediaId bounds an over-long pathname with no qualifying digit run', () => {
  const url = 'https://video.xx.fbcdn.net/v/t1.0-9/' + 'z'.repeat(7000) + '_n.jpg';
  const id = legacyMediaId(url);
  assert.ok(id != null);
  assert.ok(id.length <= ID_BOUND, `got ${id.length}`);
});

test('C6b repair: two different overlong legacyMediaId inputs never collide into the same bounded id', () => {
  const idA = legacyMediaId('https://video.xx.fbcdn.net/v/t1.0-9/' + '9'.repeat(7000) + '_n.jpg');
  const idB = legacyMediaId('https://video.xx.fbcdn.net/v/t1.0-9/' + '8'.repeat(7000) + '_n.jpg');
  assert.ok(idA != null && idB != null);
  assert.notEqual(idA, idB);
});

test('C6b repair: legacyMediaId keeps its exact prior id for short URLs (stability)', () => {
  assert.equal(
    legacyMediaId('https://video.xx.fbcdn.net/v/t42.1790-2/12345678901234567_n.mp4'),
    'fb:12345678901234567',
  );
  assert.equal(
    legacyMediaId('https://video.xx.fbcdn.net/v/t1.0-9/nodigits_n.jpg'),
    'path:/v/t1.0-9/nodigits_n.jpg',
  );
});

// --- genericEndpointId's nested-url branch recurses into the raw candidate
// computation (not the public mediaId) precisely so that a pathologically
// long NESTED url can never change the hash embedded in an already-bounded
// OUTER id. Locks in that design choice. ------------------------------

test('C6b repair: a safe_image.php proxy wrapping an ordinary nested fbcdn URL keeps its exact prior id (stability)', () => {
  const nested =
    'https://scontent-a.xx.fbcdn.net/v/t39.30808-6/photo-123_n.jpg?stp=dst-jpg_p590x443&oh=nested-a&oe=1';
  const proxy = `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(nested)}&oh=outer-a`;
  assert.equal(mediaId(proxy), 'asset:/safe_image.php?resource=d4c2a87dc8370907');
});

test('C6b repair: a safe_image.php proxy wrapping a pathologically long nested URL still bounds the outer id', () => {
  const nested = 'https://video.xx.fbcdn.net/v/t42/' + 'p'.repeat(7500) + '.mp4';
  const proxy = `https://external.xx.fbcdn.net/safe_image.php?url=${encodeURIComponent(nested)}&oh=outer-b`;
  const id = mediaId(proxy);
  assert.ok(id.length <= ID_BOUND, `got ${id.length}`);
});
