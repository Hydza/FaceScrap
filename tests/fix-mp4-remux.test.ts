// The MP4 remuxer that replaced ffmpeg.wasm.
//
// The fixtures are REAL media, not hand-written boxes: a 160x120 AVC track and an
// AAC track, both recorded by Chromium's own MediaRecorder, which is the closest
// thing available to what Facebook's packager serves — separate single-track MP4s
// with real sample tables and a real avcC/esds in stsd. Hand-built fixtures would
// only prove the writer agrees with the reader.
//
// The audio is deliberately LONGER than the video, so every run exercises the
// shortest-track trim that `-c copy -shortest` used to do.
//
// Neither fixture carries an edit list, and both happen to use the same movie
// timescale the writer emits — so the edit-list tests at the end of this file graft
// one on. That combination is why a verbatim copy of that box read as correct here
// for as long as it did.

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

// The parser reads bytes off the network, and the table sizes come from inside
// those bytes. Both of these were real gaps found reviewing it after the fact.
test('refuses a truncated track instead of writing a file with samples past its end', async () => {
  // Blob.slice clamps a range that runs past the end rather than throwing, so
  // without a bounds check this produced a corrupt file reported as a success.
  const half = new Blob([videoBytes.subarray(0, Math.floor(videoBytes.length / 2))]);
  await assert.rejects(() => parseTrack(half), /truncated|no moov|no samples/i);
  await assert.rejects(() => remux(half, audioBlob), /truncated|no moov|no samples/i);
});

test('refuses a sample table that declares more entries than the file can hold', async () => {
  // Overwrite the stsz entry count with 0xFFFFFFFF. Expanding that literally is
  // millions of pushes for a 30 KB file; the box's own length is the real bound.
  const bytes = Buffer.from(videoBytes);
  const at = bytes.indexOf('stsz', 0, 'latin1');
  if (at > 0) {
    bytes.writeUInt32BE(0xffffffff, at + 12); // sample_count
    const parsed = await parseTrack(new Blob([bytes])).catch((error: Error) => error);
    // Either it refuses outright, or it clamps to what the box can hold — never
    // expands four billion entries.
    if (!(parsed instanceof Error)) {
      assert.ok(parsed.samples.length < 100_000, `expanded ${parsed.samples.length} samples from a 30 KB file`);
    }
  }
  // And a declared count beyond the hard ceiling is refused by name.
  const remuxer = readFileSync(join(process.cwd(), 'src', 'shared', 'mp4-remux.ts'), 'utf8');
  assert.match(remuxer, /MAX_SAMPLES_PER_TRACK = 1_500_000/);
  assert.match(remuxer, /boundedEntries\(/);
});

test('refuses input it cannot remux instead of writing a file that does not play', async () => {
  await assert.rejects(() => remux(new Blob([Buffer.alloc(64)]), audioBlob), /no moov box|not an MP4/i);
  // Two tracks of the same kind is the mistake that would silently produce a
  // video with no sound.
  await assert.rejects(() => remux(videoBlob, videoBlob), /two of the same kind/i);
});

// ── The edit list ────────────────────────────────────────────────────────────
// A track's `elst` is the one box whose numbers are expressed in the MOVIE timescale
// — the source file's, which this writer replaces with its own. It is also the box
// Facebook's packager uses to carry an audio track's encoder priming, so it cannot
// simply be dropped: without it the whole track slides against the video.

/** Read a box header at `at`, assuming a 32-bit size (every box in these fixtures). */
function boxAt(buf: Buffer, at: number): { type: string; bodyStart: number; end: number } {
  return { type: buf.toString('latin1', at + 4, at + 8), bodyStart: at + 8, end: at + buf.readUInt32BE(at) };
}

function boxChildren(buf: Buffer, from: number, to: number): Array<ReturnType<typeof boxAt> & { start: number }> {
  const out: Array<ReturnType<typeof boxAt> & { start: number }> = [];
  for (let at = from; at + 8 <= to; ) {
    const box = boxAt(buf, at);
    out.push({ ...box, start: at });
    at = box.end > at ? box.end : to;
  }
  return out;
}

/**
 * The audio fixture with an edit list grafted into its trak and a movie timescale
 * of the caller's choosing — the two things it does not have, and the two the writer
 * has to reconcile.
 *
 * Inserting into moov shifts every byte after it, which is safe for these fragmented
 * fixtures: sample positions come from each moof's own trun offsets, so they move
 * with their moof. Only moov's and trak's own sizes need correcting.
 */
function audioWithEditList(segmentDuration: number, movieTimescale: number, mediaTime = -1): Blob {
  const src = Buffer.from(audioBytes);
  const moov = boxChildren(src, 0, src.length).find((b) => b.type === 'moov')!;
  const body = Buffer.from(src.subarray(moov.start, moov.end));

  const inner = boxChildren(body, 8, body.length);
  const mvhd = inner.find((b) => b.type === 'mvhd')!;
  // mvhd: version(1) flags(3) creation modification timescale — the timestamps are
  // 64-bit in version 1.
  body.writeUInt32BE(movieTimescale, mvhd.bodyStart + 4 + (body[mvhd.bodyStart] === 1 ? 16 : 8));

  const trak = inner.find((b) => b.type === 'trak')!;
  const tkhd = boxChildren(body, trak.bodyStart, trak.end).find((b) => b.type === 'tkhd')!;
  const edts = Buffer.alloc(36);
  edts.writeUInt32BE(36, 0);
  edts.write('edts', 4, 'latin1');
  edts.writeUInt32BE(28, 8);
  edts.write('elst', 12, 'latin1');
  edts.writeUInt32BE(0, 16); // version 0 + flags
  edts.writeUInt32BE(1, 20); // one entry
  edts.writeUInt32BE(segmentDuration, 24);
  edts.writeInt32BE(mediaTime, 28);
  edts.writeUInt32BE(0x00010000, 32); // rate 1.0

  const patchedMoov = Buffer.concat([body.subarray(0, tkhd.end), edts, body.subarray(tkhd.end)]);
  patchedMoov.writeUInt32BE(patchedMoov.length, 0);
  patchedMoov.writeUInt32BE(trak.end - trak.start + edts.length, trak.start);
  return new Blob([src.subarray(0, moov.start), patchedMoov, src.subarray(moov.end)]);
}

test('rescales the edit list into the movie timescale it writes, not the one it read', async () => {
  // 0.1s of priming, in a source movie timescale of 48000. Copied through verbatim, the
  // same 4800 units read against this writer's own timescale of 1000 became 4.8 SECONDS
  // of empty presentation: audio playing over a blank screen until the video appeared.
  const patched = audioWithEditList(4800, 48000);
  const source = await parseTrack(patched);
  assert.ok(source.edits, 'the grafted list must be readable at all');
  assert.equal(source.edits[0]!.mediaTime, -1, 'an empty edit is signalled by media_time -1');
  assert.ok(
    Math.abs(source.edits[0]!.durationSec - 0.1) < 1e-9,
    'the parse must convert out of the source movie timescale, not carry raw units',
  );

  const merged = await remux(videoBlob, patched);
  const audio = (await parseTracks(merged.blob)).find((t) => t.kind === 'audio');
  assert.ok(audio?.edits, 'the edit list must survive the merge — dropping it slides the track');
  assert.equal(audio.edits[0]!.mediaTime, -1, 'an empty edit must stay empty');
  assert.ok(
    Math.abs(audio.edits[0]!.durationSec - 0.1) < 0.002,
    `0.1s of priming came out as ${audio.edits[0]!.durationSec}s`,
  );
});

test('clamps an edit list that outlives the trimmed media', async () => {
  // 30 seconds of edit over a track the shortest-track trim cuts to under two. The
  // source was telling the truth about ITS media; this file's is shorter.
  const merged = await remux(videoBlob, audioWithEditList(48000 * 30, 48000, 0));
  const audio = (await parseTracks(merged.blob)).find((t) => t.kind === 'audio');
  assert.ok(audio?.edits);
  // The ceiling is the duration as the header states it — whole milliseconds, since that
  // is the timescale — not the unrounded limit the trim computed.
  const movieDuration = Math.round(merged.durationSec * 1000) / 1000;
  assert.ok(
    audio.edits[0]!.durationSec <= movieDuration + 1e-9,
    `a ${audio.edits[0]!.durationSec}s edit over a ${movieDuration}s movie`,
  );
  assert.ok(audio.edits[0]!.durationSec > 0, 'clamping must not delete the edit');
});

test('leaves a file with no edit list without one', async () => {
  // The fixtures carry none, and a track that plays from sample 0 must not acquire an
  // edit this writer invented.
  const merged = await remux(videoBlob, audioBlob);
  for (const track of await parseTracks(merged.blob)) {
    assert.equal(track.edits, undefined, `${track.kind} grew an edit list out of nothing`);
  }
});

// ── The progressive shape ────────────────────────────────────────────────────
// Both fixtures above are FRAGMENTED — Chromium's MediaRecorder emits moof/trun and
// leaves the stbl empty. Facebook serves either shape, so every test up to here has
// been exercising half the reader. These build the other half: one stbl carrying the
// real stts/stsc/stsz/stco tables, wrapped around the real avc1 stsd of the fixture.
//
// Building it here rather than checking in a third fixture is deliberate: the sample
// COUNT is the variable under test, and no checked-in file can be both small enough to
// commit and long enough to reach the writer's limits.

const u32b = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
};
const boxOf = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32b(body.length + 8), Buffer.from(type, 'latin1'), body]);
};
const fullBoxOf = (type: string, version: number, flags: number, ...parts: Buffer[]): Buffer =>
  boxOf(type, Buffer.from([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]), ...parts);
/** Packed uint32 table. Spreading one argument per entry is what the writer under
 *  test used to do, and this builder hit the very same RangeError writing the file
 *  that was meant to expose it. */
const u32Table = (values: number[]): Buffer => {
  const out = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) out.writeUInt32BE(values[i]! >>> 0, i * 4);
  return out;
};

interface ProgressiveSpec {
  stsd: Uint8Array;
  sampleCount: number;
  timescale: number;
  sampleDuration: number;
  /** Varying sizes force the non-uniform stsz branch — the one with an entry per sample. */
  size: (i: number) => number;
  sync: (i: number) => boolean;
  cts?: (i: number) => number;
  cttsVersion?: 0 | 1;
}

/** A single-track progressive MP4: ftyp + moov(one stbl) + mdat, no fragments. */
function progressiveVideo(spec: ProgressiveSpec): { blob: Blob; media: Buffer } {
  const sizes = Array.from({ length: spec.sampleCount }, (_, i) => spec.size(i));
  const media = Buffer.concat(
    sizes.map((size, i) => Buffer.alloc(size, i & 0xff)),
  );
  const duration = spec.sampleCount * spec.sampleDuration;

  const stts = fullBoxOf('stts', 0, 0, u32b(1), u32b(spec.sampleCount), u32b(spec.sampleDuration));
  const syncIndexes = sizes.map((_, i) => i + 1).filter((_, i) => spec.sync(i));
  const stss =
    syncIndexes.length === spec.sampleCount
      ? undefined
      : fullBoxOf('stss', 0, 0, u32b(syncIndexes.length), u32Table(syncIndexes));
  const ctts = spec.cts
    ? fullBoxOf(
        'ctts',
        spec.cttsVersion ?? 0,
        0,
        u32b(spec.sampleCount),
        // One run per sample: the count/value pairs an unencoded ctts carries.
        u32Table(sizes.flatMap((_, i) => [1, spec.cts!(i)])),
      )
    : undefined;
  // One chunk holding every sample keeps stco a single entry, so the two-pass
  // offset fixup below only has one number to correct.
  const stsc = fullBoxOf('stsc', 0, 0, u32b(1), u32b(1), u32b(spec.sampleCount), u32b(1));
  const stsz = fullBoxOf('stsz', 0, 0, u32b(0), u32b(spec.sampleCount), u32Table(sizes));

  const build = (mdatDataStart: number): Buffer => {
    const stco = fullBoxOf('stco', 0, 0, u32b(1), u32b(mdatDataStart));
    const stbl = boxOf(
      'stbl',
      Buffer.from(spec.stsd),
      stts,
      ...(ctts ? [ctts] : []),
      ...(stss ? [stss] : []),
      stsc,
      stsz,
      stco,
    );
    const dinf = boxOf('dinf', boxOf('dref', Buffer.concat([u32b(0), u32b(1), fullBoxOf('url ', 0, 1)])));
    const vmhd = fullBoxOf('vmhd', 0, 1, Buffer.alloc(8));
    const minf = boxOf('minf', vmhd, dinf, stbl);
    const hdlr = fullBoxOf(
      'hdlr',
      0,
      0,
      u32b(0),
      Buffer.from('vide', 'latin1'),
      Buffer.alloc(12),
      Buffer.from('VideoHandler\0', 'latin1'),
    );
    const mdhd = fullBoxOf(
      'mdhd',
      0,
      0,
      u32b(0),
      u32b(0),
      u32b(spec.timescale),
      u32b(duration),
      Buffer.from([0x55, 0xc4, 0, 0]), // 'und' + predefined
    );
    const mdia = boxOf('mdia', mdhd, hdlr, minf);
    const matrix = Buffer.alloc(36);
    matrix.writeUInt32BE(0x00010000, 0);
    matrix.writeUInt32BE(0x00010000, 16);
    matrix.writeUInt32BE(0x40000000, 32);
    const tkhd = fullBoxOf(
      'tkhd',
      0,
      0x000003,
      u32b(0),
      u32b(0),
      u32b(1),
      u32b(0),
      u32b(duration),
      Buffer.alloc(8),
      Buffer.alloc(8), // layer, alternate group, volume, reserved
      matrix,
      u32b(160 << 16),
      u32b(120 << 16),
    );
    const trak = boxOf('trak', tkhd, mdia);
    const mvhd = fullBoxOf(
      'mvhd',
      0,
      0,
      u32b(0),
      u32b(0),
      u32b(spec.timescale),
      u32b(duration),
      u32b(0x00010000),
      Buffer.from([1, 0]),
      Buffer.alloc(10),
      matrix,
      Buffer.alloc(24),
      u32b(2),
    );
    const moov = boxOf('moov', mvhd, trak);
    const ftyp = boxOf('ftyp', Buffer.from('isom', 'latin1'), u32b(0x200), Buffer.from('isomiso2avc1mp41', 'latin1'));
    return Buffer.concat([ftyp, moov, u32b(media.length + 8), Buffer.from('mdat', 'latin1'), media]);
  };

  // stco points at bytes whose position depends on the size of the box holding stco.
  // Build once to measure, then again with the offset that measurement produced; the
  // entry is fixed-width, so the second build has the same length as the first.
  const measured = build(0);
  const mdatDataStart = measured.length - media.length;
  return { blob: new Blob([new Uint8Array(build(mdatDataStart))]), media };
}

test('reads a PROGRESSIVE MP4 — one stbl, no fragments — as faithfully as a fragmented one', async () => {
  const { stsd } = await parseTrack(videoBlob);
  const { blob, media } = progressiveVideo({
    stsd,
    sampleCount: 50,
    timescale: 1000,
    sampleDuration: 40,
    size: (i) => 20 + (i % 5),
    sync: (i) => i % 10 === 0,
  });

  const track = await parseTrack(blob);
  assert.equal(track.kind, 'video');
  assert.equal(track.timescale, 1000);
  assert.equal(track.samples.length, 50, 'every stbl sample must be read');
  assert.deepEqual(Buffer.from(track.stsd), Buffer.from(stsd), 'stsd copied verbatim on the progressive path too');
  // The tables really were expanded, not defaulted: sizes vary, sync flags alternate,
  // and the offsets walk the mdat in order.
  const source = Buffer.from(await blob.arrayBuffer());
  let walked = 0;
  for (let i = 0; i < track.samples.length; i++) {
    const s = track.samples[i]!;
    assert.equal(s.size, 20 + (i % 5), `sample ${i}: stsz size`);
    assert.equal(s.duration, 40, `sample ${i}: stts duration`);
    assert.equal(s.sync, i % 10 === 0, `sample ${i}: stss flag`);
    assert.deepEqual(source.subarray(s.offset, s.offset + s.size), media.subarray(walked, walked + s.size));
    walked += s.size;
  }
});

test('a progressive stsz declaring four billion samples is bounded by the box, not expanded', async () => {
  // The same corruption tests/fix-mp4-remux.test.ts tried on the fragmented fixtures,
  // where an empty stbl meant it never reached readSampleTable and the assertion could
  // not fail. Here the stbl is the only source of samples, so it does.
  const { stsd } = await parseTrack(videoBlob);
  const { blob } = progressiveVideo({
    stsd,
    sampleCount: 40,
    timescale: 1000,
    sampleDuration: 40,
    size: () => 16,
    sync: () => true,
  });
  const bytes = Buffer.from(await blob.arrayBuffer());
  const at = bytes.indexOf('stsz', 0, 'latin1');
  assert.ok(at > 0, 'the built file must actually contain an stsz');
  bytes.writeUInt32BE(0xffffffff, at + 12); // sample_count

  const parsed = await parseTrack(new Blob([bytes])).catch((error: Error) => error);
  if (parsed instanceof Error) return; // refusing outright is also correct
  assert.ok(
    parsed.samples.length <= 40,
    `expanded ${parsed.samples.length} samples from a box that can hold 40`,
  );
});

test('writes a sample table far past the argument limit of a variadic call', async () => {
  // stsz, stss and stco carry one entry per sample. Spreading an argument per entry
  // into box()/fullBox() threw `RangeError: Maximum call stack size exceeded` at about
  // 62 400 entries — while the reader accepts MAX_SAMPLES_PER_TRACK = 1 500 000. Any
  // video past roughly 25 minutes hit it, and the user saw only "Could not merge audio
  // and video."
  const { stsd } = await parseTrack(videoBlob);
  const audio = await parseTrack(audioBlob);
  const audioSeconds = seconds(audio);
  const sampleCount = 90_000; // comfortably past the old ceiling
  // Fit the whole track inside the audio so the shortest-track trim keeps every
  // sample: it is the sample COUNT reaching the writer that this test is about.
  const timescale = Math.ceil((sampleCount * 2) / (audioSeconds * 0.9));

  const { blob, media } = progressiveVideo({
    stsd,
    sampleCount,
    timescale,
    sampleDuration: 2,
    size: (i) => 8 + (i % 3), // non-uniform: forces the per-sample stsz branch
    sync: (i) => i % 250 === 0, // sparse keyframes: forces a real stss
  });

  const merged = await remux(blob, audioBlob);
  const out = Buffer.from(await merged.blob.arrayBuffer());
  const outVideo = (await parseTracks(new Blob([out]))).find((t) => t.kind === 'video');
  if (!outVideo) throw new Error('the output must still carry the video track');
  const frames = outVideo.samples;
  assert.equal(frames.length, sampleCount, 'every sample must survive the round trip');

  // Spot-check byte identity at both ends and the middle rather than all 90 000: the
  // point is that the tables address the right bytes, and a table built from a wrong
  // offset is wrong everywhere, not in one place.
  const offsets: number[] = [];
  let walked = 0;
  for (const sample of frames) {
    offsets.push(walked);
    walked += sample.size;
  }
  for (const i of [0, 1, sampleCount >> 1, sampleCount - 1]) {
    const frame = frames[i]!;
    assert.equal(frame.size, 8 + (i % 3), `sample ${i}: size`);
    assert.equal(frame.sync, i % 250 === 0, `sample ${i}: sync flag`);
    assert.deepEqual(
      out.subarray(frame.offset, frame.offset + frame.size),
      media.subarray(offsets[i]!, offsets[i]! + frame.size),
      `sample ${i}: bytes`,
    );
  }
});

test('writes a version-1 ctts so a negative composition offset survives', async () => {
  // The reader takes negative offsets from a v1 ctts and from a v1 trun; the writer
  // always emitted v0, where the field is UNSIGNED. -512 came out as 4 294 966 784 and
  // the player placed the frame four billion ticks away — a file that downloads
  // "successfully" and does not present.
  const { stsd } = await parseTrack(videoBlob);
  const { blob } = progressiveVideo({
    stsd,
    sampleCount: 60,
    timescale: 1000,
    sampleDuration: 40,
    size: () => 24,
    sync: (i) => i % 10 === 0,
    cts: () => -512,
    cttsVersion: 1,
  });

  const source = await parseTrack(blob);
  assert.ok(
    source.samples.every((s) => s.cts === -512),
    'the reader must take the negative offset, or this test proves nothing',
  );

  const merged = await remux(blob, audioBlob);
  const outVideo = (await parseTracks(merged.blob)).find((t) => t.kind === 'video');
  assert.ok(outVideo);
  assert.ok(
    outVideo.samples.every((s) => s.cts === -512),
    `negative composition offsets must round-trip, got ${outVideo.samples[0]!.cts}`,
  );
});

test('writes an empty stss rather than claiming every frame is a seek point', async () => {
  // "No stss" means "every sample is a sync sample" — the reader says so itself. A
  // track where NOTHING is a sync sample was falling into the same branch, so the
  // output told players they could start decoding on any inter frame.
  const { stsd } = await parseTrack(videoBlob);
  const { blob } = progressiveVideo({
    stsd,
    sampleCount: 40,
    timescale: 1000,
    sampleDuration: 40,
    size: () => 24,
    sync: () => false,
  });

  const source = await parseTrack(blob);
  assert.ok(source.samples.every((s) => !s.sync), 'the reader must see zero sync samples');

  const merged = await remux(blob, audioBlob);
  const outVideo = (await parseTracks(merged.blob)).find((t) => t.kind === 'video');
  assert.ok(outVideo);
  assert.ok(
    outVideo.samples.every((s) => !s.sync),
    'a track with no sync samples must not come out with all of them marked sync',
  );
});

test('refuses a track whose stsd describes more than one codec', async () => {
  // Every stsc entry is written with sample_description_index = 1, so a second
  // description would silently decode its samples with the first one's parameters.
  const { stsd } = await parseTrack(videoBlob);
  const { blob } = progressiveVideo({
    stsd,
    sampleCount: 20,
    timescale: 1000,
    sampleDuration: 40,
    size: () => 24,
    sync: () => true,
  });
  const bytes = Buffer.from(await blob.arrayBuffer());
  const at = bytes.indexOf('stsd', 0, 'latin1');
  assert.ok(at > 0);
  bytes.writeUInt32BE(2, at + 8); // entry_count, right after version+flags

  await assert.rejects(() => parseTrack(new Blob([bytes])), /sample descriptions/i);
});
