import assert from 'node:assert/strict';
import test from 'node:test';

import {
  graphqlImageCandidate,
  graphqlVideoUrl,
} from '../src/shared/graphql-media';

const VIDEO = 'https://video.xx.fbcdn.net/v/t42/current.mp4?token=one';
const IMAGE = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/current.jpg?token=one';

test('extracts a direct or object-shaped fbcdn video value under a trusted video key', () => {
  assert.equal(graphqlVideoUrl(VIDEO), VIDEO);
  assert.equal(graphqlVideoUrl({ uri: VIDEO }), VIDEO);
  assert.equal(graphqlVideoUrl({ url: VIDEO }), VIDEO);
  assert.equal(graphqlVideoUrl({ src: VIDEO }), VIDEO);
});

test('rejects untrusted and deeply nested video values', () => {
  assert.equal(graphqlVideoUrl('https://evil.example/current.mp4'), undefined);
  assert.equal(graphqlVideoUrl({ uri: 'https://evil.example/current.mp4' }), undefined);
  assert.equal(graphqlVideoUrl({ payload: { uri: VIDEO } }), undefined);
});

test('normalizes numeric-string image dimensions from GraphQL', () => {
  assert.deepEqual(
    graphqlImageCandidate({ uri: IMAGE, width: '944', height: '1088' }, false),
    { url: IMAGE, width: 944, height: 1088 },
  );
  assert.deepEqual(
    graphqlImageCandidate({ uri: IMAGE, width: null, height: 1088 }, false),
    { url: IMAGE, height: 1088 },
  );
});

test('accepts a dimensionless image only inside a verified Story media branch', () => {
  assert.equal(graphqlImageCandidate({ uri: IMAGE }, false), undefined);
  assert.deepEqual(graphqlImageCandidate({ uri: IMAGE }, true), { url: IMAGE });
});

test('rejects small crops, invalid dimensions, profile pictures, and video containers', () => {
  const profile = 'https://scontent.xx.fbcdn.net/v/t1.6435-1/profile.jpg';
  for (const value of [
    { uri: IMAGE, width: 120, height: 120 },
    { uri: IMAGE, width: -1, height: 1088 },
    { uri: IMAGE, width: 944, height: 100_001 },
    { uri: profile, width: 944, height: 1088 },
    { uri: VIDEO, width: 944, height: 1088 },
  ]) {
    assert.equal(graphqlImageCandidate(value, true), undefined);
  }
});
