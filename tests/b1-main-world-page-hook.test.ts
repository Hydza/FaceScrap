// Install the declarative MAIN-world hook at document_start before page scripts run.
// Recovery injection covers documents that were already open after an update.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();

interface ManifestContentScript {
  matches?: string[];
  js?: string[];
  world?: string;
  run_at?: string;
}
interface ManifestWebAccessibleResource {
  resources?: string[];
  matches?: string[];
}
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')) as {
  minimum_chrome_version?: string;
  content_scripts?: ManifestContentScript[];
  web_accessible_resources?: ManifestWebAccessibleResource[];
};

test('manifest.json registers page-hook.js as a declarative MAIN-world, document_start content script', () => {
  assert.ok(Array.isArray(manifest.content_scripts), 'manifest.json must declare content_scripts');

  const hookEntry = manifest.content_scripts?.find((entry) => entry.js?.includes('page-hook.js'));
  assert.ok(
    hookEntry,
    'no content_scripts entry injects page-hook.js — the declarative MAIN-world registration is missing, so the ' +
      'hook is back to installing only as a late runtime <script>',
  );
  assert.equal(
    hookEntry?.world,
    'MAIN',
    "page-hook.js must run in the MAIN world — that's the whole point: it patches the PAGE's own fetch/XHR, which " +
      'an ISOLATED-world content script cannot reach',
  );
  assert.equal(
    hookEntry?.run_at,
    'document_start',
    'page-hook.js must install before any other script can run, or it can still lose the race it is meant to win',
  );
  assert.ok(
    hookEntry?.matches?.includes('*://*.facebook.com/*'),
    'the MAIN-world entry must match the same pattern as the ISOLATED content script',
  );

  const isolatedEntry = manifest.content_scripts?.find((entry) => entry.js?.includes('content.js'));
  assert.ok(isolatedEntry, 'content.js must still be declared as a content script');
  assert.notEqual(
    isolatedEntry?.world,
    'MAIN',
    'content.js must stay in the default ISOLATED world — it is the one that reads chrome.* APIs',
  );

  // Require the browser floor that supports declarative MAIN-world scripts.
  assert.ok(
    Number(manifest.minimum_chrome_version) >= 111,
    'minimum_chrome_version must support declarative MAIN-world content scripts (Chrome 111+)',
  );
});

test('page-hook.js is NOT web-accessible, and nothing builds a URL for it', () => {
  // Inspect complete entries because resource declarations may use globs.
  assert.equal(
    manifest.web_accessible_resources,
    undefined,
    'nothing may be web-accessible. That key had exactly one caller: a content-script ' +
      'fallback appending <script src="chrome-extension://…/page-hook.js"> to facebook.com. Any page ' +
      'script watching <head> sees that node, and the URL it carries is one the page may then fetch. ' +
      'The worker injects with chrome.scripting instead, which reads the file from the package and ' +
      'needs no web-accessible resource. This does NOT make the hook unattributable — the page still ' +
      'sees a non-native window.fetch, the __vp* postMessage traffic and the <html> stamp; it removes ' +
      'an extension-origin URL and a node of ours from the page, which is what this entry cost.',
  );
  // Verify that every content module is declared.
  for (const file of readdirSync(join(ROOT, 'src', 'content')).filter((name) => name.endsWith('.ts'))) {
    assert.doesNotMatch(
      readFileSync(join(ROOT, 'src', 'content', file), 'utf8'),
      /getURL\(\s*['"]page-hook\.js['"]\s*\)/,
      `${file} must never turn page-hook.js into a URL — the URL is what reaches the page`,
    );
  }
});
