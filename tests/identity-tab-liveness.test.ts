import assert from 'node:assert/strict';
import test from 'node:test';

import { ClosedTabError, createTabLifecycle } from '../src/background/tab-lifecycle';

// Identity-free operations must verify tab liveness through the browser.
// These tests use an isolated `chrome.tabs.get` stub.
function installTabsFake(openTabIds: Set<number>): { queries: number[] } {
  const calls: number[] = [];
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      tabs: {
        async get(tabId: number) {
          calls.push(tabId);
          if (!openTabIds.has(tabId)) throw new Error(`No tab with id: ${tabId}.`);
          return { id: tabId };
        },
      },
    },
  });
  return { queries: calls };
}

test('E5: an identity-free call for a tab this worker never saw close is rejected, not silently accepted', async () => {
  const { queries } = installTabsFake(new Set()); // Tab 900 does not exist.
  const lifecycle = createTabLifecycle(Promise.resolve());
  let ran = false;

  await assert.rejects(
    lifecycle.runIfLive(900, () => {
      ran = true;
    }),
    ClosedTabError,
  );
  assert.equal(ran, false, 'the task must not run for a tab the browser does not have');
  assert.equal(queries.length, 1, 'the browser must actually be asked');
  // Cache the verified closure for later liveness checks.
  assert.equal(lifecycle.isDead(900), true);
});

test('E5: an identity-free call for a tab the browser confirms open still runs', async () => {
  installTabsFake(new Set([901]));
  const lifecycle = createTabLifecycle(Promise.resolve());
  let ran = false;

  await lifecycle.runIfLive(901, () => {
    ran = true;
  });
  assert.equal(ran, true);
  assert.equal(lifecycle.isDead(901), false);
});

test('E5: a documentId-bearing (hot capture path) call never queries chrome.tabs, even for an unrecorded tab', async () => {
  const { queries } = installTabsFake(new Set()); // Tab 902 does not exist.
  const lifecycle = createTabLifecycle(Promise.resolve());
  let ran = false;

  // A document identity makes the browser round trip unnecessary.
  await lifecycle.runIfLive(
    902,
    () => {
      ran = true;
    },
    'doc-1',
  );
  assert.equal(ran, true);
  assert.equal(queries.length, 0, 'a documentId-bearing call must never pay the liveness round-trip');
});
