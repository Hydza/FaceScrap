import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';

test('storage.local drops undefined-valued properties like real Chrome serialization', async () => {
  await resetChromeStorage();
  await chrome.storage.local.set({ k: { a: 1, b: undefined } });

  const got = await chrome.storage.local.get('k');

  assert.equal('b' in (got.k as Record<string, unknown>), false);
  assert.deepEqual(got, { k: { a: 1 } });
});

test('storage.local mangles Date values like real Chrome serialization', async () => {
  await resetChromeStorage();
  await chrome.storage.local.set({ k: { at: new Date(0) } });

  const got = await chrome.storage.local.get('k');

  assert.equal((got.k as Record<string, unknown>).at, '1970-01-01T00:00:00.000Z');
});

test('storage.session keeps structured-clone semantics', async () => {
  await resetChromeStorage();
  await chrome.storage.session.set({ k: { a: 1, b: undefined } });

  const got = await chrome.storage.session.get('k');

  assert.equal('b' in (got.k as Record<string, unknown>), true);
});

test('get returns independent copies, not live references into the store', async () => {
  await resetChromeStorage();
  await chrome.storage.session.set({ k: { tracks: [1] } });

  const first = await chrome.storage.session.get('k');
  (first.k as { tracks: number[] }).tracks.push(2);

  const second = await chrome.storage.session.get('k');
  assert.deepEqual(second, { k: { tracks: [1] } });
});

// Verify that all storage areas emit through one area-tagged event.
test('storage.onChanged fires with the areaName and the new value for an added key', async () => {
  await resetChromeStorage();
  const seen: Array<{ changes: Record<string, chrome.storage.StorageChange>; area: chrome.storage.AreaName }> = [];
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName) => {
    seen.push({ changes, area });
  };
  chrome.storage.onChanged.addListener(listener);

  await chrome.storage.local.set({ settings: { a: 1 } });
  await chrome.storage.session.set({ media_1: [1, 2] });
  chrome.storage.onChanged.removeListener(listener);

  assert.deepEqual(seen, [
    { changes: { settings: { newValue: { a: 1 } } }, area: 'local' },
    { changes: { media_1: { newValue: [1, 2] } }, area: 'session' },
  ]);
});

test('storage.onChanged reports oldValue on a real change and on remove, and skips a same-value set', async () => {
  await resetChromeStorage();
  await chrome.storage.local.set({ settings: { a: 1 }, keep: 'same' });

  const seen: Array<Record<string, chrome.storage.StorageChange>> = [];
  const listener = (changes: Record<string, chrome.storage.StorageChange>) => seen.push(changes);
  chrome.storage.onChanged.addListener(listener);

  // Report only the key whose value changed.
  await chrome.storage.local.set({ settings: { a: 2 }, keep: 'same' });
  await chrome.storage.local.remove('settings');
  chrome.storage.onChanged.removeListener(listener);

  assert.deepEqual(seen, [
    { settings: { oldValue: { a: 1 }, newValue: { a: 2 } } },
    { settings: { oldValue: { a: 2 } } },
  ]);
});

test('a removed storage.onChanged listener receives no further changes', async () => {
  await resetChromeStorage();
  const seen: unknown[] = [];
  const listener = (changes: Record<string, chrome.storage.StorageChange>) => seen.push(changes);
  chrome.storage.onChanged.addListener(listener);
  chrome.storage.onChanged.removeListener(listener);

  await chrome.storage.local.set({ settings: { a: 1 } });

  assert.deepEqual(seen, []);
});
