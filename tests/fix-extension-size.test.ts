// Guards the size budget: ~600 KB unpacked, all of it built from src/. It was 32.7 MB
// while it carried an ffmpeg core to run one merge, so the rule is one vendored binary
// away from breaking. The remuxer's own correctness lives in fix-mp4-remux.test.ts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('no ffmpeg or wasm remains in the extension or its build', () => {
  for (const file of [
    'scripts/build.mjs',
    'src/offscreen/offscreen.html',
    'src/background/service-worker.ts',
    'manifest.json',
  ]) {
    const source = read(...file.split('/'));
    // Comments in offscreen.ts and mp4-remux.ts still explain what was replaced and
    // why, which is worth keeping; these four files must carry no live reference.
    assert.doesNotMatch(source, /ffmpeg-core|FFmpegWASM|assets\/ffmpeg/, `${file} still wires up ffmpeg`);
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
  const body = remuxer.slice(remuxer.indexOf('export async function remux('));
  assert.doesNotMatch(body, /\.arrayBuffer\(\)/, 'remux must not pull any track into an ArrayBuffer');
});
