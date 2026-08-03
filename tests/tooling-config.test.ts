import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

interface PackageManifest {
  version: string;
  packageManager: string;
  engines: { node: string };
  devDependencies: Record<string, string>;
}

interface LockRoot {
  version?: string;
  engines?: { node?: string };
  devDependencies?: Record<string, string>;
}

interface PackageLock {
  version: string;
  packages: Record<string, LockRoot>;
}

interface ExtensionManifest {
  version: string;
}

const ROOT = process.cwd();

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as T;
}

test('package, lockfile, manifest, and runtime configuration stay aligned', () => {
  const pkg = readJson<PackageManifest>('package.json');
  const lock = readJson<PackageLock>('package-lock.json');
  const manifest = readJson<ExtensionManifest>('manifest.json');
  const root = lock.packages[''];

  assert.ok(root, 'package-lock.json is missing its root package');
  assert.equal(lock.version, pkg.version);
  assert.equal(root.version, pkg.version);
  assert.equal(manifest.version, pkg.version);
  assert.equal(root.engines?.node, pkg.engines.node);
  assert.deepEqual(root.devDependencies, pkg.devDependencies);
  assert.match(pkg.packageManager, /^npm@\d+\.\d+\.\d+$/);
  assert.equal(readFileSync(join(ROOT, '.node-version'), 'utf8').trim(), '24.18.0');
});
