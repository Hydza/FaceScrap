// MP4 remuxer: two single-track MP4s in, one two-track MP4 out. No dependency,
// no wasm, no re-encode.
//
// This replaces ffmpeg.wasm, which was 9.8 MB compressed — 94% of the extension —
// to run one `-c copy -shortest` merge. What that command actually does is copy
// sample bytes unchanged and write a new sample table around them, which is what
// this file does directly.
//
// Two properties are load-bearing:
//
// 1. NOT ONE SAMPLE BYTE PASSES THROUGH JS. The output is assembled as a Blob of
//    slices of the input Blobs, so the media stays wherever the browser put it
//    (usually disk) and only the header is built in memory. ffmpeg had to read
//    both tracks through its wasm heap; a 500 MB reel cost that much heap on top
//    of the Blobs. Here the peak is the size of the sample tables.
//
// 2. Codec-agnostic by construction. The `stsd` box — the only place a codec is
//    described — is copied verbatim, so AVC, HEVC, VP9, AV1, AAC, Opus, AC-3 and
//    anything else Facebook packages keeps working without a line of code here
//    knowing what it is. Sample bytes are equally untouched, which is what makes
//    this lossless in the same sense `-c copy` was.
//
// It reads BOTH MP4 shapes, because a DASH representation can be either. A
// progressive file keeps every sample in one `stbl`; a fragmented one keeps an
// empty `stbl` in `moov` and describes its samples in a `trun` per `moof`. The two
// readers converge on the same flat sample list, and everything after that is
// shape-blind. Output is always progressive (`moov` before `mdat`), which is what
// makes the file seekable from the first byte.
//
// What it deliberately does NOT do: anything requiring a decode. Unsupported input
// throws with a reason rather than writing a file that does not play.

/** A box header as found on disk. `body` spans the payload only. */
interface BoxHeader {
  type: string;
  start: number;
  bodyStart: number;
  end: number;
}

interface Mp4Sample {
  /** Byte offset in the SOURCE file. */
  offset: number;
  size: number;
  /** Duration in the track's media timescale. */
  duration: number;
  /** Composition offset (ctts), 0 when the track has none. */
  cts: number;
  sync: boolean;
}

interface Mp4Track {
  kind: 'video' | 'audio';
  timescale: number;
  language: number;
  /** The sample description box, copied verbatim — the codec lives in here. */
  stsd: Uint8Array;
  /** 16.16 fixed-point display size from tkhd; video only. */
  width: number;
  height: number;
  /** The source's `edts` box, verbatim when present. Audio tracks carry an edit
   *  list for encoder priming; dropping it shifts the whole track against the
   *  video by a few tens of milliseconds, permanently. */
  edts?: Uint8Array;
  samples: Mp4Sample[];
}

const TEXT = new TextEncoder();

// ── Reading ─────────────────────────────────────────────────────────────────

class Cursor {
  private view: DataView;
  offset = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    return this.view.getUint8(this.offset++);
  }
  u16(): number {
    const v = this.view.getUint16(this.offset);
    this.offset += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.offset);
    this.offset += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.offset);
    this.offset += 4;
    return v;
  }
  u64(): number {
    const hi = this.u32();
    const lo = this.u32();
    // Sizes and durations beyond 2^53 cannot occur in a file we are willing to
    // hold; losing precision silently would be worse than the range.
    return hi * 2 ** 32 + lo;
  }
  skip(n: number): void {
    this.offset += n;
  }
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

/** Walk the boxes directly inside [from, to) of `bytes`. */
function children(bytes: Uint8Array, from: number, to: number): BoxHeader[] {
  const out: BoxHeader[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = fourcc(bytes, at + 4);
    let bodyStart = at + 8;
    if (size === 1) {
      const hi = view.getUint32(at + 8);
      const lo = view.getUint32(at + 12);
      size = hi * 2 ** 32 + lo;
      bodyStart = at + 16;
    } else if (size === 0) {
      size = to - at; // "to end of enclosing box"
    }
    if (size < 8 || at + size > to) break;
    out.push({ type, start: at, bodyStart, end: at + size });
    at += size;
  }
  return out;
}

function find(boxes: BoxHeader[], type: string): BoxHeader | undefined {
  return boxes.find((b) => b.type === type);
}

/** Read every top-level box header without pulling the payloads into memory. */
async function topLevelBoxes(blob: Blob): Promise<BoxHeader[]> {
  const out: BoxHeader[] = [];
  let at = 0;
  while (at + 8 <= blob.size) {
    const head = new Uint8Array(await blob.slice(at, Math.min(at + 16, blob.size)).arrayBuffer());
    if (head.byteLength < 8) break;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = view.getUint32(0);
    const type = fourcc(head, 4);
    let bodyStart = at + 8;
    if (size === 1) {
      if (head.byteLength < 16) break;
      size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
      bodyStart = at + 16;
    } else if (size === 0) {
      size = blob.size - at;
    }
    if (size < 8 || at + size > blob.size) break;
    out.push({ type, start: at, bodyStart, end: at + size });
    at += size;
  }
  return out;
}

/** Ceiling on the sample table of ONE track.
 *
 *  These tables are sized by fields inside the file, and this parser reads files
 *  off the network — a truncated or garbled response (the code elsewhere already
 *  expects "an expired fbcdn URL returned an incomplete stream") can declare a
 *  count of four billion. Expanding that would exhaust the offscreen document
 *  before anything noticed. 1.5M samples is over nine hours of 60fps video, so no
 *  real reel comes near it. */
const MAX_SAMPLES_PER_TRACK = 1_500_000;

/** How many entries a table can actually hold, whatever its count field claims.
 *  Each table has a fixed entry width, so the box's own length is the real bound
 *  and the declared count is only a hint. */
function boundedEntries(declared: number, availableBytes: number, entryBytes: number): number {
  const fits = Math.max(0, Math.floor(availableBytes / entryBytes));
  return Math.min(declared, fits);
}

/** Expand stsc/stsz/stco/stts/ctts/stss into one flat sample list. */
function readSampleTable(moov: Uint8Array, stbl: BoxHeader): Mp4Sample[] {
  const boxes = children(moov, stbl.bodyStart, stbl.end);

  const sttsBox = find(boxes, 'stts');
  const stscBox = find(boxes, 'stsc');
  const stcoBox = find(boxes, 'stco') ?? find(boxes, 'co64');
  const stszBox = find(boxes, 'stsz') ?? find(boxes, 'stz2');
  if (!sttsBox || !stscBox || !stcoBox || !stszBox) {
    throw new Error('This track has no complete sample table (stts/stsc/stco/stsz).');
  }
  // A fragmented file keeps all four boxes here but empty; the caller then reads
  // the samples out of the fragments instead. Returning empty is the signal.

  /** Every expansion below grows one of these arrays; one shared budget bounds the
   *  lot, so a table cannot be made enormous by any single field. */
  const room = (have: number): number => {
    if (have > MAX_SAMPLES_PER_TRACK) {
      throw new Error(`This track declares more than ${MAX_SAMPLES_PER_TRACK} samples; refusing to expand it.`);
    }
    return MAX_SAMPLES_PER_TRACK - have;
  };

  // stts: run-length encoded durations.
  const stts = new Cursor(moov.subarray(sttsBox.bodyStart, sttsBox.end));
  stts.skip(4);
  const durations: number[] = [];
  const sttsRuns = boundedEntries(stts.u32(), sttsBox.end - sttsBox.bodyStart - 8, 8);
  for (let i = 0; i < sttsRuns; i++) {
    const count = Math.min(stts.u32(), room(durations.length));
    const delta = stts.u32();
    for (let k = 0; k < count; k++) durations.push(delta);
  }

  // stsz (uniform or per-sample) / stz2 (packed 4, 8 or 16 bit).
  const sizes: number[] = [];
  if (stszBox.type === 'stsz') {
    const c = new Cursor(moov.subarray(stszBox.bodyStart, stszBox.end));
    c.skip(4);
    const uniform = c.u32();
    // A uniform table stores no per-sample entries, so its length bounds nothing;
    // the shared sample budget is what holds it.
    const declared = c.u32();
    const count =
      uniform !== 0
        ? Math.min(declared, room(0))
        : boundedEntries(declared, stszBox.end - stszBox.bodyStart - 12, 4);
    for (let i = 0; i < count; i++) sizes.push(uniform !== 0 ? uniform : c.u32());
  } else {
    const c = new Cursor(moov.subarray(stszBox.bodyStart, stszBox.end));
    c.skip(4);
    c.skip(3);
    const fieldSize = c.u8();
    if (fieldSize !== 4 && fieldSize !== 8 && fieldSize !== 16) {
      throw new Error(`Unsupported stz2 field size ${fieldSize}.`);
    }
    const bits = stszBox.end - stszBox.bodyStart - 8;
    const count = boundedEntries(c.u32(), bits, fieldSize / 8);
    for (let i = 0; i < count; i++) {
      if (fieldSize === 16) sizes.push(c.u16());
      else if (fieldSize === 8) sizes.push(c.u8());
      else {
        const pair = c.u8();
        sizes.push(pair >> 4);
        if (++i < count) sizes.push(pair & 0x0f);
      }
    }
  }

  // ctts: composition offsets, run-length encoded. Version 1 offsets are signed.
  const cts: number[] = [];
  const cttsBox = find(boxes, 'ctts');
  if (cttsBox) {
    const c = new Cursor(moov.subarray(cttsBox.bodyStart, cttsBox.end));
    const version = c.u8();
    c.skip(3);
    const runs = boundedEntries(c.u32(), cttsBox.end - cttsBox.bodyStart - 8, 8);
    for (let i = 0; i < runs; i++) {
      const count = Math.min(c.u32(), room(cts.length));
      const offset = version === 1 ? c.i32() : c.u32();
      for (let k = 0; k < count; k++) cts.push(offset);
    }
  }

  // stss: sync samples. Absent means every sample is a sync sample.
  const stssBox = find(boxes, 'stss');
  let sync: Set<number> | undefined;
  if (stssBox) {
    const c = new Cursor(moov.subarray(stssBox.bodyStart, stssBox.end));
    c.skip(4);
    sync = new Set<number>();
    const count = boundedEntries(c.u32(), stssBox.end - stssBox.bodyStart - 8, 4);
    for (let i = 0; i < count; i++) sync.add(c.u32() - 1);
  }

  // Chunk offsets.
  const chunkOffsets: number[] = [];
  {
    const c = new Cursor(moov.subarray(stcoBox.bodyStart, stcoBox.end));
    c.skip(4);
    const width = stcoBox.type === 'co64' ? 8 : 4;
    const count = boundedEntries(c.u32(), stcoBox.end - stcoBox.bodyStart - 8, width);
    for (let i = 0; i < count; i++) chunkOffsets.push(width === 8 ? c.u64() : c.u32());
  }

  // stsc: samples per chunk, run-length encoded over chunks.
  const perChunk: number[] = new Array(chunkOffsets.length).fill(0);
  {
    const c = new Cursor(moov.subarray(stscBox.bodyStart, stscBox.end));
    c.skip(4);
    const runs = boundedEntries(c.u32(), stscBox.end - stscBox.bodyStart - 8, 12);
    const entries: Array<{ firstChunk: number; samples: number }> = [];
    for (let i = 0; i < runs; i++) {
      const firstChunk = c.u32();
      const samples = c.u32();
      c.skip(4); // sample_description_index — single-entry stsd only
      entries.push({ firstChunk, samples });
    }
    for (let e = 0; e < entries.length; e++) {
      const from = entries[e]!.firstChunk - 1;
      const to = e + 1 < entries.length ? entries[e + 1]!.firstChunk - 1 : chunkOffsets.length;
      for (let ch = from; ch < to && ch < perChunk.length; ch++) perChunk[ch] = entries[e]!.samples;
    }
  }

  // Walk chunks in order, laying samples end to end inside each one.
  const samples: Mp4Sample[] = [];
  let index = 0;
  for (let ch = 0; ch < chunkOffsets.length; ch++) {
    let offset = chunkOffsets[ch]!;
    for (let k = 0; k < perChunk[ch]!; k++, index++) {
      if (index >= sizes.length) break;
      samples.push({
        offset,
        size: sizes[index]!,
        duration: durations[index] ?? durations[durations.length - 1] ?? 0,
        cts: cts[index] ?? 0,
        sync: sync ? sync.has(index) : true,
      });
      offset += sizes[index]!;
    }
  }
  return samples;
}

/** Per-track defaults from `mvex/trex`, used by fragments that omit their own. */
interface TrexDefaults {
  duration: number;
  size: number;
  flags: number;
}

/**
 * Collect samples from every `moof` in the file.
 *
 * A fragmented MP4 carries no sample table in `moov` — each fragment's `trun`
 * describes its own samples, with anything it omits falling back to `tfhd` then to
 * `trex`. Chromium's own MediaRecorder writes this shape, and so does any DASH
 * packager producing single-file representations, which is why the reader cannot
 * assume the progressive layout.
 */
async function readFragmentedSamples(
  blob: Blob,
  moofs: BoxHeader[],
  trex: Map<number, TrexDefaults>,
): Promise<Map<number, Mp4Sample[]>> {
  const byTrack = new Map<number, Mp4Sample[]>();
  for (const moof of moofs) {
    const bytes = new Uint8Array(await blob.slice(moof.start, moof.end).arrayBuffer());
    // Offsets inside this copy are relative to the moof's own start.
    const base = moof.start;
    for (const traf of children(bytes, moof.bodyStart - base, bytes.byteLength).filter((b) => b.type === 'traf')) {
      const trafChildren = children(bytes, traf.bodyStart, traf.end);
      const tfhdBox = find(trafChildren, 'tfhd');
      if (!tfhdBox) continue;
      const tfhd = new Cursor(bytes.subarray(tfhdBox.bodyStart, tfhdBox.end));
      tfhd.skip(1);
      const tfhdFlags = (tfhd.u8() << 16) | (tfhd.u8() << 8) | tfhd.u8();
      const trackId = tfhd.u32();
      const defaults = trex.get(trackId) ?? { duration: 0, size: 0, flags: 0 };
      let baseOffset = moof.start;
      if (tfhdFlags & 0x000001) baseOffset = tfhd.u64();
      if (tfhdFlags & 0x000002) tfhd.u32(); // sample_description_index
      const defaultDuration = tfhdFlags & 0x000008 ? tfhd.u32() : defaults.duration;
      const defaultSize = tfhdFlags & 0x000010 ? tfhd.u32() : defaults.size;
      const defaultFlags = tfhdFlags & 0x000020 ? tfhd.u32() : defaults.flags;

      const samples = byTrack.get(trackId) ?? [];
      for (const trunBox of trafChildren.filter((b) => b.type === 'trun')) {
        const trun = new Cursor(bytes.subarray(trunBox.bodyStart, trunBox.end));
        const version = trun.u8();
        const flags = (trun.u8() << 16) | (trun.u8() << 8) | trun.u8();
        const count = trun.u32();
        // data_offset is relative to baseOffset, and signed.
        let at = baseOffset + (flags & 0x000001 ? trun.i32() : 0);
        const firstFlags = flags & 0x000004 ? trun.u32() : undefined;
        for (let i = 0; i < count; i++) {
          const duration = flags & 0x000100 ? trun.u32() : defaultDuration;
          const size = flags & 0x000200 ? trun.u32() : defaultSize;
          const sampleFlags = flags & 0x000400 ? trun.u32() : i === 0 && firstFlags != null ? firstFlags : defaultFlags;
          const cts = flags & 0x000800 ? (version === 1 ? trun.i32() : trun.u32()) : 0;
          samples.push({
            offset: at,
            size,
            duration,
            cts,
            // Bit 16 of sample_flags is sample_is_non_sync_sample.
            sync: ((sampleFlags >> 16) & 1) === 0,
          });
          at += size;
        }
      }
      byTrack.set(trackId, samples);
    }
  }
  return byTrack;
}

/** Every video/audio track in an MP4. The remux path only ever wants the first
 *  one (each DASH representation is single-track), but the test suite reads its
 *  own OUTPUT back, which has two. */
export async function parseTracks(blob: Blob): Promise<Mp4Track[]> {
  const top = await topLevelBoxes(blob);
  const moovBox = find(top, 'moov');
  if (!moovBox) throw new Error('Not an MP4: no moov box.');
  const moov = new Uint8Array(await blob.slice(moovBox.start, moovBox.end).arrayBuffer());
  // Re-walk inside the copy, where offsets are relative to the moov box itself.
  const moovChildren = children(moov, moovBox.bodyStart - moovBox.start, moov.byteLength);
  const traks = moovChildren.filter((b) => b.type === 'trak');
  if (traks.length === 0) throw new Error('This MP4 has no track.');

  // Fragment defaults, and the fragment samples themselves when this is an fMP4.
  const trex = new Map<number, TrexDefaults>();
  const mvex = find(moovChildren, 'mvex');
  if (mvex) {
    for (const box of children(moov, mvex.bodyStart, mvex.end).filter((b) => b.type === 'trex')) {
      const c = new Cursor(moov.subarray(box.bodyStart, box.end));
      c.skip(4);
      const id = c.u32();
      c.u32(); // default_sample_description_index
      trex.set(id, { duration: c.u32(), size: c.u32(), flags: c.u32() });
    }
  }
  const moofs = top.filter((b) => b.type === 'moof');
  const fragmentSamples = moofs.length > 0 ? await readFragmentedSamples(blob, moofs, trex) : undefined;

  const found: Mp4Track[] = [];
  for (const trak of traks) {
    const trakChildren = children(moov, trak.bodyStart, trak.end);
    const tkhd = find(trakChildren, 'tkhd');
    const mdia = find(trakChildren, 'mdia');
    if (!mdia) continue;
    const mdiaChildren = children(moov, mdia.bodyStart, mdia.end);
    const mdhd = find(mdiaChildren, 'mdhd');
    const hdlr = find(mdiaChildren, 'hdlr');
    const minf = find(mdiaChildren, 'minf');
    if (!mdhd || !hdlr || !minf) continue;

    const handler = fourcc(moov, hdlr.bodyStart + 8);
    const kind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : undefined;
    if (!kind) continue;

    const mh = new Cursor(moov.subarray(mdhd.bodyStart, mdhd.end));
    const version = mh.u8();
    mh.skip(3);
    if (version === 1) {
      mh.skip(16);
    } else {
      mh.skip(8);
    }
    const timescale = mh.u32();
    if (version === 1) mh.u64();
    else mh.u32();
    const language = mh.u16();

    // tkhd, field by field — an off-by-four here silently reads height as width.
    let width = 0;
    let height = 0;
    let trackId = 0;
    if (tkhd) {
      const th = new Cursor(moov.subarray(tkhd.bodyStart, tkhd.end));
      const tv = th.u8();
      th.skip(3);
      th.skip(tv === 1 ? 16 : 8); // creation + modification time
      trackId = th.u32();
      th.skip(4); // reserved
      th.skip(tv === 1 ? 8 : 4); // duration — the writer computes its own
      th.skip(8 + 2 + 2 + 2 + 2); // reserved, layer, alternate group, volume, reserved
      th.skip(36); // display matrix
      width = th.u32();
      height = th.u32();
    }

    const minfChildren = children(moov, minf.bodyStart, minf.end);
    const stbl = find(minfChildren, 'stbl');
    if (!stbl) continue;
    const stsdBox = find(children(moov, stbl.bodyStart, stbl.end), 'stsd');
    if (!stsdBox) continue;

    // Progressive: the samples live in this stbl. Fragmented: the stbl is empty
    // and every moof's trun contributed to fragmentSamples.
    const fromStbl = readSampleTable(moov, stbl);
    const samples = fromStbl.length > 0 ? fromStbl : (fragmentSamples?.get(trackId) ?? []);
    if (samples.length === 0) {
      throw new Error(
        moofs.length > 0
          ? `Fragmented track ${trackId} has no samples in any moof.`
          : 'This track carries no samples.',
      );
    }

    const edtsBox = find(trakChildren, 'edts');
    found.push({
      kind,
      timescale,
      language,
      stsd: moov.slice(stsdBox.start, stsdBox.end),
      width,
      height,
      edts: edtsBox ? moov.slice(edtsBox.start, edtsBox.end) : undefined,
      samples,
    });
  }
  if (found.length === 0) throw new Error('This MP4 has no video or audio track.');

  // Every sample must lie inside the file. Blob.slice CLAMPS a range that runs past
  // the end instead of failing, so without this check a truncated track — the
  // documented failure when an fbcdn URL expires mid-fetch — produced a file whose
  // sample table pointed at bytes that were never written: corrupt output, reported
  // as a successful download. Fail loudly instead, with the same advice the mux
  // path already gives for a mismatched pair.
  for (const track of found) {
    for (const sample of track.samples) {
      if (sample.offset < 0 || sample.size < 0 || sample.offset + sample.size > blob.size) {
        throw new Error(
          `This ${track.kind} track is truncated: its sample table points past the end of the ` +
            `${blob.size}-byte file. An fbcdn URL may have expired mid-download — reload the Facebook page.`,
        );
      }
    }
  }
  return found;
}

/** The single track of a DASH representation. */
export async function parseTrack(blob: Blob): Promise<Mp4Track> {
  return (await parseTracks(blob))[0]!;
}

// ── Writing ─────────────────────────────────────────────────────────────────

function u8(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([n & 0xff]);
}
function u16(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}
function u32(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function zeros(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(n);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(parts);
  return concat([u32(body.byteLength + 8), TEXT.encode(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return box(type, u8(version), u8((flags >> 16) & 0xff), u8((flags >> 8) & 0xff), u8(flags & 0xff), ...parts);
}

/** Run-length encode per-sample values back into an stts/ctts style table. */
function runLengths(values: number[]): Uint8Array<ArrayBuffer> {
  const runs: Array<[count: number, value: number]> = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++;
    else runs.push([1, v]);
  }
  return concat([u32(runs.length), ...runs.flatMap(([count, value]) => [u32(count), u32(value)])]);
}

/** One contiguous run of samples from one source, written as one output chunk. */
interface Chunk {
  track: 0 | 1;
  /** Byte range in the SOURCE blob. */
  srcStart: number;
  srcEnd: number;
  sampleCount: number;
  /** Filled in once the header size is known. */
  outOffset: number;
}

const MOVIE_TIMESCALE = 1000;
/** Interleave granularity. Small enough that a player never has to seek far for
 *  the other track, large enough to keep the chunk tables short. */
const CHUNK_SECONDS = 0.5;

/**
 * Plan the output mdat: alternating runs of each track, in presentation order,
 * split wherever the source bytes stop being contiguous so each run is exactly
 * one Blob slice.
 */
function planChunks(tracks: [Mp4Track, Mp4Track], counts: [number, number]): Chunk[] {
  const chunks: Chunk[] = [];
  const next: [number, number] = [0, 0];
  const clock: [number, number] = [0, 0];

  const advance = (which: 0 | 1, untilSeconds: number): void => {
    const track = tracks[which];
    let i = next[which];
    while (i < counts[which]) {
      const start = i;
      let srcStart = track.samples[i]!.offset;
      let srcEnd = srcStart;
      // Grow the run while it stays contiguous in the source AND inside the slot.
      while (i < counts[which]) {
        const sample = track.samples[i]!;
        if (sample.offset !== srcEnd) break;
        if (i > start && clock[which] / track.timescale >= untilSeconds) break;
        srcEnd += sample.size;
        clock[which] += sample.duration;
        i++;
      }
      if (i === start) break; // defensive: never loop without progress
      chunks.push({ track: which, srcStart, srcEnd, sampleCount: i - start, outOffset: 0 });
      if (clock[which] / track.timescale >= untilSeconds) break;
    }
    next[which] = i;
  };

  let slot = CHUNK_SECONDS;
  while (next[0] < counts[0] || next[1] < counts[1]) {
    const before = [next[0], next[1]] as const;
    advance(0, slot);
    advance(1, slot);
    if (next[0] === before[0] && next[1] === before[1]) break;
    slot += CHUNK_SECONDS;
  }
  return chunks;
}

function trackBox(
  track: Mp4Track,
  trackId: number,
  which: 0 | 1,
  sampleCount: number,
  chunks: Chunk[],
  movieDuration: number,
): Uint8Array {
  const samples = track.samples.slice(0, sampleCount);
  const mediaDuration = samples.reduce((sum, s) => sum + s.duration, 0);

  const tkhd = fullBox(
    'tkhd',
    0,
    0x000003, // enabled | in movie
    u32(0),
    u32(0),
    u32(trackId),
    u32(0),
    u32(movieDuration),
    zeros(8),
    u16(0), // layer
    u16(0), // alternate group
    u16(track.kind === 'audio' ? 0x0100 : 0),
    u16(0),
    // Identity matrix.
    concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]),
    u32(track.width),
    u32(track.height),
  );

  const mdhd = fullBox('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(mediaDuration), u16(track.language), u16(0));
  const hdlr = fullBox(
    'hdlr',
    0,
    0,
    u32(0),
    TEXT.encode(track.kind === 'video' ? 'vide' : 'soun'),
    zeros(12),
    TEXT.encode(track.kind === 'video' ? 'VideoHandler\0' : 'SoundHandler\0'),
  );

  const stts = fullBox('stts', 0, 0, runLengths(samples.map((s) => s.duration)));
  const hasCts = samples.some((s) => s.cts !== 0);
  const ctts = hasCts ? fullBox('ctts', 0, 0, runLengths(samples.map((s) => s.cts))) : undefined;
  const syncIndexes = samples.flatMap((s, i) => (s.sync ? [i + 1] : []));
  // Only meaningful when some samples are NOT sync samples; a table listing every
  // sample is what "no stss" already means.
  const stss =
    syncIndexes.length > 0 && syncIndexes.length < samples.length
      ? fullBox('stss', 0, 0, u32(syncIndexes.length), ...syncIndexes.map(u32))
      : undefined;

  const own = chunks.filter((c) => c.track === which);
  const stscRuns: Array<[first: number, perChunk: number]> = [];
  own.forEach((chunk, index) => {
    const last = stscRuns[stscRuns.length - 1];
    if (!last || last[1] !== chunk.sampleCount) stscRuns.push([index + 1, chunk.sampleCount]);
  });
  const stsc = fullBox(
    'stsc',
    0,
    0,
    u32(stscRuns.length),
    ...stscRuns.flatMap(([first, per]) => [u32(first), u32(per), u32(1)]),
  );

  const uniform = samples.every((s) => s.size === samples[0]!.size);
  const stsz = uniform
    ? fullBox('stsz', 0, 0, u32(samples[0]!.size), u32(samples.length))
    : fullBox('stsz', 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.size)));

  const stco = fullBox('stco', 0, 0, u32(own.length), ...own.map((c) => u32(c.outOffset)));

  const stbl = box('stbl', track.stsd, stts, ...(ctts ? [ctts] : []), ...(stss ? [stss] : []), stsc, stsz, stco);
  const dinf = box('dinf', box('dref', concat([u32(0), u32(1), fullBox('url ', 0, 1)])));
  const minf = box(
    'minf',
    track.kind === 'video' ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : fullBox('smhd', 0, 0, u16(0), u16(0)),
    dinf,
    stbl,
  );
  const mdia = box('mdia', mdhd, hdlr, minf);
  // The source edit list is copied through: an audio track's elst carries the
  // encoder priming offset, and dropping it slides the whole track against the
  // video for the entire file.
  return box('trak', tkhd, ...(track.edts ? [track.edts] : []), mdia);
}

interface RemuxResult {
  blob: Blob;
  /** Output duration in seconds, after the shortest-track trim. */
  durationSec: number;
  /** Samples kept per track, for diagnostics. */
  kept: { video: number; audio: number };
}

/**
 * Merge a video-only and an audio-only MP4 into one file.
 *
 * Trims to the shorter track, the way `-c copy -shortest` did: without it the
 * file ends on either frozen video or silence, which is the reason that flag was
 * there in the first place (see ARCHITECTURE.md).
 */
export async function remux(video: Blob, audio: Blob): Promise<RemuxResult> {
  const [first, second] = await Promise.all([parseTrack(video), parseTrack(audio)]);
  const videoTrack = first.kind === 'video' ? first : second;
  const audioTrack = first.kind === 'video' ? second : first;
  if (videoTrack.kind !== 'video' || audioTrack.kind !== 'audio') {
    throw new Error('Expected one video track and one audio track; got two of the same kind.');
  }
  const blobs: [Blob, Blob] = first.kind === 'video' ? [video, audio] : [audio, video];

  const seconds = (t: Mp4Track): number => t.samples.reduce((sum, s) => sum + s.duration, 0) / t.timescale;
  const limit = Math.min(seconds(videoTrack), seconds(audioTrack));

  /** Samples whose presentation START is before the limit. */
  const keepCount = (t: Mp4Track): number => {
    let clock = 0;
    let count = 0;
    for (const sample of t.samples) {
      if (clock / t.timescale >= limit && count > 0) break;
      clock += sample.duration;
      count++;
    }
    return count;
  };
  const counts: [number, number] = [keepCount(videoTrack), keepCount(audioTrack)];

  const tracks: [Mp4Track, Mp4Track] = [videoTrack, audioTrack];
  const chunks = planChunks(tracks, counts);

  const mediaBytes = chunks.reduce((sum, c) => sum + (c.srcEnd - c.srcStart), 0);
  const movieDuration = Math.round(limit * MOVIE_TIMESCALE);

  const ftyp = box('ftyp', TEXT.encode('isom'), u32(0x200), TEXT.encode('isomiso2avc1mp41'));
  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(0),
    u32(0),
    u32(MOVIE_TIMESCALE),
    u32(movieDuration),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0),
    zeros(8),
    concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]),
    zeros(24), // predefined
    u32(3), // next track id
  );

  // Two passes: the chunk offsets depend on the header length, and the header
  // length does not depend on the offset VALUES (four bytes each either way), so
  // one measured rebuild is exact rather than iterative.
  const measure = (): number =>
    box(
      'moov',
      mvhd,
      trackBox(videoTrack, 1, 0, counts[0], chunks, movieDuration),
      trackBox(audioTrack, 2, 1, counts[1], chunks, movieDuration),
    ).byteLength;
  const mdatStart = ftyp.byteLength + measure() + 8;
  if (mdatStart + mediaBytes > 0xffffffff) {
    throw new Error('Merged output would exceed the 32-bit MP4 layout this writer emits.');
  }
  let at = mdatStart;
  for (const chunk of chunks) {
    chunk.outOffset = at;
    at += chunk.srcEnd - chunk.srcStart;
  }
  const moov = box(
    'moov',
    mvhd,
    trackBox(videoTrack, 1, 0, counts[0], chunks, movieDuration),
    trackBox(audioTrack, 2, 1, counts[1], chunks, movieDuration),
  );
  if (ftyp.byteLength + moov.byteLength + 8 !== mdatStart) {
    // Would mean the offsets were computed against a different header length.
    throw new Error('Internal remux error: header length changed between passes.');
  }

  // The media itself: Blob slices, never bytes in this process.
  const parts: BlobPart[] = [ftyp, moov, concat([u32(mediaBytes + 8), TEXT.encode('mdat')])];
  for (const chunk of chunks) parts.push(blobs[chunk.track].slice(chunk.srcStart, chunk.srcEnd));

  return {
    blob: new Blob(parts, { type: 'video/mp4' }),
    durationSec: limit,
    kept: { video: counts[0], audio: counts[1] },
  };
}
