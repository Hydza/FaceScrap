import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldInjectPageHook,
  shouldStartContentInstance,
  type ContentScriptInstance,
} from '../src/content/content-instance';

function liveInstance(): ContentScriptInstance & { disposals: number } {
  const instance: ContentScriptInstance & { disposals: number } = {
    active: true,
    alive: () => instance.active,
    dispose: () => {
      instance.disposals++;
      instance.active = false;
    },
    disposals: 0,
  };
  return instance;
}

test('ordinary duplicate injection reuses one live detector', () => {
  const existing = liveInstance();

  assert.equal(shouldStartContentInstance(existing, false), false);
  assert.equal(existing.active, true);
  assert.equal(existing.disposals, 0);
});

test('recovery replaces a stale receiver even when its cached runtime still looks live', () => {
  const existing = liveInstance();

  assert.equal(shouldStartContentInstance(existing, true), true);
  assert.equal(existing.active, false);
  assert.equal(existing.disposals, 1);
});

test('an invalidated detector whose liveness probe throws never blocks reinjection', () => {
  const existing: Partial<ContentScriptInstance> = {
    active: true,
    alive: () => {
      throw new Error('Extension context invalidated');
    },
  };

  assert.equal(shouldStartContentInstance(existing, false), true);
});

test('a fresh page reusing a live detector still installs its own page hook', () => {
  // The recovery race: this pass reuses a live instance (its detector body is
  // skipped), yet the freshly navigated document owns no hook — injection must
  // not be gated on starting a new instance.
  const reused = liveInstance();
  assert.equal(shouldStartContentInstance(reused, false), false);
  assert.equal(shouldInjectPageHook(false, false), true);
});

test('page-hook injection is skipped only for recovery or an already-hooked document', () => {
  assert.equal(shouldInjectPageHook(true, false), false); // recovery: a surviving MAIN-world hook still owns fetch/XHR
  assert.equal(shouldInjectPageHook(false, true), false); // already injected in this document
  assert.equal(shouldInjectPageHook(false, false), true); // fresh document, no hook
});
