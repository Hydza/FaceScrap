import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractPrefetchPairs,
  extractStringsByKey,
  extractUrlsByKey,
  MPD_STRING_KEYS,
  VIDEO_KEYS,
} from '../src/shared/dash';

const EXPECTED_VIDEO_KEYS = [
  'playable_url',
  'playable_url_quality_hd',
  'playable_url_quality_sd',
  'browser_native_hd_url',
  'browser_native_sd_url',
  'progressive_url',
  'hd_src',
  'sd_src',
] as const;

const EXPECTED_MPD_KEYS = [
  'dash_manifest',
  'dash_manifest_xml',
  'dash_manifest_xml_string',
  'manifest_xml',
  'playlist',
] as const;

test('exports the complete progressive-video and MPD capture-key inventory', () => {
  assert.deepEqual(VIDEO_KEYS, EXPECTED_VIDEO_KEYS);
  assert.deepEqual(MPD_STRING_KEYS, EXPECTED_MPD_KEYS);
});

test('extractUrlsByKey covers every structured video key and decodes JSON strings', () => {
  const expected = EXPECTED_VIDEO_KEYS.map((_, i) => `https://video.xx.fbcdn.net/v/${i}.mp4?x=1&y=2`);
  const body = JSON.stringify({
    ...Object.fromEntries(EXPECTED_VIDEO_KEYS.map((key, i) => [key, expected[i]])),
    unknown_video_key: 'https://video.xx.fbcdn.net/v/not-captured.mp4',
    hd_src_backup: 'https://video.xx.fbcdn.net/v/not-captured-either.mp4',
  }).replaceAll('/', '\\/').replaceAll('&', '\\u0026');

  assert.deepEqual(extractUrlsByKey(body), expected);
});

test('extractUrlsByKey rejects a non-fbcdn value even under an allowed key', () => {
  const body = JSON.stringify({
    playable_url: 'https://evil.example/video.mp4',
    sd_src: 'https://video.xx.fbcdn.net/v/safe.mp4',
  });

  assert.deepEqual(extractUrlsByKey(body), ['https://video.xx.fbcdn.net/v/safe.mp4']);
});

test('extractUrlsByKey recovers direct URL fields inside a bounded object value', () => {
  const objectVideo = 'https://video.xx.fbcdn.net/v/object-shaped.mp4?x=1&y=2';
  const body = JSON.stringify({
    playable_url: { uri: objectVideo },
    playable_url_quality_hd: { url: 'https://evil.example/not-captured.mp4' },
  }).replaceAll('/', '\\/').replaceAll('&', '\\u0026');

  assert.deepEqual(extractUrlsByKey(body), [objectVideo]);
});

test('extractUrlsByKey ignores nested metadata before a direct object URL', () => {
  const nestedThumbnail = 'https://scontent.xx.fbcdn.net/v/t39/nested-thumbnail.jpg';
  const directVideo = 'https://video.xx.fbcdn.net/v/direct-after-nested.mp4';
  const body = JSON.stringify({
    playable_url: {
      metadata: { url: nestedThumbnail },
      uri: directVideo,
    },
  });

  assert.deepEqual(extractUrlsByKey(body), [directVideo]);
});

test('extractUrlsByKey never promotes a nested-only image from a video field', () => {
  const body = JSON.stringify({
    playable_url: {
      metadata: {
        url: 'https://scontent.xx.fbcdn.net/v/t39/nested-only-thumbnail.jpg',
      },
    },
  });

  assert.deepEqual(extractUrlsByKey(body), []);
});

test('extractStringsByKey covers every MPD key and preserves escaped content', () => {
  const expected = EXPECTED_MPD_KEYS.map((key, i) => `<MPD id="${key}-${i}">\\path</MPD>`);
  const body = JSON.stringify(Object.fromEntries(EXPECTED_MPD_KEYS.map((key, i) => [key, expected[i]])));

  assert.deepEqual(extractStringsByKey(body), expected);
});

function ladder(id: string): unknown[] {
  return [
    {
      label: `quality ] "${id}"`,
      representations: [
        {
          base_url: `https://video.xx.fbcdn.net/v/${id}.mp4`,
          mime_type: 'video/mp4',
          codecs: 'avc1.640028',
          bandwidth: 2_000_000,
          height: 1080,
        },
        {
          base_url: `https://audio.xx.fbcdn.net/v/${id}.m4a`,
          mime_type: 'audio/mp4',
          codecs: 'mp4a.40.2',
          bandwidth: 128_000,
        },
      ],
    },
  ];
}

test('extractPrefetchPairs balances nested arrays and ignores brackets inside escaped strings', () => {
  const text = JSON.stringify({ all_video_dash_prefetch_representations: ladder('one') });

  const pairs = extractPrefetchPairs(text);

  assert.equal(pairs.length, 1);
  assert.equal(pairs[0]?.videoUrl, 'https://video.xx.fbcdn.net/v/one.mp4');
  assert.equal(pairs[0]?.audioUrl, 'https://audio.xx.fbcdn.net/v/one.m4a');
  assert.equal(pairs[0]?.height, 1080);
});

test('extractPrefetchPairs recovers multiple occurrences from one raw response', () => {
  const text = [
    JSON.stringify({ all_video_dash_prefetch_representations: ladder('first') }),
    JSON.stringify({ nested: { all_video_dash_prefetch_representations: ladder('second') } }),
  ].join('\n');

  assert.deepEqual(
    extractPrefetchPairs(text).map((pair) => pair.videoUrl),
    ['https://video.xx.fbcdn.net/v/first.mp4', 'https://video.xx.fbcdn.net/v/second.mp4'],
  );
});

test('extractPrefetchPairs returns safely when an array is truncated', () => {
  const text =
    '{"all_video_dash_prefetch_representations":[{"representations":[{"base_url":"https://video.xx.fbcdn.net/v/cut.mp4"}';

  assert.deepEqual(extractPrefetchPairs(text), []);
});

test('extractPrefetchPairs keeps malformed oversized input bounded', () => {
  const repeated = `"all_video_dash_prefetch_representations":[`.repeat(16);
  const text = `{${repeated}"padding":"${'x'.repeat(16 * 1024 * 1024)}"`;

  assert.deepEqual(extractPrefetchPairs(text), []);
});

test('extractPrefetchPairs refuses one balanced fragment above its recovery cap', () => {
  const text = JSON.stringify({
    all_video_dash_prefetch_representations: [{ padding: 'x'.repeat(4 * 1024 * 1024 + 1) }],
  });

  assert.deepEqual(extractPrefetchPairs(text), []);
});

test('extractPrefetchPairs continues after balanced invalid JSON', () => {
  const text = [
    '{"all_video_dash_prefetch_representations":[not-json]}',
    JSON.stringify({ all_video_dash_prefetch_representations: ladder('after-invalid') }),
  ].join('\n');

  assert.deepEqual(
    extractPrefetchPairs(text).map((pair) => pair.videoUrl),
    ['https://video.xx.fbcdn.net/v/after-invalid.mp4'],
  );
});

test('extractPrefetchPairs does not truncate a legitimate large feed', () => {
  const text = Array.from({ length: 520 }, (_, i) =>
    JSON.stringify({ all_video_dash_prefetch_representations: ladder(`bulk-${i}`) }),
  ).join('\n');

  const pairs = extractPrefetchPairs(text);

  assert.equal(pairs.length, 520);
  assert.equal(pairs.at(-1)?.videoUrl, 'https://video.xx.fbcdn.net/v/bulk-519.mp4');
});

test('extractUrlsByKey stays bounded when a video key recurs in unclosed objects', () => {
  // A dense recurrence of an outer video key inside an unterminated nested
  // structure used to re-scan each object window from every interior key,
  // freezing the main thread. Bounded recovery must skip each failed window, so
  // this large hostile body resolves quickly to no URLs — a regression here
  // hangs the runner instead of failing an assertion.
  const text = '"playable_url":{'.repeat(150_000); // ~2.4 MB, never closes
  assert.deepEqual(extractUrlsByKey(text), []);
});

test('extractUrlsByKey recovers a valid object after a malformed sibling', () => {
  // Skipping the failed window must not swallow a valid direct-object URL that
  // follows a cheaply-malformed one.
  const recovered = 'https://video.xx.fbcdn.net/v/recovered-after-malformed.mp4';
  const body = `{"playable_url":{"uri":]},"playable_url":{"uri":"${recovered}"}}`;
  assert.deepEqual(extractUrlsByKey(body), [recovered]);
});
