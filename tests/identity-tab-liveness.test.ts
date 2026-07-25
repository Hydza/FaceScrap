import assert from 'node:assert/strict';
import test from 'node:test';

import { ClosedTabError, createTabLifecycle } from '../src/background/tab-lifecycle';

// E5: the in-memory deadTabs Set starts empty on every worker (re)start and
// only ever learns of a closure through onRemoved firing on THIS instance —
// a tab closed before this instance existed leaves no trace in it. An
// identity-free call (no documentId — the side panel's pin/bindings/clear
// writes) has nothing else vouching for the tab, so runIfLive must verify
// against the browser itself rather than trust the Set's silence. These
// tests install their OWN minimal `chrome.tabs.get` fake (no chrome-fake.ts
// storage import needed) so they stay independent of every other suite's
// chrome shape.
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
  const { queries } = installTabsFake(new Set()); // tab 900 does not exist in the browser
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
  // The verified closure self-heals the Set, so a later isDead() pre-check
  // (binding-handler.ts, service-worker.ts) also short-circuits correctly.
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
  const { queries } = installTabsFake(new Set()); // tab 902 "does not exist" per the fake
  const lifecycle = createTabLifecycle(Promise.resolve());
  let ran = false;

  // The content-script capture path always supplies a documentId; per E5's
  // fix that must stay exempt from the new browser round-trip regardless of
  // what the Set would otherwise conclude.
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
