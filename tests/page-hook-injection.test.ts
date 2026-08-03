// Verify worker-owned MAIN-world injection without exposing the hook as a page resource.
// Import the worker against a runtime stub and capture its registered listeners.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { HOOK_ALIVE_ATTR } from '../src/shared/hook-attr';

interface FakeInjection {
  target: { tabId: number; frameIds?: number[]; documentIds?: string[] };
  files?: string[];
  world?: string;
  func?: (...args: string[]) => boolean;
  args?: string[];
}
type InstalledListener = (details: { reason: string }) => void;

const installedListeners: InstalledListener[] = [];
let injections: FakeInjection[] = [];
/** Return the hook stamp exposed by the fake document root. */
let hookStamped = false;

// Run the serialized probe against a stand-in document root.
function runInPage(injection: FakeInjection): unknown {
  if (!injection.func) return undefined;
  const scope = globalThis as unknown as { document?: unknown };
  const saved = scope.document;
  scope.document = {
    documentElement: { hasAttribute: (name: string) => name === HOOK_ALIVE_ATTR && hookStamped },
  };
  try {
    return injection.func(...(injection.args ?? []));
  } finally {
    if (saved === undefined) delete scope.document;
    else scope.document = saved;
  }
}

function installChromeFake(): void {
  const c = chrome as unknown as Record<string, unknown>;
  c.action = {
    disable: async () => {},
    enable: async () => {},
    setPopup: async () => {},
    setTitle: async () => {},
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
  };
  c.tabs = {
    // Return tabs only for the recovery sweep's Facebook query.
    query: async (q: { url?: string[] }) =>
      q.url ? [{ id: 7, url: 'https://www.facebook.com/reel/1' }] : [],
    get: async () => ({}),
    // An unanswered ping marks an open tab for recovery injection.
    sendMessage: async () => {
      throw new Error('Could not establish connection.');
    },
    onActivated: { addListener() {} },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} },
  };
  c.scripting = {
    executeScript: async (injection: FakeInjection) => {
      injections.push(injection);
      return [{ documentId: 'doc', frameId: 0, result: runInPage(injection) }];
    },
  };
  c.webRequest = { onBeforeRequest: { addListener() {} } };
  c.webNavigation = {
    onBeforeNavigate: { addListener() {} },
    onCommitted: { addListener() {} },
    onErrorOccurred: { addListener() {} },
  };
  c.runtime = {
    id: 'test-extension-id',
    getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    onInstalled: {
      addListener(fn: InstalledListener) {
        installedListeners.push(fn);
      },
    },
    onStartup: { addListener() {} },
    onConnect: { addListener() {} },
    onMessage: { addListener() {} },
    sendMessage: async () => undefined,
    getPlatformInfo: async () => ({}),
  };
}

await resetChromeStorage();
installChromeFake();
// Import the worker to register listeners against the runtime stub.
await import('../src/background/service-worker');

/** Run one installation sweep and settle its asynchronous work. */
async function sweep(reason: string, expected: number): Promise<FakeInjection[]> {
  injections = [];
  assert.ok(installedListeners.length > 0, 'runtime.onInstalled listener was not registered');
  for (const listener of installedListeners) listener({ reason });
  for (let tick = 0; tick < 200 && injections.length < expected; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // Allow any unexpected extra injection to complete before asserting.
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
  return injections;
}

test('a first install hooks an already-open tab from the package, never through a page URL', async () => {
  hookStamped = false;

  const done = await sweep('install', 3);

  // Pin later steps to the document identified by the initial top-frame injection.
  assert.deepEqual(
    done.map((i) => ({ files: i.files, world: i.world, target: i.target })),
    [
      { files: ['content.js'], world: undefined, target: { tabId: 7, frameIds: [0] } },
      { files: undefined, world: undefined, target: { tabId: 7, documentIds: ['doc'] } }, // Probe call.
      { files: ['page-hook.js'], world: 'MAIN', target: { tabId: 7, documentIds: ['doc'] } },
    ],
    'the detector goes in first (its window-message listener must exist before the hook posts its ' +
      'one startup query), then the hook — MAIN world, from files:, with no URL anywhere in it, ' +
      'and both aimed at the document the detector actually landed in',
  );
  // Pass the hook stamp explicitly across the serialized execution boundary.
  assert.deepEqual(done[1]?.args, [HOOK_ALIVE_ATTR]);
});

test('an update whose page hook survived does not stack a second one', async () => {
  // A live DOM stamp must prevent duplicate injection.
  hookStamped = true;

  const done = await sweep('update', 2);

  assert.deepEqual(
    done.map((i) => i.files),
    [['content-recovery.js'], undefined],
    'the detector is replaced and the document is probed, and that is all',
  );
});
