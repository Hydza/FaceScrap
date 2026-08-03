import assert from 'node:assert/strict';
import test from 'node:test';

import { graphqlImageCandidate } from '../src/shared/graphql-media';
import { MIN_MEDIA_DIMENSION_PX } from '../src/shared/media';

test('graphqlImageCandidate floor behaviour tracks MIN_MEDIA_DIMENSION_PX exactly, at the real boundary', () => {
  const IMAGE = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/x.jpg';
  assert.equal(
    graphqlImageCandidate({ uri: IMAGE, width: MIN_MEDIA_DIMENSION_PX - 1, height: 500 }, false),
    undefined,
    'one pixel below the shared floor must still be rejected',
  );
  assert.deepEqual(
    graphqlImageCandidate({ uri: IMAGE, width: MIN_MEDIA_DIMENSION_PX, height: 500 }, false),
    { url: IMAGE, width: MIN_MEDIA_DIMENSION_PX, height: 500 },
    'exactly at the shared floor must still be accepted',
  );
});
