// SWEEP-1: scripts/test.mjs bundles every tests/*.test.ts file with esbuild
// (format: 'esm') into a bare mkdtemp() directory, then runs `node --test` on
// the emitted .js bundles. That directory has no package.json, so a Node
// without syntax-based module detection resolves an extension-ambiguous .js
// as CommonJS and the bundle's own top-level `import` throws immediately —
// even though package.json declares an `engines.node` floor older than the
// ~20.19/22.7 where Node started guessing ESM from syntax, and CI pinning a
// newer Node hides the mismatch. The runner answers that by writing a
// synthetic { "type": "module" } beside the bundles.
//
// This used to spawn scripts/test.mjs itself, which re-ran the WHOLE suite
// inside one of its own tests: twice the runtime, and any unrelated failure
// resurfaced here blaming ESM detection and buried the real one under the
// entire suite's stdout. It now reproduces a single bundle with the runner's
// options and runs `node --test` on that alone — and pins the two settings it
// reproduces against the runner's source, so the replica cannot drift away
// from what scripts/test.mjs actually does.
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
  "scripts/test.mjs's bundles load as ESM even when Node cannot guess the module type from syntax (the pre-20.19/22.7 default this project's engines floor implies)",
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
        target: 'node20',
        sourcemap: 'inline',
        logLevel: 'silent',
      });

      // This test itself runs under `node --test`, which marks its own
      // environment (NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID) so a nested
      // `node --test` detects reentrancy and no-ops instead of running
      // anything. Strip those, or the child below would silently "pass"
      // without ever loading the bundle — the false negative this exists to
      // avoid.
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      delete env.NODE_TEST_WORKER_ID;

      // Same behaviour real pre-20.19/22.7 Node has: an ambiguous .js with no
      // "type": "module" package.json nearby is CommonJS, full stop.
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
          `--no-experimental-detect-module (what a pre-20.19/22.7 Node — including the declared engines ` +
          `floor — does by default):\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
