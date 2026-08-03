// Repeated hook evaluation must preserve one fetch/XHR wrapper and one listener set.
// Run the real bundle three times to verify runtime idempotence.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { HOOK_ALIVE_ATTR } from '../src/shared/hook-attr';

const ROOT = process.cwd();

/** Provide isolated globals for the hook bundle. */
const PAGE_GLOBALS = ['window', 'document', 'XMLHttpRequest', 'history', 'location', 'setTimeout', 'clearTimeout'];

type AnyFn = (...args: unknown[]) => unknown;
type Handler = (event: unknown) => void;

interface FakePage {
  window: { fetch: AnyFn; setTimeout: (fn: () => void) => number; clearTimeout: () => void };
  document: unknown;
  xhr: { prototype: { open: AnyFn } };
  history: { pushState: AnyFn; replaceState: AnyFn };
  location: unknown;
  /** Record registered window listeners in order. */
  listeners: Array<{ type: string; fn: Handler }>;
  /** Record messages posted to the page channel. */
  posted: unknown[];
  /** Run every timer armed by the hook. */
  runScheduled(): void;
  attributes: Map<string, string>;
  fetchCalls: unknown[][];
  openCalls: unknown[][];
  /** Preserve the page's original implementations for identity checks. */
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
    // Record timers without running them automatically.
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
      // The fixture contains no script with a media host.
      querySelectorAll: (): unknown[] => [],
    },
    xhr: { prototype: { open: nativeOpen } },
    history: { pushState: nativePushState, replaceState: () => undefined },
    location: { href: 'https://www.facebook.com/reel/1', pathname: '/reel/1', search: '' },
    listeners,
    posted,
    runScheduled: (): void => {
      // Clear pending timers before running callbacks to prevent recursive draining.
      const due = scheduled.splice(0, scheduled.length);
      for (const fn of due) fn();
    },
    attributes,
    fetchCalls,
    openCalls,
    native: { fetch: nativeFetch, open: nativeOpen, pushState: nativePushState },
  };
}

// Load esbuild at runtime so the bundled test can resolve its platform binary.
const resolved = createRequire(pathToFileURL(join(ROOT, 'package.json')).href).resolve('esbuild');
const esbuild = (await import(pathToFileURL(resolved).href)) as typeof import('esbuild');
// Match the self-contained IIFE shipped by the build.
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

/** Evaluate one hook bundle in the fake document. */
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
  // Confirm that the first evaluation installs the hook.
  assert.notEqual(installed.fetch, page.native.fetch, 'the first evaluation must wrap the page fetch');
  assert.notEqual(installed.open, page.native.open, 'the first evaluation must wrap XMLHttpRequest.prototype.open');
  assert.notEqual(installed.pushState, page.native.pushState, 'the first evaluation must patch history.pushState');
  assert.deepEqual(
    [...installed.listeners].sort(),
    ['error', 'load', 'pagehide', 'popstate', 'unhandledrejection'],
    'the listeners the hook needs are the ones a redundant evaluation must not duplicate',
  );
  assert.equal(page.attributes.get(HOOK_ALIVE_ATTR), '1', 'the stamp is the only thing a second evaluation reads');

  // Repeat evaluation to verify idempotence in a long-lived document.
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
  // Drain deferred work to expose any duplicate flush scheduled by reevaluation.
  page.runScheduled();
  const announced = page.posted.filter((message) => (message as { __vpData?: unknown })?.__vpData === true);
  assert.equal(
    announced.length,
    1,
    'each evaluation announced itself on the page\'s own message channel — one flush per document, not per evaluation',
  );
  assert.equal(page.attributes.size, 1, 'and it stamped nothing new on <html>');
});

test('the wrapper that stayed still reaches the page\'s own fetch and XHR', async () => {
  const page = createFakePage();
  evaluateHook(page);
  evaluateHook(page);

  // Use a non-capture URL to isolate delegation behavior.
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
