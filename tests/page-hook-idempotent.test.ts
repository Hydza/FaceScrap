// page-hook.js can be evaluated more than once in one document: manifest.json's
// declarative MAIN-world entry runs on every fresh navigation, and the worker injects the
// same file into tabs that were already open when the extension updated
// (background/content-script-recovery.ts). A MAIN-world hook is plain page JS, so it
// outlives the update that invalidates every chrome.* context around it — and the worker's
// probe can only ask the DOM whether one is alive, which is a question the page itself can
// answer wrong by deleting the stamp.
//
// So the file has to be genuinely idempotent rather than merely defensive. It used to be
// half of that: the guard covered the history patch and the document scan, but the
// assignments to window.fetch and XMLHttpRequest.prototype.open ran unconditionally (each
// wrapper checked the guard from INSIDE and passed through), and four window listeners sat
// outside it altogether. Every redundant evaluation left one more frame on the page's fetch
// and one more set of listeners, for the life of the tab — an unpacked reload loop stacks
// dozens.
//
// This runs the REAL bundle three times over one stand-in page: a source-text check would
// pass the moment someone re-spelled the guard, and the whole failure was that installed
// code sat outside a guard that looked right.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { HOOK_ALIVE_ATTR } from '../src/shared/hook-attr';

const ROOT = process.cwd();

/** The globals the hook reads, handed in by name — nothing here touches the real ones. */
const PAGE_GLOBALS = ['window', 'document', 'XMLHttpRequest', 'history', 'location', 'setTimeout', 'clearTimeout'];

type AnyFn = (...args: unknown[]) => unknown;
type Handler = (event: unknown) => void;

interface FakePage {
  window: { fetch: AnyFn; setTimeout: (fn: () => void) => number; clearTimeout: () => void };
  document: unknown;
  xhr: { prototype: { open: AnyFn } };
  history: { pushState: AnyFn; replaceState: AnyFn };
  location: unknown;
  /** Every window listener registered, in order, so an extra one is visible as an extra entry. */
  listeners: Array<{ type: string; fn: Handler }>;
  /** Everything posted onto the page's own message channel. */
  posted: unknown[];
  attributes: Map<string, string>;
  fetchCalls: unknown[][];
  openCalls: unknown[][];
  /** The page's own implementations, to tell "wrapped" from "untouched". */
  native: { fetch: AnyFn; open: AnyFn; pushState: AnyFn };
}

function createFakePage(): FakePage {
  const listeners: Array<{ type: string; fn: Handler }> = [];
  const posted: unknown[] = [];
  const attributes = new Map<string, string>();
  const fetchCalls: unknown[][] = [];
  const openCalls: unknown[][] = [];
  const scheduled: Array<() => void> = [];

  const nativeFetch: AnyFn = (...args) => {
    fetchCalls.push(args);
    return Promise.resolve({ ok: true });
  };
  const nativeOpen: AnyFn = (...args) => {
    openCalls.push(args);
    return undefined;
  };
  const nativePushState: AnyFn = () => undefined;

  const pageWindow = {
    fetch: nativeFetch,
    addEventListener(type: string, fn: Handler): void {
      listeners.push({ type, fn });
    },
    removeEventListener(): void {},
    postMessage(message: unknown): void {
      posted.push(message);
    },
    // Recorded, never fired: a timer that actually ran would let a scan drain after the
    // test that started it had finished.
    setTimeout: (fn: () => void): number => scheduled.push(fn),
    clearTimeout: (): void => {},
  };

  return {
    window: pageWindow,
    document: {
      documentElement: {
        hasAttribute: (name: string): boolean => attributes.has(name),
        setAttribute: (name: string, value: string): void => {
          attributes.set(name, value);
        },
      },
      // No <script> mentions fbcdn, so the document scan collects nothing and queues nothing.
      querySelectorAll: (): unknown[] => [],
    },
    xhr: { prototype: { open: nativeOpen } },
    history: { pushState: nativePushState, replaceState: () => undefined },
    location: { href: 'https://www.facebook.com/reel/1', pathname: '/reel/1', search: '' },
    listeners,
    posted,
    attributes,
    fetchCalls,
    openCalls,
    native: { fetch: nativeFetch, open: nativeOpen, pushState: nativePushState },
  };
}

// esbuild cannot be imported statically here: this file is itself bundled, and esbuild's
// lib finds its platform binary through require(), which an ESM bundle rewrites into a
// stub that throws on load (see tests/fix-test-runner-esm.test.ts).
const resolved = createRequire(pathToFileURL(join(ROOT, 'package.json')).href).resolve('esbuild');
const esbuild = (await import(pathToFileURL(resolved).href)) as typeof import('esbuild');
// The same shape scripts/build.mjs ships: one self-contained IIFE, evaluated by Chrome as
// a classic script with no module semantics of its own.
const built = await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: [join(ROOT, 'src', 'content', 'page-hook.ts')],
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  write: false,
  logLevel: 'silent',
});
const HOOK_BUNDLE = built.outputFiles[0]?.text ?? '';
const evaluateBundle = new Function(...PAGE_GLOBALS, HOOK_BUNDLE) as (...globals: unknown[]) => void;

/** One `executeScript({ files: ['page-hook.js'] })` into this document. */
function evaluateHook(page: FakePage): void {
  evaluateBundle(
    page.window,
    page.document,
    page.xhr,
    page.history,
    page.location,
    page.window.setTimeout,
    page.window.clearTimeout,
  );
}

test('a redundant evaluation leaves nothing behind: no second wrapper, no second listener', () => {
  const page = createFakePage();

  evaluateHook(page);

  const installed = {
    fetch: page.window.fetch,
    open: page.xhr.prototype.open,
    pushState: page.history.pushState,
    listeners: page.listeners.map((entry) => entry.type),
    posted: page.posted.length,
  };
  // The first evaluation must really install, or every assertion below would also pass on
  // a hook that hooks nothing at all — the one way to be idempotent that helps nobody.
  assert.notEqual(installed.fetch, page.native.fetch, 'the first evaluation must wrap the page fetch');
  assert.notEqual(installed.open, page.native.open, 'the first evaluation must wrap XMLHttpRequest.prototype.open');
  assert.notEqual(installed.pushState, page.native.pushState, 'the first evaluation must patch history.pushState');
  assert.deepEqual(
    [...installed.listeners].sort(),
    ['error', 'load', 'message', 'pagehide', 'popstate', 'unhandledrejection'],
    'the listeners the hook needs are the ones a redundant evaluation must not duplicate',
  );
  assert.equal(page.attributes.get(HOOK_ALIVE_ATTR), '1', 'the stamp is the only thing a second evaluation reads');

  // Twice more, because the case that hurt was a loop: an unpacked reload injects again on
  // every reload, into the same long-lived tab.
  evaluateHook(page);
  evaluateHook(page);

  assert.equal(
    page.window.fetch,
    installed.fetch,
    'window.fetch was wrapped again: every request the page makes now walks one more frame, ' +
      'and nothing ever unwinds it',
  );
  assert.equal(
    page.xhr.prototype.open,
    installed.open,
    'XMLHttpRequest.prototype.open was wrapped again — same stacking, on a prototype shared by every XHR',
  );
  assert.equal(page.history.pushState, installed.pushState, 'history.pushState was patched again');
  assert.deepEqual(
    page.listeners.map((entry) => entry.type),
    installed.listeners,
    'a redundant evaluation registered window listeners that will outlive it',
  );
  assert.equal(
    page.posted.length,
    installed.posted,
    'a redundant evaluation announced itself on the page\'s own message channel',
  );
  assert.equal(page.attributes.size, 1, 'and it stamped nothing new on <html>');
});

test('the wrapper that stayed still reaches the page\'s own fetch and XHR', async () => {
  const page = createFakePage();
  evaluateHook(page);
  evaluateHook(page);

  // Not /api/graphql: delegation is the property under test here, and a capture would
  // queue a scan whose drain this fake's inert timers never run.
  await page.window.fetch('https://www.facebook.com/ajax/bootloader');
  assert.deepEqual(page.fetchCalls, [['https://www.facebook.com/ajax/bootloader']]);

  const xhrListeners: string[] = [];
  const request = {
    addEventListener(type: string): void {
      xhrListeners.push(type);
    },
  };
  page.xhr.prototype.open.call(request, 'GET', 'https://www.facebook.com/api/graphql');
  page.xhr.prototype.open.call(request, 'GET', 'https://www.facebook.com/api/graphql');
  assert.deepEqual(xhrListeners, ['load'], 'one load listener per XHR, however often Facebook reopens it');
  assert.equal(page.openCalls.length, 2, "and both open() calls still reach the page's own implementation");
});
