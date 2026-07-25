import assert from 'node:assert/strict';
import test from 'node:test';

import { createContentScriptRecoveryCoordinator } from '../src/background/content-script-recovery';

function harness(liveTabs: ReadonlySet<number>) {
  const pings: number[] = [];
  const injections: Array<{ tabId: number; file: string }> = [];
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
    },
  });
  return { coordinator, injections, pings };
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

test('update recovery can select the detector entry that preserves the existing page hook', async () => {
  const { coordinator, injections } = harness(new Set());

  await coordinator.recover('content-recovery.js');

  assert.deepEqual(injections, [
    { tabId: 41, file: 'content-recovery.js' },
    { tabId: 42, file: 'content-recovery.js' },
  ]);
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
