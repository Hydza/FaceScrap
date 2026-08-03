// Keep the unpacked extension within budget and reject vendored runtime binaries.
// Remuxer correctness is covered by dedicated remuxer tests.

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
// Leave room for build-tool variance while catching large vendored binaries.
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
    // Check runtime configuration and architecture diagrams; source notes
    // and READMEs may mention ffmpeg for context.
    assert.doesNotMatch(source, /ffmpeg/i, `${file} still names ffmpeg`);
  }
  // Nothing is loaded into the offscreen page but our own bundle.
  const html = read('src', 'offscreen', 'offscreen.html');
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(scripts, ['offscreen.js']);
  // The CSP must not enable WebAssembly compilation.
  const manifest = JSON.parse(read('manifest.json')) as {
    content_security_policy?: { extension_pages?: string };
  };
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  assert.doesNotMatch(csp, /wasm-unsafe-eval/, 'the wasm privilege must be dropped with the wasm');
  assert.match(csp, /script-src 'self'/, 'scripts still self-only');
});

test('keeps the output-size limit on the merge', () => {
  // Reject output larger than the combined inputs before publishing its blob URL.
  assert.match(read('src', 'offscreen', 'offscreen.ts'), /merged\.blob\.size > MAX_DASH_OUTPUT_BYTES/);
});

test('the remuxer never reads sample bytes into memory', () => {
  const remuxer = read('src', 'shared', 'mp4-remux.ts');
  // Keep sample bytes as Blob slices so large tracks are not copied into memory.
  assert.match(remuxer, /blobs\[chunk\.track\]\.slice\(chunk\.srcStart, chunk\.srcEnd\)/);
  // Allow arrayBuffer only for the metadata ranges needed to locate samples.
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
