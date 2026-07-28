// Guards the size budget: ~806 KB unpacked, all of it built from src/. It was 32.7 MB
// while it carried an ffmpeg core to run one merge, so the rule is one vendored binary
// away from breaking. The remuxer's own correctness lives in fix-mp4-remux.test.ts.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

test('ships no runtime dependency at all', () => {
  // The whole budget is this one rule: nothing in src/ may pull in a package. (The
  // devDependency list is deliberately NOT pinned — it never reaches dist/, so pinning
  // it only breaks on tooling bumps.)
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'dependencies must stay empty');
});

const DIST = join(ROOT, 'dist');
// Headroom over today's ~806 KB, and still thirty times under the 32.7 MB the
// ffmpeg era cost. A tripwire for a vendored binary coming back, not a
// byte-level ratchet every esbuild bump has to renegotiate.
const MAX_UNPACKED_BYTES = 1_048_576;

function unpackedBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // Chrome writes _metadata/ into an unpacked extension when it loads one.
    // The build never emits it, so it is not part of what ships.
    if (entry.name === '_metadata') continue;
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? unpackedBytes(full) : statSync(full).size;
  }
  return total;
}

test(
  'the unpacked build stays inside that budget',
  { skip: existsSync(DIST) ? false : 'dist/ is not built here — nothing to weigh' },
  () => {
    const bytes = unpackedBytes(DIST);
    assert.ok(
      bytes <= MAX_UNPACKED_BYTES,
      `dist/ is ${Math.round(bytes / 1024)} KB, past the ${MAX_UNPACKED_BYTES / 1024} KB ceiling`,
    );
  },
);

test('no ffmpeg or wasm remains in the extension, its build or its docs', () => {
  for (const file of [
    'scripts/build.mjs',
    'src/offscreen/offscreen.html',
    'src/background/service-worker.ts',
    'manifest.json',
    'docs/flow.svg',
    'docs/flow.es.svg',
  ]) {
    const source = read(...file.split('/'));
    // Comments in offscreen.ts and mp4-remux.ts still explain what was replaced and
    // why, and both READMEs say outright that there is no bundled ffmpeg — those are
    // the only places the name may appear. The two diagrams are on this list because
    // they went on describing a merge this extension stopped doing.
    assert.doesNotMatch(source, /ffmpeg/i, `${file} still names ffmpeg`);
  }
  // Nothing is loaded into the offscreen page but our own bundle.
  const html = read('src', 'offscreen', 'offscreen.html');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['offscreen.js']);
  // And with no wasm, the CSP no longer needs to allow compiling any.
  const manifest = JSON.parse(read('manifest.json')) as {
    content_security_policy?: { extension_pages?: string };
  };
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  assert.doesNotMatch(csp, /wasm-unsafe-eval/, 'the wasm privilege must be dropped with the wasm');
  assert.match(csp, /script-src 'self'/, 'scripts still self-only');
});

test('keeps the output-size limit on the merge', () => {
  // Two import/call-site mirrors were dropped from here: the remuxer's own suite
  // proves it works, and "offscreen.ts calls it" is not something a regex should be
  // asserting. This limit is different — it is the only guard against publishing a
  // blob URL for something larger than the two tracks that went in.
  assert.match(read('src', 'offscreen', 'offscreen.ts'), /merged\.blob\.size > MAX_DASH_OUTPUT_BYTES/);
});

test('the remuxer never reads sample bytes into memory', () => {
  const remuxer = read('src', 'shared', 'mp4-remux.ts');
  // The whole memory argument for dropping ffmpeg rests on this: the output is
  // Blob slices of the inputs. An arrayBuffer() over a track would quietly
  // reintroduce the heap cost a 500 MB reel used to pay.
  assert.match(remuxer, /blobs\[chunk\.track\]\.slice\(chunk\.srcStart, chunk\.srcEnd\)/);
  // Banning arrayBuffer() outright would be a lie: the reader has to pull the
  // metadata boxes in to find where the samples are. What must never be read is
  // a SAMPLE range — so pin every call site instead of forbidding the call. The
  // old form sliced the file at `export async function remux(`, which sits near
  // the bottom, so it covered none of the three reads below.
  const HEADER_READS = [
    'at, Math.min(at + 16, blob.size)', // the 16-byte box head
    'moof.start, moof.end',
    'moovBox.start, moovBox.end',
  ];
  assert.deepEqual(
    [...remuxer.matchAll(/\.slice\((.*?)\)\.arrayBuffer\(\)/g)].map((m) => m[1]),
    HEADER_READS,
    'every arrayBuffer() must read a box header, never a sample range',
  );
  assert.equal(
    (remuxer.match(/\.arrayBuffer\(\)/g) ?? []).length,
    HEADER_READS.length,
    'an arrayBuffer() here reads something that is not one of the box headers above',
  );
});
