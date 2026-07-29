// The MAIN-world hook reaches an already-open tab through chrome.scripting, from the
// worker — not through a <script src="chrome-extension://…/page-hook.js"> that the
// content script appends to facebook.com's own head.
//
// That fallback was the only caller web_accessible_resources ever had, and it put an
// extension-origin URL into the page: a node any page script watching <head> can see,
// and a URL it can then fetch to read the hook's entire source. On a project whose only
// declared threat is being ATTRIBUTED (ARCHITECTURE.md's first invariant), handing the
// page a copy of the code that reads its GraphQL is the worst leak available.
// chrome.scripting reads the file out of the package, so none of it is reachable from
// the page at all.
//
// service-worker.ts has no exports (see tests/fix-background-identity.test.ts's note on
// why), so this drives it the same way that file does: fake chrome.*, import the module
// for the listeners it registers as a side effect, fire onInstalled, watch what it
// injects.
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
/** What this fake page's <html> answers for HOOK_ALIVE_ATTR. */
let hookStamped = false;

// The probe is a function the worker SERIALIZES for Chrome to run in the page. Running
// it here against a stand-in <html> is what makes this a behaviour test instead of a
// regex over the worker's source: a probe reading some other attribute, or closing over
// a constant it cannot carry across the boundary, answers wrong below.
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
    // The recovery sweep asks for facebook tabs; gateAllTabs — the other onInstalled
    // listener — asks for every tab and must not be handed one to gate.
    query: async (q: { url?: string[] }) =>
      q.url ? [{ id: 7, url: 'https://www.facebook.com/reel/1' }] : [],
    get: async () => ({}),
    // No receiver. An already-open tab after an install or an update is exactly a tab
    // whose ping goes unanswered, which is what makes the sweep inject at all.
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
// No exports to bind — imported only for the chrome.* listeners it registers as a side
// effect, captured by the fake installed just above.
await import('../src/background/service-worker');

/** Drive one install/update sweep and let its awaits settle. */
async function sweep(reason: string, expected: number): Promise<FakeInjection[]> {
  injections = [];
  assert.ok(installedListeners.length > 0, 'runtime.onInstalled listener was not registered');
  for (const listener of installedListeners) listener({ reason });
  for (let tick = 0; tick < 200 && injections.length < expected; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // A few more turns, so a spurious EXTRA injection gets a chance to appear rather than
  // being outrun by the assertion below.
  for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 0));
  return injections;
}

test('a first install hooks an already-open tab from the package, never through a page URL', async () => {
  hookStamped = false;

  const done = await sweep('install', 3);

  // The whole target, not just the frame: only the OPENING move may aim at frame 0.
  // Neither declarative entry carries all_frames, so the hook has only ever run in the top
  // frame — but frame 0 follows the frame across a navigation, so once the first injection
  // has named a document, every later step is pinned to that document instead.
  assert.deepEqual(
    done.map((i) => ({ files: i.files, world: i.world, target: i.target })),
    [
      { files: ['content.js'], world: undefined, target: { tabId: 7, frameIds: [0] } },
      { files: undefined, world: undefined, target: { tabId: 7, documentIds: ['doc'] } }, // the probe
      { files: ['page-hook.js'], world: 'MAIN', target: { tabId: 7, documentIds: ['doc'] } },
    ],
    'the detector goes in first (its window-message listener must exist before the hook posts its ' +
      'one startup query), then the hook — MAIN world, from files:, with no URL anywhere in it, ' +
      'and both aimed at the document the detector actually landed in',
  );
  // The probe must read page-hook.ts's OWN stamp rather than a re-spelled copy:
  // executeScript serializes the function, so the constant has to travel as an argument.
  assert.deepEqual(done[1]?.args, [HOOK_ALIVE_ATTR]);
});

test('an update whose page hook survived does not stack a second one', async () => {
  // A MAIN-world hook is plain page JS: it outlives the update that invalidates every
  // chrome.* context around it. A second copy would install nothing on top of it —
  // tests/page-hook-idempotent.test.ts pins that — so this pins the cheaper half: the
  // probe answers from the DOM and the injection is never made at all.
  hookStamped = true;

  const done = await sweep('update', 2);

  assert.deepEqual(
    done.map((i) => i.files),
    [['content-recovery.js'], undefined],
    'the detector is replaced and the document is probed, and that is all',
  );
});
