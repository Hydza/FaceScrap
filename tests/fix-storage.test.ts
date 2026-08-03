// Define document before importing storage to exercise a non-worker caller.
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { resetChromeStorage } from './chrome-fake';
import { mediaId, type MediaItem } from '../src/shared/media';

Object.defineProperty(globalThis, 'document', { configurable: true, value: {} });

const { getMedia } = await import('../src/shared/storage');

const tabId = 990_001;

beforeEach(resetChromeStorage);

test('getMedia repairs its return value but never persists the migration outside the worker context', async () => {
  const legacyId = 'fb:123456789012345';
  const url = 'https://scontent.xx.fbcdn.net/v/t39.30808-6/123456789012345_n.jpg?oh=rotating';
  const legacyRow: MediaItem = {
    id: legacyId,
    url,
    kind: 'image',
    source: 'story',
    origin: 'dom',
    addedAt: 1_800_000_000_000,
  };
  await chrome.storage.session.set({ [`media_${tabId}`]: [legacyRow] });

  const migrated = await getMedia(tabId);
  // The caller receives the normalized shape immediately.
  assert.equal(migrated[0]?.id, mediaId(url));

  // Let any queued work settle before verifying that storage stayed unchanged.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual((await chrome.storage.session.get(`media_${tabId}`))[`media_${tabId}`], [legacyRow]);
});
