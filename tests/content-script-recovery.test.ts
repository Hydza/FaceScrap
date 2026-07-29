import assert from 'node:assert/strict';
import test from 'node:test';

import { createContentScriptRecoveryCoordinator } from '../src/background/content-script-recovery';

function harness(liveTabs: ReadonlySet<number>, hookedTabs: ReadonlySet<number> = new Set()) {
  const pings: number[] = [];
  const injections: Array<{ tabId: number; file: string }> = [];
  const hooks: number[] = [];
  /** Both installs in one list, so their relative order is observable. */
  const order: string[] = [];
  const coordinator = createContentScriptRecoveryCoordinator({
    queryFacebookTabs: async () => [
      { id: 41, url: 'https://www.facebook.com/stories/example/1' },
      { id: 42, url: 'https://www.facebook.com/reel/2' },
    ],
    ping: async (tabId) => {
      pings.push(tabId);
      return liveTabs.has(tabId);
    },
    inject: async (tabId, file) => {
      injections.push({ tabId, file });
      order.push(file);
    },
    hasPageHook: async (tabId) => ({ hooked: hookedTabs.has(tabId) }),
    installPageHook: async (tabId) => {
      hooks.push(tabId);
      order.push('page-hook.js');
    },
  });
  return { coordinator, hooks, injections, order, pings };
}

test('extension restart recovers already-open Facebook tabs whose content receiver is missing', async () => {
  const { coordinator, injections, pings } = harness(new Set([42]));

  await coordinator.recover();

  assert.deepEqual(pings, [41, 42]);
  assert.deepEqual(injections, [{ tabId: 41, file: 'content.js' }]);
});

test('extension restart never reinjects a content script when the tab already has a live receiver', async () => {
  const { coordinator, injections } = harness(new Set([41, 42]));

  await coordinator.recover();

  assert.deepEqual(injections, []);
});

test('update recovery can select the detector entry that replaces an invalidated instance', async () => {
  const { coordinator, injections } = harness(new Set());

  await coordinator.recover('content-recovery.js');

  assert.deepEqual(injections, [
    { tabId: 41, file: 'content-recovery.js' },
    { tabId: 42, file: 'content-recovery.js' },
  ]);
});

test('only a document with no live hook gets one', async () => {
  // 41 lost its hook (its tab loaded while the extension was switched off); 42's is a
  // MAIN-world hook that outlived the update, since it is plain page JS. Injecting there
  // again would install nothing on top of it — page-hook.js stops at its own stamp, which
  // tests/page-hook-idempotent.test.ts exercises — so what this pins is the trip not taken.
  const { coordinator, hooks } = harness(new Set(), new Set([42]));

  await coordinator.recover('content-recovery.js');

  assert.deepEqual(hooks, [41]);
});

test('the hook goes in after the detector, never before it', async () => {
  const { coordinator, order } = harness(new Set());

  await coordinator.recover();

  // The detector registers its window-message listener as it evaluates; the hook starts
  // posting captures — never retried — the moment it loads. Reversed, the first response
  // it harvests lands with nobody listening and is lost outright. Both tabs are hookless
  // here, so the pairing has to hold twice over.
  assert.deepEqual(order, ['content.js', 'page-hook.js', 'content.js', 'page-hook.js']);
});

test('a failing ping or inject on one tab never blocks recovery of the others', async () => {
  const injected: number[] = [];
  const errors: Array<{ tabId: number; message: string }> = [];
  const coordinator = createContentScriptRecoveryCoordinator({
    queryFacebookTabs: async () => [
      { id: 51, url: 'https://www.facebook.com/reel/1' },
      { id: 52, url: 'https://www.facebook.com/reel/2' },
    ],
    ping: async (tabId) => {
      if (tabId === 51) throw new Error('message port closed before a response');
      return false; // 52 has no live receiver → must still be reinjected
    },
    inject: async (tabId) => {
      injected.push(tabId);
    },
    hasPageHook: async () => ({ hooked: true }),
    installPageHook: async () => {},
    onError: (tabId, error) => {
      errors.push({ tabId, message: (error as Error).message });
    },
  });

  const result = await coordinator.recover();

  assert.deepEqual(injected, [52]);
  assert.equal(result.checked, 2);
  assert.equal(result.injected, 1);
  assert.deepEqual(errors.map((e) => e.tabId), [51]);
});
