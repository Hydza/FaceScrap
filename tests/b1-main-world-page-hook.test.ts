// Regression checks for finding B1: the MAIN-world page hook (page-hook.js)
// used to be installed only as a content.ts-inserted external <script> at
// document_start. Script-inserted external scripts are force-async, so
// Facebook's own parser-inserted boot scripts could run — and complete their
// earliest GraphQL fetches — before that <script> even loaded, let alone
// patched fetch/XHR. Those early responses carry exactly the media the hook
// exists to capture.
//
// The fix registers page-hook.js as a SECOND, declarative MAIN-world
// content_scripts entry in manifest.json: Chrome guarantees a document_start
// content script (in any world) runs before any other DOM is constructed or
// any other script runs, so this installs before the page ever gets a chance
// to fetch anything. content.ts's old unconditional runtime injection becomes
// a fallback, gated on document.readyState, for the one case the declarative
// entry cannot reach: an already-open tab the background force-recovers into
// (content-recovery.ts), whose document already finished loading before the
// background ever reached for it.
//
// manifest.json is real JSON and is exercised directly here. content.ts /
// content-recovery.ts require a live document/chrome content-script
// environment they never get under node:test (see tests/fix-content.test.ts's
// own note on this constraint), so — like that file and
// tests/detection-migration-guardrails.test.ts — the checks on them assert on
// the source text instead of executing it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

const content = readFileSync(join(ROOT, 'src', 'content', 'content.ts'), 'utf8');

/** Slice `source` between two literal (non-regex) markers, failing loudly if either is missing.
 *  Same helper as tests/fix-content.test.ts — duplicated here rather than imported so this
 *  file has no dependency on another lane's test file. */
function section(source: string, startMarker: string, endMarker: string, fromIndex = 0): string {
  const start = source.indexOf(startMarker, fromIndex);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing end marker after "${startMarker}": ${endMarker}`);
  return source.slice(start, end);
}

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

  // Declarative "world": "MAIN" on a static content_scripts entry needs
  // Chrome 111+. This project's own floor must stay at or above that, or the
  // entry above is silently ignored on the oldest browsers it still claims
  // to support, quietly reintroducing the exact race this fix closes.
  assert.ok(
    Number(manifest.minimum_chrome_version) >= 111,
    'minimum_chrome_version must support declarative MAIN-world content scripts (Chrome 111+)',
  );
});

test('page-hook.js stays web-accessible for the runtime fallback content.ts still needs', () => {
  const resource = manifest.web_accessible_resources?.find((entry) => entry.resources?.includes('page-hook.js'));
  assert.ok(
    resource,
    "content.ts's ensurePageHook() runtime fallback (still the only way to reach an already-open tab the " +
      'declarative entry cannot touch) loads page-hook.js via chrome.runtime.getURL() + a <script> element — ' +
      'removing this entry would make that fetch fail',
  );
  assert.ok(resource?.matches?.includes('*://*.facebook.com/*'));
});

test('ensurePageHook() defers to the declarative entry while the document is still loading', () => {
  const ensurePageHook = section(content, 'function ensurePageHook(): void {', '\nensurePageHook();');
  const shouldInjectIndex = ensurePageHook.indexOf(
    'shouldInjectPageHook(skipPageHookInjection, contentBootstrap.__facescrapHookInjected === true || pageHookAliveInDom())',
  );
  const readyStateIndex = ensurePageHook.indexOf("document.readyState === 'loading'");
  const createElementIndex = ensurePageHook.indexOf("document.createElement('script')");

  assert.ok(
    shouldInjectIndex >= 0,
    'the pre-existing skip/already-injected gate must still be present, and must now ALSO trust the DOM marker ' +
      '(pageHookAliveInDom()) rather than __facescrapHookInjected alone — see tests/repair-b1-hook-liveness.test.ts',
  );
  assert.ok(
    readyStateIndex > shouldInjectIndex,
    'the readyState gate must be checked after the existing skip/already-injected check',
  );
  assert.ok(
    readyStateIndex >= 0 && createElementIndex > readyStateIndex,
    'the readyState gate must run before the runtime <script> is ever created — otherwise a fresh, still-loading ' +
      'document (already covered by the declarative MAIN-world entry in manifest.json) gets a redundant second ' +
      'hook that double-patches fetch/XHR',
  );
  assert.ok(
    ensurePageHook.includes("if (document.readyState === 'loading') return;"),
    'must actually early-return while the document is still loading, not merely reference readyState',
  );
});

test('the query-message handler latches __facescrapHookInjected too, not only ensurePageHook()\'s onload', () => {
  // page-hook.js posts { __facescrapCtl: true, query: true } unconditionally, before doing
  // anything else, regardless of whether it was installed by the declarative MAIN-world entry
  // or by ensurePageHook()'s runtime fallback — so receiving it is itself proof a hook is alive
  // in this document. Bounded below by the sibling __facescrap block so a stray later match
  // elsewhere in the file cannot make this pass for the wrong reason.
  const queryBlockStart = content.indexOf(
    'if (data && data.__facescrapCtl === true && data.query === true) {',
  );
  assert.ok(queryBlockStart >= 0, 'missing the query-message handler this test targets');
  const nextBlockStart = content.indexOf('if (data && data.__facescrap === true) {', queryBlockStart);
  assert.ok(nextBlockStart > queryBlockStart, 'missing the sibling __facescrap block used as a search bound');

  const flagSetIndex = content.indexOf('contentBootstrap.__facescrapHookInjected = true;', queryBlockStart);
  const announceIndex = content.indexOf('announceDiagFlag();', queryBlockStart);

  assert.ok(
    flagSetIndex > queryBlockStart && flagSetIndex < nextBlockStart,
    "receiving page-hook.js's own startup query must latch the hook-alive flag inside this handler — otherwise a " +
      "hook installed declaratively (not through ensurePageHook()'s onload) is never recorded anywhere, and a " +
      'later update-recovery pass (content-recovery.ts) wrongly concludes no hook survives and injects a second ' +
      'one alongside the live declarative hook, double-patching fetch/XHR',
  );
  assert.ok(
    announceIndex > queryBlockStart && announceIndex < nextBlockStart,
    'the existing diag-flag reply must still happen for this same message',
  );
});
