import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldStartContentInstance, type ContentScriptInstance } from '../src/content/content-instance';

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
