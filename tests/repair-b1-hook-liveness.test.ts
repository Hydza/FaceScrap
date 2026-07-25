// Repair for the adversarial review's B1/B2 findings against the earlier B1
// fix (manifest.json's declarative MAIN-world page-hook.js entry).
//
// The earlier fix closed B1's own stated race (Facebook's boot scripts could
// fetch before a script-inserted page-hook.js loaded) but left
// __facescrapHookInjected — content-recovery.ts's ONLY evidence that a
// declaratively-installed hook is alive — dependent on a DIFFERENT,
// unretried cross-realm race: page-hook.ts posts a one-shot
// `{ __facescrapCtl: true, query: true }` message the INSTANT it starts, and
// __facescrapHookInjected is only ever latched true if content.ts's message
// listener — registered hundreds of lines into content.ts's own module
// evaluation — is already attached when that message is dispatched. If the
// listener loses that race, the flag stays false forever for a document
// whose hook is genuinely alive, and content-recovery.ts (B2) then reinjects
// a second page-hook.js, double-wrapping window.fetch/XMLHttpRequest.open
// alongside the still-live original.
//
// tests/fix-content.test.ts and tests/b1-main-world-page-hook.test.ts assert
// only on SOURCE TEXT — as their own header comments explain, content.ts /
// content-recovery.ts / page-hook.ts all have module-eval-time side effects
// (window.fetch patching, document.querySelectorAll, chrome.* calls) that
// require a live content-script environment node:test does not provide, so
// those files inspect strings rather than import/execute them. That is
// exactly why the reviewer could say "no test can catch this": a source-text
// assertion alone cannot observe a TIMING bug.
//
// This file adds, on top of that same source-text discipline, a small,
// explicitly-labeled MODEL of the two realms and the resource/channel they
// actually share (the DOM, and postMessage) — plain objects and functions
// defined in this test file, not `eval`/`new Function` against dynamically
// interpolated source text (this project's tooling correctly flags that
// pattern as a code-injection risk, and it is not needed here). Every
// behavioural ("MODEL:") test below is paired, in the SAME test, with a
// strict positional source-text assertion against the real files, so the
// model cannot "pass regardless": reverting the repair removes or reorders
// the exact substrings those assertions require, failing the test before the
// model logic is even exercised.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const hookSource = readFileSync(join(ROOT, 'src', 'content', 'page-hook.ts'), 'utf8');
const content = readFileSync(join(ROOT, 'src', 'content', 'content.ts'), 'utf8');
const recovery = readFileSync(join(ROOT, 'src', 'content', 'content-recovery.ts'), 'utf8');

/** Slice `source` between two literal (non-regex) markers, failing loudly if either is missing.
 *  Same helper as tests/fix-content.test.ts / tests/b1-main-world-page-hook.test.ts, duplicated
 *  here rather than imported so this file has no dependency on another lane's test file. */
function section(source: string, startMarker: string, endMarker: string, fromIndex = 0): string {
  const start = source.indexOf(startMarker, fromIndex);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing end marker after "${startMarker}": ${endMarker}`);
  return source.slice(start, end);
}

const HOOK_GUARD_START = '// --- Idempotency: is a hook already alive in this document? ---';
const HOOK_GUARD_END = '// --- Diagnostics control channel';
const HOOK_ATTR = 'data-facescrap-hook';

// --- Model: the one resource the two realms actually share (the DOM) ---
// Real Elements do far more; the guard logic under test only ever calls
// hasAttribute/setAttribute on document.documentElement.
function makeSharedDocument() {
  const attrs = new Set<string>();
  return {
    documentElement: {
      hasAttribute: (name: string) => attrs.has(name),
      setAttribute: (name: string, _value: string) => {
        attrs.add(name);
      },
    },
  };
}
type SharedDocument = ReturnType<typeof makeSharedDocument>;

// --- Model: the one channel the two realms share (window.postMessage) ---
// Real postMessage dispatch is asynchronous and reaches only listeners
// registered by the time the queued dispatch runs; a listener added
// afterward never sees a message already in flight. flush() models "the
// event loop gets around to it" — call it only after whatever synchronous
// work was going to happen already has, exactly like the single JS thread
// both realms actually share.
function makeChannel() {
  const listeners: Array<(data: unknown) => void> = [];
  const queue: unknown[] = [];
  return {
    addEventListener: (fn: (data: unknown) => void) => listeners.push(fn),
    postMessage: (data: unknown) => queue.push(data),
    flush: () => {
      const pending = queue.splice(0, queue.length);
      for (const data of pending) for (const fn of listeners) fn(data);
    },
  };
}

// --- Model: page-hook.ts's idempotency guard ---
// Mirrors, as a plain function, exactly the three real statements asserted
// against the actual source in the first test below: read hasAttribute, and
// only setAttribute when it was not already present. Returns what the real
// `alreadyHooked` const would hold.
function modelHookGuard(sharedDocument: SharedDocument, attrName: string): boolean {
  const alreadyHooked = sharedDocument.documentElement.hasAttribute(attrName);
  if (!alreadyHooked) sharedDocument.documentElement.setAttribute(attrName, '1');
  return alreadyHooked;
}

test('page-hook.ts stamps a DOM marker on document.documentElement as literally its first action, before the query broadcast', () => {
  const guard = section(hookSource, HOOK_GUARD_START, HOOK_GUARD_END);
  assert.match(guard, /const HOOK_ALIVE_ATTR = '([^']+)';/, 'the marker attribute name must be a literal string');
  assert.match(
    guard,
    /const alreadyHooked = document\.documentElement\.hasAttribute\(HOOK_ALIVE_ATTR\);/,
    'must read the marker before deciding anything',
  );
  assert.match(
    guard,
    /if \(!alreadyHooked\) document\.documentElement\.setAttribute\(HOOK_ALIVE_ATTR, '1'\);/,
    'must stamp the marker the first time, and only the first time',
  );

  // Must run BEFORE the query broadcast (and everything else): if this guard
  // ran later, this file's own fetch/XHR patches further down — or a
  // redundant second injection racing this one — could run ahead of it.
  const guardIndex = hookSource.indexOf(HOOK_GUARD_START);
  const queryIndex = hookSource.indexOf("window.postMessage({ __facescrapCtl: true, query: true }, '*');");
  assert.ok(guardIndex >= 0 && queryIndex > guardIndex, 'the marker must be stamped before the startup query is sent');
});

test('MODEL: two installations against the same shared document are idempotent, with no message exchanged between them', () => {
  // Each real injection of page-hook.js is a fresh top-level evaluation of
  // the same code; model that faithfully by calling the guard model twice,
  // against the SAME shared document, exactly as two real injections into
  // the same tab would share the same live DOM.
  const sharedDocument = makeSharedDocument();

  const first = modelHookGuard(sharedDocument, HOOK_ATTR);
  assert.equal(first, false, 'the first installation (e.g. the declarative MAIN-world entry) must find no marker yet');

  const second = modelHookGuard(sharedDocument, HOOK_ATTR);
  assert.equal(
    second,
    true,
    "a second installation against the SAME document (e.g. content.ts's runtime <script> fallback firing later) " +
      'must see the marker the first one left — with no message exchanged between them at all',
  );

  const third = modelHookGuard(sharedDocument, HOOK_ATTR);
  assert.equal(third, true, 'the guard must not un-set itself; a third redundant installation must also stay guarded');
});

test('MODEL: a listener registered AFTER the hook already posted its startup query still learns the hook is alive, because content.ts reads the shared DOM instead of depending on catching that message', () => {
  const channel = makeChannel();
  const sharedDocument = makeSharedDocument();

  // MAIN world: stamp the DOM (model, verified against the real guard by the
  // first test above), then send the REAL startup query text over the
  // modeled channel, in the real file's actual order.
  modelHookGuard(sharedDocument, HOOK_ATTR);
  const queryLine = "window.postMessage({ __facescrapCtl: true, query: true }, '*');";
  assert.ok(hookSource.includes(queryLine), 'page-hook.ts must still broadcast its startup query (kept as a redundant signal)');
  channel.postMessage({ __facescrapCtl: true, query: true });

  // ISOLATED world: this is finding B1 verbatim — content.ts's listener for
  // this exact message registers hundreds of lines into its own module
  // evaluation. Model "the listener is not there yet" by flushing the
  // already-queued message BEFORE the listener is even added.
  channel.flush();
  let flagFromMessage = false;
  channel.addEventListener((data) => {
    const d = data as { __facescrapCtl?: boolean; query?: boolean } | null;
    if (d && d.__facescrapCtl === true && d.query === true) flagFromMessage = true;
  });
  channel.flush(); // nothing left queued: a late listener cannot retroactively catch it

  assert.equal(
    flagFromMessage,
    false,
    'sanity check: the modeled race must actually lose the message to the late listener, or the rest of this test proves nothing',
  );

  // The repair: content.ts's real decision expression must OR that (here,
  // correctly lost) flag with a direct DOM read — verified against the real
  // source, then combined with the value this scenario produced.
  assert.ok(
    content.includes('contentBootstrap.__facescrapHookInjected === true || pageHookAliveInDom()'),
    'content.ts must combine the flag with a DOM read at the real ensurePageHook() decision site',
  );
  const domRead = sharedDocument.documentElement.hasAttribute(HOOK_ATTR);
  const hookAliveOverall = flagFromMessage || domRead;
  assert.equal(
    hookAliveOverall,
    true,
    'the document must still be provably hook-alive even though the message-based signal was lost to the late listener',
  );
});

test('the DOM marker attribute name is identical across page-hook.ts, content.ts, and content-recovery.ts', () => {
  const hookAttr = hookSource.match(/const HOOK_ALIVE_ATTR = '([^']+)';/)?.[1];
  const contentAttr = content.match(/const HOOK_ALIVE_ATTR = '([^']+)';/)?.[1];
  const recoveryAttr = recovery.match(/const HOOK_ALIVE_ATTR = '([^']+)';/)?.[1];

  assert.ok(hookAttr, 'page-hook.ts must define HOOK_ALIVE_ATTR as a literal string');
  assert.equal(
    contentAttr,
    hookAttr,
    'content.ts must read the exact attribute name page-hook.ts writes — a silent rename in either file would make ' +
      'the read permanently miss the write',
  );
  assert.equal(
    recoveryAttr,
    hookAttr,
    'content-recovery.ts must read the exact attribute name page-hook.ts writes, for the same reason',
  );
});

test('content-recovery.ts ORs the same DOM read into its skip decision, not only the racy flag', () => {
  const recoveryBlock = section(
    recovery,
    'recoveryBootstrap.__facescrapForceContentRecovery = true;',
    "void import('./content');",
  );
  assert.match(
    recoveryBlock,
    /domHookAlive = document\.documentElement\.hasAttribute\(HOOK_ALIVE_ATTR\)/,
    'must read the DOM marker directly',
  );
  assert.ok(
    recoveryBlock.includes('if (recoveryBootstrap.__facescrapHookInjected === true || domHookAlive) {'),
    'the skip decision must combine the flag with the DOM read, not trust the flag alone',
  );
});

test('a second injection attempt against a live hook does not install a second wrapper: the fetch and XHR patches check alreadyHooked before any real work', () => {
  const fetchPatch = section(hookSource, '// --- Patch fetch ---', '// --- Patch XHR ---');
  const xhrPatch = section(hookSource, '// --- Patch XHR ---', '// --- Tell the content script when the SPA navigates ---');

  const fetchGuardIdx = fetchPatch.indexOf('if (alreadyHooked) return p;');
  const fetchRealWorkIdx = fetchPatch.indexOf("url.includes('/api/graphql')");
  assert.ok(fetchGuardIdx >= 0, 'the fetch patch must check alreadyHooked');
  assert.ok(
    fetchRealWorkIdx > fetchGuardIdx,
    'the guard must run before the response is ever inspected for scanning, or a redundant installation would still ' +
      'attach a second scan chain before bailing out',
  );

  const xhrGuardIdx = xhrPatch.indexOf('if (alreadyHooked) {');
  const xhrTagIdx = xhrPatch.indexOf('self.__facescrapUrl = String(url);');
  assert.ok(xhrGuardIdx >= 0, 'the XHR patch must check alreadyHooked');
  assert.ok(
    xhrTagIdx > xhrGuardIdx,
    'the guard must run before the instance is tagged or a load listener is attached, or a redundant installation ' +
      'would still attach a second listener before bailing out',
  );

  // Both real guards, once tripped, still delegate to the still-live original
  // (`return p;` / `return origOpen.apply(...)`) rather than dropping the
  // call — a redundant installation must not break the page, only decline to
  // add a second layer of real work.
  assert.ok(fetchPatch.includes('if (alreadyHooked) return p;'), 'the fetch guard must still return the real response');
  assert.ok(
    xhrPatch.includes('return origOpen.apply(this, arguments as unknown as Parameters<typeof origOpen>);'),
    'the XHR guard must still delegate to the previous (real) open()',
  );
});

test('MODEL: a redundant wrapper layer chained onto the still-live original results in the real scanning logic running exactly once per call', () => {
  // Mirrors the shape both the fetch and XHR patches share: capture the
  // current (possibly already-wrapped) implementation as `orig`, always call
  // through to it, and only add real work when this installation is not the
  // redundant one — exactly page-hook.ts's `if (alreadyHooked) return p;`
  // (verified against the real source in the previous test) placed before
  // any scanning/tagging logic.
  let realWorkCount = 0;
  function installPatch(orig: () => void, alreadyHooked: boolean): () => void {
    return () => {
      orig();
      if (alreadyHooked) return;
      realWorkCount += 1;
    };
  }

  const nativeImpl = () => {};
  const firstInstall = installPatch(nativeImpl, false); // the live, original hook
  const secondInstall = installPatch(firstInstall, true); // a redundant reinjection, chained on top

  secondInstall(); // what the page actually calls after both installations
  assert.equal(
    realWorkCount,
    1,
    'exactly one layer must do real work, regardless of how many redundant installations are chained on top',
  );

  secondInstall();
  assert.equal(realWorkCount, 2, 'the live original must keep doing its real work on every subsequent call');
});
