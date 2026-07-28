// The MP4 remuxer that replaced ffmpeg.wasm.
//
// The fixtures are REAL media, not hand-written boxes: a 160x120 AVC track and an
// AAC track, both recorded by Chromium's own MediaRecorder, which is the closest
// thing available to what Facebook's packager serves — separate single-track
// progressive MP4s with real sample tables, a real avcC/esds in stsd, and the
// audio carrying its own encoder priming. Hand-built fixtures would only prove the
// writer agrees with the reader.
//
// The audio is deliberately LONGER than the video, so every run exercises the
// shortest-track trim that `-c copy -shortest` used to do.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { parseTrack, parseTracks, remux } from '../src/shared/mp4-remux';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures');
const videoBytes = readFileSync(join(FIXTURES, 'track-video.mp4'));
const audioBytes = readFileSync(join(FIXTURES, 'track-audio.mp4'));
const videoBlob = new Blob([videoBytes], { type: 'video/mp4' });
const audioBlob = new Blob([audioBytes], { type: 'audio/mp4' });

const seconds = (t: { samples: Array<{ duration: number }>; timescale: number }): number =>
  t.samples.reduce((sum, s) => sum + s.duration, 0) / t.timescale;

test('reads a real single-track MP4: kind, timescale, sample table and codec box', async () => {
  const video = await parseTrack(videoBlob);
  assert.equal(video.kind, 'video');
  assert.ok(video.timescale > 0);
  assert.ok(video.samples.length > 10, `expected real frames, got ${video.samples.length}`);
  assert.ok(video.width > 0 && video.height > 0, 'tkhd display size must survive');
  // The stsd is the codec: avc1 for this fixture, and it is copied not parsed.
  assert.ok(video.stsd.byteLength > 8);
  assert.match(Buffer.from(video.stsd).toString('latin1'), /avc1|avcC/);
  // Sample offsets must land inside the file and not overlap the next sample.
  for (const sample of video.samples) {
    assert.ok(sample.offset >= 0 && sample.offset + sample.size <= videoBytes.length);
    assert.ok(sample.size > 0);
  }
  // A real AVC track has non-sync samples, so its stss must have been read.
  assert.ok(
    video.samples.some((s) => !s.sync),
    'expected inter frames — a stss that was skipped would mark everything sync',
  );

  const audio = await parseTrack(audioBlob);
  assert.equal(audio.kind, 'audio');
  assert.ok(audio.samples.length > 10);
  assert.match(Buffer.from(audio.stsd).toString('latin1'), /mp4a/);
});

test('merges the two tracks into one MP4 whose samples are byte-identical to the inputs', async () => {
  const source = { video: await parseTrack(videoBlob), audio: await parseTrack(audioBlob) };
  const result = await remux(videoBlob, audioBlob);
  const out = Buffer.from(await result.blob.arrayBuffer());

  const tracks = await parseTracks(new Blob([out]));
  assert.equal(tracks.length, 2, 'the output must carry exactly two tracks');
  const outVideo = tracks.find((t) => t.kind === 'video')!;
  const outAudio = tracks.find((t) => t.kind === 'audio')!;
  assert.ok(outVideo && outAudio, 'one video track and one audio track');

  // Lossless in the `-c copy` sense: the codec description and every sample byte
  // come through untouched. This is the assertion that would catch a writer that
  // produces a plausible file with shifted or truncated media.
  for (const [outTrack, srcTrack, srcBytes] of [
    [outVideo, source.video, videoBytes],
    [outAudio, source.audio, audioBytes],
  ] as const) {
    assert.deepEqual(
      Buffer.from(outTrack.stsd),
      Buffer.from(srcTrack.stsd),
      `${outTrack.kind}: stsd must be copied verbatim`,
    );
    assert.equal(outTrack.timescale, srcTrack.timescale, `${outTrack.kind}: timescale`);
    for (let i = 0; i < outTrack.samples.length; i++) {
      const from = srcTrack.samples[i]!;
      const to = outTrack.samples[i]!;
      assert.equal(to.size, from.size, `${outTrack.kind} sample ${i}: size`);
      assert.equal(to.duration, from.duration, `${outTrack.kind} sample ${i}: duration`);
      assert.equal(to.cts, from.cts, `${outTrack.kind} sample ${i}: composition offset`);
      assert.equal(to.sync, from.sync, `${outTrack.kind} sample ${i}: sync flag`);
      assert.deepEqual(
        out.subarray(to.offset, to.offset + to.size),
        srcBytes.subarray(from.offset, from.offset + from.size),
        `${outTrack.kind} sample ${i}: bytes must be identical to the source`,
      );
    }
  }
});

test('trims to the shorter track, the way -shortest did', async () => {
  const video = await parseTrack(videoBlob);
  const audio = await parseTrack(audioBlob);
  const shorter = Math.min(seconds(video), seconds(audio));
  assert.ok(
    Math.abs(seconds(video) - seconds(audio)) > 0.2,
    'the fixtures must differ in length or this test proves nothing',
  );

  const result = await remux(videoBlob, audioBlob);
  assert.ok(Math.abs(result.durationSec - shorter) < 0.05, `duration ${result.durationSec} vs ${shorter}`);

  const tracks = await parseTracks(new Blob([await result.blob.arrayBuffer()]));
  for (const track of tracks) {
    // Neither track may run meaningfully past the shorter one — that is a file
    // ending on frozen video or on silence, which is what the flag existed to
    // prevent. One sample of overshoot is allowed because it is also what ffmpeg
    // did: the last packet admitted starts before the limit and ends after it.
    const oneSample = Math.max(...track.samples.map((s) => s.duration)) / track.timescale;
    assert.ok(
      seconds(track) <= shorter + oneSample + 1e-6,
      `${track.kind} runs ${seconds(track)}s past a ${shorter}s limit (+${oneSample}s allowed)`,
    );
  }
  // And the longer track really did lose samples, rather than the limit being a
  // no-op because both were read as the same length.
  const longer = seconds(video) > seconds(audio) ? 'video' : 'audio';
  const before = longer === 'video' ? video.samples.length : audio.samples.length;
  const after = tracks.find((t) => t.kind === longer)!.samples.length;
  assert.ok(after < before, `${longer}: expected a trim, kept all ${before} samples`);
});

test('interleaves the two tracks instead of writing one after the other', async () => {
  // A player seeking through a file whose audio all sits after the video has to
  // buffer the whole video first. Chunks must alternate.
  const result = await remux(videoBlob, audioBlob);
  const tracks = await parseTracks(new Blob([await result.blob.arrayBuffer()]));
  const points = tracks.flatMap((t) => t.samples.map((s) => ({ kind: t.kind, offset: s.offset })));
  points.sort((a, b) => a.offset - b.offset);
  let switches = 0;
  for (let i = 1; i < points.length; i++) if (points[i]!.kind !== points[i - 1]!.kind) switches++;
  assert.ok(switches > 2, `expected interleaved chunks, saw ${switches} track switches`);
});

test('puts the header before the media so playback can start without the whole file', async () => {
  const result = await remux(videoBlob, audioBlob);
  const out = Buffer.from(await result.blob.arrayBuffer());
  const ftyp = out.indexOf('ftyp', 0, 'latin1');
  const moov = out.indexOf('moov', 0, 'latin1');
  const mdat = out.indexOf('mdat', 0, 'latin1');
  assert.ok(ftyp >= 0 && moov >= 0 && mdat >= 0, 'ftyp, moov and mdat must all be present');
  assert.ok(ftyp < moov && moov < mdat, `expected ftyp < moov < mdat, got ${ftyp}/${moov}/${mdat}`);
});

test('refuses input it cannot remux instead of writing a file that does not play', async () => {
  await assert.rejects(() => remux(new Blob([Buffer.alloc(64)]), audioBlob), /no moov box|not an MP4/i);
  // Two tracks of the same kind is the mistake that would silently produce a
  // video with no sound.
  await assert.rejects(() => remux(videoBlob, videoBlob), /two of the same kind/i);
});
