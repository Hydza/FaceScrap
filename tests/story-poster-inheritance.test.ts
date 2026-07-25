// Story videos rendered as blank cards in the side panel: no thumbUrl was ever
// captured for them.
//
// The three poster paths all failed on /stories/:
//   1. DOM <video>.poster — the story player is MSE, so the element carries no
//      src and no poster attribute at all (measured: src "", poster null).
//   2. The on-screen cover hit-test (content.ts's fbcdnCoverUrl) — measured on a
//      live story viewer, the document contains ZERO <img> of >=160x160, and the
//      element stack under the viewport centre is layout DIVs with no
//      background-image. There is no fbcdn cover in the DOM to find.
//   3. GraphQL findThumb — the payload DOES carry the poster, at
//      ...unified_stories_with_notes.edges[].node.attachments[].media.preferred_thumbnail.image.uri
//      (and .previewImage.uri / .image.uri), all of which are already in
//      THUMB_KEYS. But findThumb is asked about the node that EMITS the DASH
//      pair, and in the Stories viewer the ladder hangs off a CHILD of `media`,
//      not off `media` itself — so the node that has the video has no poster and
//      the node that has the poster emits no video.
//
// Fix: carry the poster DOWN the walk, exactly as harvest already carries the
// story id. Nearest ancestor wins, and the recursion's own scoping keeps a
// sibling attachment from ever seeing this one's cover.
//
// Inheritance is strictly downward, which also bounds what it can reach: the
// card-level story_card_info.story_thumbnail is a SIBLING of attachments, not an
// ancestor of them, so it is deliberately NOT a fallback here. Every payload
// measured carried a poster on the attachment's own media node, so there is no
// observed case that needs it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const hook = readFileSync(join(ROOT, 'src', 'content', 'page-hook.ts'), 'utf8');

// --- MODEL: harvest's walk, with and without poster inheritance -------------

const THUMB_KEYS = ['preferred_thumbnail', 'image', 'previewImage'];

function modelFindThumb(rec: Record<string, unknown>): string | undefined {
  for (const key of THUMB_KEYS) {
    const v = rec[key];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.uri === 'string') return o.uri;
      const img = o.image as Record<string, unknown> | undefined;
      if (img && typeof img.uri === 'string') return img.uri;
    }
  }
  return undefined;
}

/** Walk a payload the way harvest does. `inherit` toggles the fix. */
function modelHarvest(
  obj: unknown,
  inherit: boolean,
  found: { url: string; thumb?: string }[] = [],
  inheritedThumb?: string,
): { url: string; thumb?: string }[] {
  if (obj == null || typeof obj !== 'object') return found;
  if (Array.isArray(obj)) {
    for (const v of obj) modelHarvest(v, inherit, found, inheritedThumb);
    return found;
  }
  const rec = obj as Record<string, unknown>;
  const thumb = inherit ? (modelFindThumb(rec) ?? inheritedThumb) : modelFindThumb(rec);

  // harvestDash: the node that carries the DASH ladder emits the video item.
  const reps = rec.all_video_dash_prefetch_representations;
  if (Array.isArray(reps)) {
    for (const rep of reps) {
      const url = (rep as Record<string, unknown>).base_url;
      if (typeof url === 'string') found.push({ url, thumb });
    }
  }

  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') modelHarvest(v, inherit, found, thumb);
  }
  return found;
}

// The measured shape of a Stories-viewer GraphQL node: the poster sits on
// `media`, the DASH ladder on a child of it.
const STORY_PAYLOAD = {
  data: {
    bucket: {
      unified_stories_with_notes: {
        edges: [
          {
            node: {
              story_card_info: { story_thumbnail: { uri: 'https://scontent.xx.fbcdn.net/card-cover.jpg' } },
              attachments: [
                {
                  media: {
                    preferred_thumbnail: { image: { uri: 'https://scontent.xx.fbcdn.net/real-poster.jpg' } },
                    previewImage: { uri: 'https://scontent.xx.fbcdn.net/preview.jpg' },
                    videoDeliveryLegacyFields: {
                      all_video_dash_prefetch_representations: [
                        { base_url: 'https://video.xx.fbcdn.net/v/t42/story-video.mp4' },
                      ],
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
  },
};

test('MODEL: without inheritance the story video gets no poster — the reported bug', () => {
  const found = modelHarvest(STORY_PAYLOAD, false);
  assert.equal(found.length, 1, 'the story video must be captured either way');
  assert.equal(found[0]?.thumb, undefined, 'reproduces the blank card: no thumbUrl');
});

test('MODEL: inheriting the poster down the walk gives the story video its cover', () => {
  const found = modelHarvest(STORY_PAYLOAD, true);
  assert.equal(found.length, 1);
  assert.equal(
    found[0]?.thumb,
    'https://scontent.xx.fbcdn.net/real-poster.jpg',
    'preferred_thumbnail outranks previewImage, and the sibling card cover is not a candidate',
  );
});

test('MODEL: a sibling attachment never inherits the other attachment\'s cover', () => {
  const twoAttachments = {
    node: {
      attachments: [
        {
          media: {
            preferred_thumbnail: { image: { uri: 'https://scontent.xx.fbcdn.net/poster-A.jpg' } },
            videoDeliveryLegacyFields: {
              all_video_dash_prefetch_representations: [{ base_url: 'https://video.xx.fbcdn.net/v/t42/A.mp4' }],
            },
          },
        },
        {
          media: {
            preferred_thumbnail: { image: { uri: 'https://scontent.xx.fbcdn.net/poster-B.jpg' } },
            videoDeliveryLegacyFields: {
              all_video_dash_prefetch_representations: [{ base_url: 'https://video.xx.fbcdn.net/v/t42/B.mp4' }],
            },
          },
        },
      ],
    },
  };

  const found = modelHarvest(twoAttachments, true);
  assert.equal(found.length, 2);
  assert.equal(found.find((f) => f.url.endsWith('A.mp4'))?.thumb, 'https://scontent.xx.fbcdn.net/poster-A.jpg');
  assert.equal(found.find((f) => f.url.endsWith('B.mp4'))?.thumb, 'https://scontent.xx.fbcdn.net/poster-B.jpg');
});

// --- SOURCE: the real file must actually do what the model models ----------

test('harvest threads an inherited poster through the walk', () => {
  assert.match(
    hook,
    /inheritedStoryId\?: string,\s*\n\s*inheritedThumb\?: string,/,
    'harvest must accept an inheritedThumb parameter',
  );
  assert.match(
    hook,
    /const thumb = findThumb\(rec\) \?\? inheritedThumb;/,
    'harvest must prefer this node\'s own poster and fall back to the inherited one',
  );
  assert.match(
    hook,
    /harvestDash\(rec, source, out, now, storyId, thumb\);/,
    'the resolved poster must reach harvestDash, which emits the DASH pairs',
  );
  assert.match(
    hook,
    /harvest\(\s*v,\s*source,\s*out,\s*now,\s*depth \+ 1,\s*childStoryId,\s*thumb,\s*\);/,
    'the resolved poster must be carried into child nodes',
  );
  assert.match(
    hook,
    /harvest\(v, source, out, now, depth \+ 1, inheritedStoryId, inheritedThumb\);/,
    'the array branch must carry the inherited poster too, or it is lost crossing every edges[] list',
  );
});

test('harvestDash takes the poster as a parameter instead of resolving it itself', () => {
  assert.match(
    hook,
    /function harvestDash\([\s\S]{0,220}?storyId\?: string,\s*\n\s*poster\?: string,\s*\n\): void \{/,
    'harvestDash must receive the poster rather than calling findThumb on the DASH node',
  );
  assert.doesNotMatch(
    hook,
    /thumb = findThumb\(rec\);\s*\n\s*thumbDone = true;/,
    'the old lazy self-resolution must be gone — it looked at the wrong node',
  );
});

