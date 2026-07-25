import * as esbuild from 'esbuild';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');

const entries = (await readdir(TESTS))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => `tests/${name}`);

if (entries.length === 0) {
  throw new Error('No tests found in tests/*.test.ts');
}

const OUT = await mkdtemp(join(tmpdir(), 'facescrap-tests-'));

try {
  // esbuild emits plain .js files here with no package.json alongside them.
  // Node only parses an extension-ambiguous .js as ESM (letting these bundles'
  // top-level `import`s work) if it either finds a "type": "module" in the
  // nearest package.json or falls back to syntax-based detection — and that
  // detection default is itself version-gated (Node >=20.19/22.7), newer than
  // this project's declared `engines.node: >=18` floor. Declaring the type
  // here keeps the bundles loadable as ESM on every supported Node version,
  // not just ones new enough to guess right.
  await writeFile(join(OUT, 'package.json'), JSON.stringify({ type: 'module' }));

  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: entries,
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: 'inline',
    logLevel: 'silent',
  });

  const bundles = (await readdir(OUT))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join(OUT, name));
  const result = spawnSync(process.execPath, ['--test', ...bundles], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  // A launch failure leaves status null and the reason only in result.error;
  // with inherited stdio there is no child output, so throwing is the only
  // way this run reports anything at all.
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(OUT, { recursive: true, force: true });
}
