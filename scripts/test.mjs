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
  // Declare the module type so temporary bundles load consistently across supported Node versions.
  await writeFile(join(OUT, 'package.json'), JSON.stringify({ type: 'module' }));

  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: entries,
    outdir: OUT,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node24',
    sourcemap: 'inline',
    logLevel: 'silent',
  });

  const bundles = (await readdir(OUT))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join(OUT, name));
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=30000', ...bundles], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  // Surface launch failures because inherited stdio has no child output to inspect.
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(OUT, { recursive: true, force: true });
}
