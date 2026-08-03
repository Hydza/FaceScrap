import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

interface BrowserArguments {
  browserName: string;
}

interface BrowserQaHarness {
  parseArguments: (argv: string[]) => BrowserArguments;
  supportsRuntimeReloadRecovery: (browserName: string) => boolean;
}

test('browser QA never relies on branded Chrome for unpacked extension loading', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'sidepanel-visual-qa.mjs')).href;
  const harness = (await import(moduleUrl)) as Partial<BrowserQaHarness>;

  assert.equal(typeof harness.parseArguments, 'function', 'the browser policy must be testable without launching CDP');
  assert.equal(harness.parseArguments?.([]).browserName, 'cft');
  assert.throws(() => harness.parseArguments?.(['--browser=chrome']), /Chrome for Testing/);
});

test('temporary extension QA does not require browsers to re-register after runtime reload', async () => {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'sidepanel-visual-qa.mjs')).href;
  const harness = (await import(moduleUrl)) as Partial<BrowserQaHarness>;

  assert.equal(
    typeof harness.supportsRuntimeReloadRecovery,
    'function',
    'runtime reload support must be an explicit browser capability',
  );
  assert.equal(harness.supportsRuntimeReloadRecovery?.('cft'), false);
  assert.equal(harness.supportsRuntimeReloadRecovery?.('brave'), false);
});
