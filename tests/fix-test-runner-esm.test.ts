// SWEEP-1: scripts/test.mjs bundles every tests/*.test.ts file with esbuild
// (format: 'esm') into a bare mkdtemp() directory, then runs `node --test` on
// the emitted .js bundles. That directory has no package.json, so a Node
// without syntax-based module detection resolves an extension-ambiguous .js
// as CommonJS and the bundle's own top-level `import` throws immediately —
// even though package.json declares `engines.node: >=18`. Node only guesses
// ESM-from-syntax by default from ~20.19/22.7 onward, newer than that floor,
// and CI pinning a newer Node hides the mismatch. This spawns the real
// scripts/test.mjs with that syntax-detection default switched off (the
// pre-20.19/22.7 behaviour) to prove its bundles still load.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();

// Guards against unbounded recursion: the spawned run below re-bundles every
// file under tests/, including this one, so without this guard the nested
// process would spawn a nested process of its own, forever.
const NESTED_GUARD = 'FACESCRAP_FIX_TEST_RUNNER_ESM_NESTED';

test(
  "scripts/test.mjs's bundles load as ESM even when Node cannot guess the module type from syntax (the pre-20.19/22.7 default this project's >=18 floor implies)",
  { skip: process.env[NESTED_GUARD] === '1' ? 'nested guard: this is the recursive re-run' : false },
  () => {
    // This test itself runs under `node --test`, which marks its own
    // environment (NODE_TEST_CONTEXT / NODE_TEST_WORKER_ID) so a nested
    // `node --test` invocation can detect reentrancy and no-ops instead of
    // actually running anything. Strip those before spawning below, or the
    // nested run below would silently "pass" without exercising scripts/test.mjs
    // at all — the exact false-negative this check exists to avoid.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    // Same flag real pre-20.19/22.7 Node behaves like: an ambiguous .js with
    // no "type": "module" package.json nearby is CommonJS, full stop.
    env.NODE_OPTIONS = [env.NODE_OPTIONS, '--no-experimental-detect-module'].filter(Boolean).join(' ');
    env[NESTED_GUARD] = '1';

    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'test.mjs')], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });

    assert.equal(result.error, undefined, `failed to launch the nested run: ${String(result.error)}`);
    assert.equal(
      result.status,
      0,
      `nested scripts/test.mjs run failed under --no-experimental-detect-module ` +
        `(this is exactly what a pre-20.19/22.7 Node — including the declared >=18 floor — does by ` +
        `default):\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  },
);
