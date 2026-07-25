// Repair for the round-3 review of the B2 (redundant page-hook.js injection)
// defect: repair-b1-hook-liveness.test.ts already covers the `alreadyHooked`
// DOM marker itself and proves the fetch/XHR patches are correctly guarded
// against a redundant second installation. The reviewer found that guard was
// NOT the whole story — history.pushState/replaceState (and the popstate
// listener that rides the same notifyNav()) and scanDocument() had NO
// alreadyHooked check at all, so a redundant second injection of
// page-hook.js into the same document (the declarative MAIN-world entry AND
// content.ts's runtime <script> fallback both installing — see
// content-recovery.ts's header comment for why that is a real, expected
// scenario, not a hypothetical):
//   (a) fires notifyNav() — a window.postMessage nav:true — once PER LAYER on
//       every real pushState/replaceState/popstate, and
//   (b) re-walks and re-parses every <script> tag in the document from
//       scratch, because scannedScripts (a WeakSet) and documentScanRunning
//       are fresh, empty, module-scope state in every separate evaluation of
//       page-hook.js — exactly the unbounded main-thread work this file
//       otherwise goes out of its way to bound (MAX_BODY_BYTES, yielding
//       every 32 script tags).
//
// page-hook.ts cannot be imported/executed under plain node --test (module
// eval patches window.fetch/XHR/history and calls document.querySelectorAll
// immediately — no window/document here); this file follows the same
// source-inspection + MODEL discipline as repair-b1-hook-liveness.test.ts
// and tests/pagehook-scan-fixes.test.ts: plain functions in this file model
// the real control flow, and every MODEL test is paired with a source-text
// assertion against the real file so the model cannot "pass regardless" of
// what page-hook.ts actually does.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const hookSource = readFileSync(join(ROOT, 'src', 'content', 'page-hook.ts'), 'utf8');

const GUARD_OPEN = 'if (!alreadyHooked) {';
const GUARD_CLOSE = '} // end: installation work gated to the first hook instance in this document';

// --- Structural assertions against the real file ---

test('page-hook.ts gates history/popstate/scanDocument installation behind ONE guard, not a per-effect check at each site', () => {
  const guardOpenIdx = hookSource.indexOf(GUARD_OPEN);
  const guardCloseIdx = hookSource.indexOf(GUARD_CLOSE);
  assert.ok(guardOpenIdx >= 0, 'must add a single alreadyHooked guard around the installation block');
  assert.ok(guardCloseIdx > guardOpenIdx, 'the guard must close after it opens, and the close marker must exist');

  // Exactly one guard of this shape. The fetch/XHR patches above keep their OWN,
  // already-correct, per-effect guards (asserted by repair-b1-hook-liveness.test.ts) —
  // this file must add exactly one MORE guard here, not resume the sprinkled
  // per-effect pattern that missed this whole block twice already.
  const guardOpenCount = hookSource.split(GUARD_OPEN).length - 1;
  assert.equal(guardOpenCount, 1, 'must be exactly one `if (!alreadyHooked) {` guard covering this whole block');

  const body = hookSource.slice(guardOpenIdx, guardCloseIdx);
  for (const mustContain of [
    "for (const name of ['pushState', 'replaceState'] as const) {",
    "history[name] = function (this: History, ...args: Parameters<typeof original>) {",
    "window.addEventListener('popstate', notifyNav);",
    'const scannedScripts = new WeakSet<Element>();',
    'let documentScanRunning = false;',
    'void scanDocument();',
    "window.addEventListener('load', () => {",
    'window.setTimeout(() => void scanDocument(), 2500);',
  ]) {
    assert.ok(body.includes(mustContain), `guarded block must contain: ${mustContain}`);
  }

  // The guard must not have swallowed the fetch/XHR patches too — those already have
  // their own correct, different guard shape and must stay exactly where they are,
  // before this one starts.
  for (const mustNotContain of ['window.fetch = function', 'XMLHttpRequest.prototype.open = function']) {
    assert.ok(!body.includes(mustNotContain), `guarded block must NOT also contain the fetch/XHR patches: ${mustNotContain}`);
  }
});

test('the diag-control channel and the pagehide flush listener stay OUTSIDE the new guard — reasoned exceptions, not blanket-disabled', () => {
  const messageListenerIdx = hookSource.indexOf("window.addEventListener('message', (e) => {");
  const queryIdx = hookSource.indexOf("window.postMessage({ __facescrapCtl: true, query: true }, '*');");
  const guardOpenIdx = hookSource.indexOf(GUARD_OPEN);
  const guardCloseIdx = hookSource.indexOf(GUARD_CLOSE);
  const pagehideIdx = hookSource.indexOf("window.addEventListener('pagehide', flushDiag);");

  assert.ok(
    messageListenerIdx >= 0 && queryIdx >= 0 && guardOpenIdx >= 0 && guardCloseIdx >= 0 && pagehideIdx >= 0,
    'all five markers must be present in page-hook.ts',
  );

  // The diag-control listener/query must stay unconditional: a redundant instance never
  // calls diagBump (every diagBump call site sits either inside the newly-guarded block or
  // behind the already-guarded fetch/XHR patches — see shared/diag.ts, where enabled/counters
  // are per-instance module state nothing outside this instance ever reads), so gating this
  // channel off would buy nothing. It would also cost something real: content.ts's own tests
  // (tests/b1-main-world-page-hook.test.ts) rely on this exact query being sent unconditionally,
  // "regardless of whether it was installed by the declarative MAIN-world entry or by
  // ensurePageHook()'s runtime fallback," to latch __facescrapHookInjected.
  assert.ok(
    messageListenerIdx < guardOpenIdx,
    'the diag-control message listener must be registered BEFORE the new guard, unconditionally in every instance',
  );
  assert.ok(
    queryIdx < guardOpenIdx,
    'the diag-control startup query must be sent BEFORE the new guard, unconditionally in every instance',
  );

  // The pagehide flush listener is harmless either way (diagDrain() is always empty in a
  // gated-off instance, for the same reason above), but keeping it outside the guard keeps the
  // guard scoped to the effects that actually duplicate observable work, rather than growing it
  // to cover everything just because it is nearby.
  assert.ok(
    pagehideIdx > guardCloseIdx,
    'the pagehide flushDiag listener must run AFTER the guard closes, unconditionally in every instance',
  );
});

// --- Model: the resources two module evaluations of page-hook.ts in the SAME document share ---
// (the DOM — including its <script> tags — window.history, and window itself). Real DOM/History
// objects do far more; the guarded logic under test only ever touches the members modeled here.
const HOOK_ATTR = 'data-facescrap-hook';

function makeSharedDocument(scriptCount: number) {
  const attrs = new Set<string>();
  const scripts = Array.from({ length: scriptCount }, (_, i) => ({
    id: i,
    textContent: `script ${i} payload mentioning fbcdn.net, padded well past forty characters`,
  }));
  return {
    documentElement: {
      hasAttribute: (name: string) => attrs.has(name),
      setAttribute: (name: string, _value: string) => {
        attrs.add(name);
      },
    },
    querySelectorAll: (_selector: 'script') => scripts,
  };
}
type SharedDocument = ReturnType<typeof makeSharedDocument>;

function makeSharedHistory() {
  const h: Record<string, (...args: unknown[]) => unknown> = {
    pushState: function nativePushState() {
      return undefined;
    },
    replaceState: function nativeReplaceState() {
      return undefined;
    },
  };
  return h;
}
type SharedHistory = ReturnType<typeof makeSharedHistory>;

function makeSharedWindow() {
  const listeners: Record<string, Array<() => void>> = {};
  const posted: unknown[] = [];
  return {
    addEventListener: (type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    },
    postMessage: (data: unknown) => {
      posted.push(data);
    },
    dispatch: (type: string) => {
      for (const fn of listeners[type] ?? []) fn();
    },
    posted,
  };
}
type SharedWindow = ReturnType<typeof makeSharedWindow>;

/** Mirrors page-hook.ts's own alreadyHooked computation (same shape as
 *  repair-b1-hook-liveness.test.ts's modelHookGuard, duplicated rather than imported so this
 *  file has no dependency on another lane's test file). */
function computeAlreadyHooked(doc: SharedDocument): boolean {
  const alreadyHooked = doc.documentElement.hasAttribute(HOOK_ATTR);
  if (!alreadyHooked) doc.documentElement.setAttribute(HOOK_ATTR, '1');
  return alreadyHooked;
}

/** Mirrors the FIXED shape of page-hook.ts's history/popstate/scanDocument section: everything
 *  sits behind one `if (!alreadyHooked)`, exactly like the real guard asserted above. `scanCount`
 *  is incremented once per <script> node actually read — the observable the scanDocument tests
 *  below care about. Three scanDocument calls per installation models the real module-eval /
 *  'load' / load+2500ms triggers. */
function installOneModuleEvaluation_FIXED(
  doc: SharedDocument,
  win: SharedWindow,
  hist: SharedHistory,
  scanCount: { n: number },
): void {
  const alreadyHooked = computeAlreadyHooked(doc);
  if (alreadyHooked) return; // mirrors: the rest of this function's body sits inside `if (!alreadyHooked) { ... }`

  function notifyNav(): void {
    win.postMessage({ __facescrap: true, nav: true });
  }
  for (const name of ['pushState', 'replaceState']) {
    const original = hist[name];
    hist[name] = function (...args: unknown[]) {
      const result = original.apply(hist, args);
      notifyNav();
      return result;
    };
  }
  win.addEventListener('popstate', notifyNav);

  const scannedScripts = new Set<unknown>();
  let documentScanRunning = false;
  function scanDocument(): void {
    if (documentScanRunning) return;
    documentScanRunning = true;
    try {
      for (const node of doc.querySelectorAll('script')) {
        if (!scannedScripts.has(node)) {
          scanCount.n += 1;
          scannedScripts.add(node);
        }
      }
    } finally {
      documentScanRunning = false;
    }
  }
  scanDocument(); // module eval
  scanDocument(); // 'load'
  scanDocument(); // load+2500ms
}

/** Mirrors the PRE-fix shape — no guard at all around history/popstate/scanDocument. Used only in
 *  the sanity-check test below, to prove this model is actually capable of reproducing the bug
 *  the round-3 review found (matching this project's convention of pairing every MODEL assertion
 *  with proof it is not vacuous), not merely asserting the fixed shape in a way that would "pass
 *  regardless" of what page-hook.ts actually does. */
function installOneModuleEvaluation_UNGUARDED(
  doc: SharedDocument,
  win: SharedWindow,
  hist: SharedHistory,
  scanCount: { n: number },
): void {
  function notifyNav(): void {
    win.postMessage({ __facescrap: true, nav: true });
  }
  for (const name of ['pushState', 'replaceState']) {
    const original = hist[name];
    hist[name] = function (...args: unknown[]) {
      const result = original.apply(hist, args);
      notifyNav();
      return result;
    };
  }
  win.addEventListener('popstate', notifyNav);

  const scannedScripts = new Set<unknown>(); // fresh per call, exactly like the real bug
  for (const node of doc.querySelectorAll('script')) {
    if (!scannedScripts.has(node)) {
      scanCount.n += 1;
      scannedScripts.add(node);
    }
  }
}

test('MODEL sanity check: the unguarded (pre-fix) shape really does duplicate nav notifications and re-walk every script — or the fixed-shape assertions below would prove nothing', () => {
  const win = makeSharedWindow();
  const hist = makeSharedHistory();
  const doc = makeSharedDocument(10);
  const scanCount = { n: 0 };

  installOneModuleEvaluation_UNGUARDED(doc, win, hist, scanCount);
  installOneModuleEvaluation_UNGUARDED(doc, win, hist, scanCount);

  hist.pushState();
  assert.equal(
    win.posted.length,
    2,
    'sanity check: two unguarded installations must double-notify a single real pushState() call',
  );
  assert.equal(
    scanCount.n,
    20,
    'sanity check: two unguarded installations must each re-walk all 10 scripts from scratch (20, not 10)',
  );
});

test('MODEL: two (or three) module evaluations against ONE shared document/window/history produce exactly one nav notification per real navigation, never one per installation', () => {
  const win = makeSharedWindow();
  const hist = makeSharedHistory();
  const doc = makeSharedDocument(0);
  const scanCount = { n: 0 };

  installOneModuleEvaluation_FIXED(doc, win, hist, scanCount); // e.g. the declarative MAIN-world entry
  installOneModuleEvaluation_FIXED(doc, win, hist, scanCount); // e.g. content.ts's runtime fallback, redundant
  installOneModuleEvaluation_FIXED(doc, win, hist, scanCount); // a third, equally redundant, injection

  hist.pushState();
  assert.equal(win.posted.length, 1, 'a single real pushState() call must fire exactly one nav notification');

  hist.replaceState();
  assert.equal(win.posted.length, 2, 'a single real replaceState() call must fire exactly one MORE nav notification');

  win.dispatch('popstate');
  assert.equal(
    win.posted.length,
    3,
    'a single real popstate event must fire exactly one MORE nav notification, not one per redundant listener',
  );
});

test('MODEL: two module evaluations against ONE shared document each read every <script> tag exactly once in total, never once per installation', () => {
  const win = makeSharedWindow();
  const hist = makeSharedHistory();
  const doc = makeSharedDocument(50);
  const scanCount = { n: 0 };

  installOneModuleEvaluation_FIXED(doc, win, hist, scanCount);
  installOneModuleEvaluation_FIXED(doc, win, hist, scanCount);

  assert.equal(
    scanCount.n,
    50,
    'each of the 50 <script> tags must be read exactly once total across both installations — not once per ' +
      'installation, which would block the main thread walking and parsing every embedded script twice over for ' +
      'no new data',
  );
});
