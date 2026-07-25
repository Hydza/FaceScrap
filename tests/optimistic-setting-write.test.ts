import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_SETTINGS, writeSettingOptimistically } from '../src/shared/settings';

test('a committed write returns the merged value and runs commit, never rollback', async () => {
  const order: string[] = [];
  const result = await writeSettingOptimistically(
    DEFAULT_SETTINGS,
    { maxItems: 42 },
    {
      save: async () => {
        order.push('save');
      },
      applyOptimistic: (next) => {
        order.push(`optimistic:${next.maxItems}`);
      },
      onCommitted: (next) => {
        order.push(`commit:${next.maxItems}`);
      },
      onRolledBack: () => {
        order.push('rollback');
      },
      onError: () => {
        order.push('error');
      },
    },
  );

  assert.equal(result.maxItems, 42);
  // Optimistic UI runs before the durable write; commit runs only after it resolves.
  assert.deepEqual(order, ['optimistic:42', 'save', 'commit:42']);
});

test('a rejected write rolls back to the previous value and surfaces the error', async () => {
  const order: string[] = [];
  const failure = new Error('Extension context invalidated');
  const previous = { ...DEFAULT_SETTINGS, maxItems: 10 };

  const result = await writeSettingOptimistically(
    previous,
    { maxItems: 999 },
    {
      save: async () => {
        throw failure;
      },
      applyOptimistic: (next) => {
        order.push(`optimistic:${next.maxItems}`);
      },
      onCommitted: () => {
        order.push('commit');
      },
      onRolledBack: (restored) => {
        order.push(`rollback:${restored.maxItems}`);
      },
      onError: (error) => {
        order.push(`error:${(error as Error).message}`);
      },
    },
  );

  // The authoritative state is the untouched previous value, not the optimistic 999.
  assert.equal(result.maxItems, 10);
  assert.equal(result, previous, 'a rejected write returns the exact previous object');
  // Rollback ran with the previous value, the error was surfaced, commit never fired.
  assert.deepEqual(order, ['optimistic:999', 'rollback:10', 'error:Extension context invalidated']);
});

test('a write with no hooks still returns the merged value', async () => {
  const result = await writeSettingOptimistically(DEFAULT_SETTINGS, { videosOnly: true }, {
    save: async () => {},
  });
  assert.equal(result.videosOnly, true);
});
