// Run one test bundle with the runner's ESM settings in an isolated directory.
// The synthetic package marker makes the emitted JavaScript unambiguously ESM.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();

const ENTRY = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "test('the bundle loaded as ESM', () => assert.ok(true));",
  '',
].join('\n');

test(
  "scripts/test.mjs's bundles load as ESM when syntax-based module detection is disabled",
  async () => {
    const runner = readFileSync(join(ROOT, 'scripts', 'test.mjs'), 'utf8');
    assert.match(runner, /format: 'esm',/, 'the runner no longer emits ESM — this check reproduces the wrong shape');
    assert.match(
      runner,
      /writeFile\(join\(OUT, 'package\.json'\), JSON\.stringify\(\{ type: 'module' \}\)\)/,
      'the synthetic package.json is what makes the bundles loadable below; the runner must still write it',
    );

    // esbuild cannot be imported statically from a test: this file is itself
    // bundled, and esbuild's lib finds its platform binary through require(),
    // which an ESM bundle rewrites into a stub that throws on load. Resolved
    // from the repo root and imported at runtime it stays out of the bundle.
    const resolved = createRequire(pathToFileURL(join(ROOT, 'package.json')).href).resolve('esbuild');
    const esbuild = (await import(pathToFileURL(resolved).href)) as typeof import('esbuild');

    const dir = await mkdtemp(join(tmpdir(), 'facescrap-esm-check-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      const entry = join(dir, 'esm-probe.ts');
      await writeFile(entry, ENTRY);
      await esbuild.build({
        absWorkingDir: ROOT,
        entryPoints: [entry],
        outdir: dir,
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node24',
        sourcemap: 'inline',
        logLevel: 'silent',
      });

      // Strip the parent test markers so the nested `node --test` process loads
      // and executes the bundle instead of treating the run as reentrant.
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_TEST_WORKER_ID;

      // Disable syntax-based detection so the test proves the nearby
      // "type": "module" declaration is sufficient on its own.
      const result = spawnSync(
        process.execPath,
        ['--test', '--no-experimental-detect-module', join(dir, 'esm-probe.js')],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 },
      );

      assert.equal(result.error, undefined, `failed to launch the nested run: ${String(result.error)}`);
      assert.equal(
        result.status,
        0,
        `an esbuild bundle emitted with the runner's options did not load under ` +
          `--no-experimental-detect-module:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
