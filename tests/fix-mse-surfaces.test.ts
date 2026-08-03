// Verify MSE classification and merge decisions that do not require a browser environment.

import assert from 'node:assert/strict';
import test from 'node:test';

import { coverSharesVideoCard, discardPlaceholderCoverEvidence } from '../src/shared/centre-video';
import { fromPrefetchReps } from '../src/shared/dash';
import { makeItem, mergeMedia, resolutionOf, type MediaItem } from '../src/shared/media';

/** A minimal element tree: `contains` and `parentElement` are all the rule needs. */
function tree() {
  const node = (id: string, parent?: Node_) => {
    const self: Node_ = { id, parent, kids: [] };
    parent?.kids.push(self);
    return self;
  };
  interface Node_ {
    id: string;
    parent?: Node_;
    kids: Node_[];
  }
  const contains = (ancestor: unknown, target: unknown): boolean => {
    const a = ancestor as Node_;
    if (a === target) return true;
    return a.kids.some((kid) => contains(kid, target));
  };
  const parentOf = (n: unknown): unknown => (n as Node_).parent;
  return { node, contains, parentOf };
}

test('the slide own poster is kept; another card leftover placeholder is not', () => {
  // The viewer sets pointer-events:none on its <video>, so hit-testing the centre returns
  // the poster BEHIND it and never the video — which then arrives through the fallback scan
  // wearing the exact signature a stale placeholder produces. Telling them apart is what
  // decides whether an MSE video has any id at all: its blob: currentSrc never becomes one.
  const { node, contains } = tree();
  const page = node('page');
  const card = node('card', page);
  const poster = node('poster', card);
  const otherCard = node('other-card', page);
  const stalePlaceholder = node('stale', otherCard);
  const deepPoster = node('deep-poster', node('wrapper', card));

  assert.equal(
    coverSharesVideoCard({ parentElement: card }, poster, contains),
    true,
    "the playing slide's own poster is its video's sibling and must survive",
  );
  assert.equal(
    coverSharesVideoCard({ parentElement: card }, deepPoster, contains),
    true,
    'nested inside the same card still counts',
  );
  assert.equal(
    coverSharesVideoCard({ parentElement: card }, stalePlaceholder, contains),
    false,
    'a placeholder from another card must still be discarded',
  );
  // Do not walk above the card: `page` contains every card and would create false matches.
  assert.equal(
    coverSharesVideoCard({ parentElement: page }, stalePlaceholder, contains),
    true,
    'a shared root does contain it — which is exactly why only the parent is asked',
  );
  assert.equal(coverSharesVideoCard(null, poster, contains), false);
  assert.equal(coverSharesVideoCard({ parentElement: card }, null, contains), false);
});

test('discarding placeholder evidence is a no-op for a cover on the same card', () => {
  const ids = new Set(['cover-id', 'other-id']);
  const covers = ['https://example.invalid/cover.jpg'];
  discardPlaceholderCoverEvidence(ids, covers, ['cover-id'], true);
  assert.deepEqual([...ids], ['cover-id', 'other-id'], 'the id that names the video must not be dropped');
  assert.equal(covers.length, 1);

  // And still wipes it when the cover belongs to another card.
  discardPlaceholderCoverEvidence(ids, covers, ['cover-id'], false);
  assert.deepEqual([...ids], ['other-id']);
  assert.equal(covers.length, 0);
});

test('an audio representation is read from its codecs, not from its container mime', () => {
  // Prefer codecs over the MP4 container MIME so audio-only tracks remain linkable
  // as audio and never appear as video qualities.
  const pairs = fromPrefetchReps([
    {
      representations: [
        {
          base_url: 'https://video.xx.fbcdn.net/v/t2/hd.mp4',
          mime_type: 'video/mp4',
          codecs: 'avc1.640028',
          width: 1080,
          height: 1920,
          bandwidth: 2_400_000,
        },
        {
          base_url: 'https://video.xx.fbcdn.net/v/t2/aud.mp4',
          mime_type: 'video/mp4', // the misdeclaration
          codecs: 'mp4a.40.2',
          bandwidth: 128_000,
        },
      ],
    },
  ]);
  assert.equal(pairs.length, 1, 'the audio representation must not become a second video rung');
  assert.equal(pairs[0]!.videoUrl, 'https://video.xx.fbcdn.net/v/t2/hd.mp4');
  assert.equal(pairs[0]!.audioUrl, 'https://video.xx.fbcdn.net/v/t2/aud.mp4', 'the rung must get its sound');
  assert.equal(pairs[0]!.width, 1080);
  assert.equal(pairs[0]!.height, 1920);

  // A muxed representation naming both codecs is still video — the video codec leads.
  const muxed = fromPrefetchReps([
    {
      representations: [
        {
          base_url: 'https://video.xx.fbcdn.net/v/t2/both.mp4',
          mime_type: 'video/mp4',
          codecs: 'avc1.4d401f,mp4a.40.2',
          height: 720,
          bandwidth: 900_000,
        },
      ],
    },
  ]);
  assert.equal(muxed.length, 1);
  assert.equal(muxed[0]!.videoUrl, 'https://video.xx.fbcdn.net/v/t2/both.mp4');
});

test('an audio track whose only audio signal is its encode tag is not offered as a video', () => {
  // Facebook names each DASH track's encode in the URL's efg, and the raw-text recovery path
  // reaches representations with no codecs field at all. There the tag is the only evidence.
  const efg = (tag: string) =>
    Buffer.from(JSON.stringify({ xpv_asset_id: '9001', vencode_tag: tag })).toString('base64url');
  const audio = makeItem(`https://video.xx.fbcdn.net/v/t2/a.mp4?efg=${efg('dash.audio')}`, 'video', 'reel', 'graphql', 1);
  assert.equal(audio.kind, 'audio', 'an audio encode tag must override the capture hint');

  for (const tag of ['dash.720.video', 'dash.1080.video', 'vp9.480.video']) {
    const video = makeItem(`https://video.xx.fbcdn.net/v/t2/v.mp4?efg=${efg(tag)}`, 'video', 'reel', 'graphql', 1);
    assert.equal(video.kind, 'video', `${tag} must stay a video`);
  }
});

test('a rung is named by its short edge, so one ladder ranks on one scale', () => {
  // Use the portrait short edge so every rung follows the same resolution scale.
  assert.deepEqual(resolutionOf({ url: 'https://video.xx.fbcdn.net/a.mp4', width: 1080, height: 1920 }), {
    label: '1080p',
    rank: 1080,
  });
  assert.deepEqual(resolutionOf({ url: 'https://video.xx.fbcdn.net/a.mp4', width: 720, height: 1280 }), {
    label: '720p',
    rank: 720,
  });
  // Landscape is unchanged: the short edge IS the height there.
  assert.deepEqual(resolutionOf({ url: 'https://video.xx.fbcdn.net/a.mp4', width: 1920, height: 1080 }), {
    label: '1080p',
    rank: 1080,
  });
  // Without a width, fall back to height.
  assert.deepEqual(resolutionOf({ url: 'https://video.xx.fbcdn.net/a.mp4', height: 720 }), {
    label: '720p',
    rank: 720,
  });
  // And an explicit progressive tag still wins over both.
  assert.equal(resolutionOf({ url: 'https://video.xx.fbcdn.net/a.mp4?tag=sve_540p', width: 9, height: 9 }).label, '540p');
});

test('a capture with dimensions enriches one that has none', () => {
  // Merge later dimensions into an otherwise identical dimensionless capture.
  const base: MediaItem = {
    id: 'x',
    url: 'https://video.xx.fbcdn.net/v/t2/x.mp4',
    kind: 'video',
    source: 'reel',
    origin: 'network',
    dash: true,
    addedAt: 1,
  };
  const [merged] = mergeMedia([base], [{ ...base, origin: 'graphql', width: 720, height: 1280 }], 2);
  assert.equal(merged[0]!.width, 720);
  assert.equal(merged[0]!.height, 1280);
  assert.equal(resolutionOf(merged[0]!).label, '720p');

  // A measurement already present is never overwritten by a later one.
  const [kept] = mergeMedia(
    [{ ...base, width: 1080, height: 1920 }],
    [{ ...base, origin: 'graphql', width: 360, height: 640 }],
    3,
  );
  assert.equal(kept[0]!.width, 1080);
  assert.equal(kept[0]!.height, 1920);
});
