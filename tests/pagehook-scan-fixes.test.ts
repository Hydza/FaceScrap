import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// page-hook.ts patches window.fetch/XHR/history and calls document.querySelectorAll
// at module-eval time — it cannot be safely imported under plain node --test (no
// window/document). Follow the same source-inspection pattern already used for
// this file by tests/image-dimensions-contract.test.ts and
// tests/detection-migration-guardrails.test.ts.
const ROOT = process.cwd();
const hook = readFileSync(join(ROOT, 'src', 'content', 'page-hook.ts'), 'utf8');

test('processScan runs the structured JSON pass before the raw-text regex/manifest fallbacks, through a deduping collector', () => {
  const idxStructured = hook.indexOf("for (const line of text.split('\\n'))");
  const idxRegexFallback = hook.indexOf('for (const url of extractUrlsByKey(text))');
  const idxManifestFallback = hook.indexOf('for (const raw of extractStringsByKey(text))');
  assert.ok(idxStructured >= 0, 'structured JSON line-parse loop not found');
  assert.ok(idxRegexFallback >= 0, 'regex fallback loop not found');
  assert.ok(idxManifestFallback >= 0, 'manifest fallback loop not found');
  // The structured pass captures the richer item (poster, story id); reverting
  // to regex-then-manifest-then-structured would let the poorer fallback item
  // win the dedupe race below instead.
  assert.ok(
    idxStructured < idxRegexFallback,
    'the structured JSON pass must run before the regex fallback so its richer item is captured first',
  );
  assert.ok(
    idxStructured < idxManifestFallback,
    'the structured JSON pass must run before the manifest fallback so its richer item is captured first',
  );

  // processScan must hand every pass a collector that drops an id already added
  // this scan, not the bare BoundedCollector (which has no dedupe of its own).
  assert.match(
    hook,
    /const out = dedupeCollector\(\s*createBoundedCollector<MediaItem>\(\{/,
    'processScan must wrap its collector with dedupeCollector',
  );
  assert.match(
    hook,
    /add\(item: MediaItem\): boolean \{\s*if \(seen\.has\(item\.id\)\) return false;\s*seen\.add\(item\.id\);\s*return out\.add\(item\);/,
    'dedupeCollector must reject an id already seen this scan before delegating to the inner collector',
  );
});

test('the fetch and XHR intercepts capture the capture surface at request-issue time, not response-arrival time', () => {
  const fetchPatch = hook.slice(hook.indexOf('// --- Patch fetch ---'), hook.indexOf('// --- Patch XHR ---'));
  const xhrPatch = hook.slice(
    hook.indexOf('// --- Patch XHR ---'),
    hook.indexOf('// --- Tell the content script when the SPA navigates ---'),
  );
  assert.ok(fetchPatch.length > 0 && xhrPatch.length > 0, 'fetch/XHR patch sections not found');

  // Fetch: pageSource() must run synchronously in the intercept (request-issue
  // time), BEFORE the response promise is awaited, and the captured value must
  // ride through to scanText — not be recomputed once the body finishes
  // streaming (that was the ".then(scanText)" bug: scanText itself used to call
  // pageSource() at drain time).
  const sourceCaptureIdx = fetchPatch.indexOf('const source = pageSource();');
  const responseThenIdx = fetchPatch.indexOf('p.then(async (res) =>');
  assert.ok(sourceCaptureIdx >= 0, 'fetch patch must capture pageSource() synchronously');
  assert.ok(sourceCaptureIdx < responseThenIdx, 'the surface must be captured before the response is awaited');
  assert.match(fetchPatch, /\.then\(\(text\) => scanText\(text, source\)\)/);
  assert.doesNotMatch(fetchPatch, /\.then\(scanText\)/);

  // XHR: the surface must be stashed on the instance inside open() (issue time),
  // mirroring how __facescrapUrl is refreshed on every open(), and the load
  // listener must read that stashed value rather than compute a fresh one.
  assert.match(xhrPatch, /self\.__facescrapSource = pageSource\(\);/);
  assert.match(xhrPatch, /scanText\(this\.responseText, this\.__facescrapSource/);
  assert.doesNotMatch(xhrPatch, /scanText\(this\.responseText\);/);
});

test('scanText takes the pre-captured surface as a parameter instead of recomputing it when the job is enqueued', () => {
  assert.match(hook, /function scanText\(text: string, source: MediaSource, keep = false\): void \{/);
  assert.match(hook, /scanQueue\.push\(\{ text, source, keep \}\);/);
  // The old bug: scanText computed the surface itself at push time, which is
  // already too late for a request that was issued on a previous surface.
  assert.doesNotMatch(hook, /scanQueue\.push\(\{ text, source: pageSource\(\), keep \}\);/);
  // The document-scan call site must also pass its (now explicit) source.
  assert.match(hook, /if \(text\) scanText\(text, pageSource\(\), true\);/);
});

test('scanDocument does not re-collect a <script> node it already inspected on an earlier of its three passes', () => {
  assert.match(
    hook,
    /const scannedScripts = new WeakSet<Element>\(\);/,
    'scanDocument needs a persistent already-scanned set spanning its module-eval/load/load+2500ms calls',
  );

  const loopStart = hook.indexOf("const scripts = document.querySelectorAll('script');");
  const loopEnd = hook.indexOf('const text = budget.value();');
  assert.ok(loopStart >= 0 && loopEnd > loopStart, 'scanDocument script loop not found');
  const loopBody = hook.slice(loopStart, loopEnd);

  assert.match(
    loopBody,
    /if \(!scannedScripts\.has\(node\)\) \{/,
    'each script node must be skipped once already recorded as scanned',
  );
  const capBreakIdx = loopBody.indexOf('break; // cap hit');
  const markScannedIdx = loopBody.lastIndexOf('scannedScripts.add(node);');
  assert.ok(capBreakIdx >= 0 && markScannedIdx >= 0, 'cap-hit break and scanned-marking not found');
  assert.ok(
    capBreakIdx < markScannedIdx,
    'a node that hits the per-scan budget cap must be left UNMARKED (break exits before scannedScripts.add), ' +
      'so a later pass with a fresh budget can still capture it',
  );
});
