// Regression check for the storage-lane code-review finding C2: getMedia's
// read-time id-migration repair used to write back through addMedia from
// WHATEVER context called it. The side panel calls getMedia in its render
// loop, and every mutex in storage.ts is an in-memory promise chain local to
// ONE JS context — so a panel-issued write here has no lock against the
// worker's own concurrent addMedia and can straddle it, silently dropping a
// capture or resurrecting a tab the worker just cleared.
//
// storage.ts now gates the write on isServiceWorkerContext (`typeof document
// === 'undefined'`): an MV3 service worker has no document; a side panel is a
// normal HTML page and always has one. That constant is evaluated ONCE at
// module load, so `document` must be stubbed before storage.ts is first
// (dynamically) imported below — this file never imports it statically, so
// this is the only module in the whole run that observes `document` defined.
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
  // The caller still gets the repaired shape immediately...
  assert.equal(migrated[0]?.id, mediaId(url));

  // ...but with `document` defined (this module's stand-in for "not the
  // worker"), nothing may write that repair back. Flush past the fire-and-
  // forget addMedia() call the old code issued unconditionally.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual((await chrome.storage.session.get(`media_${tabId}`))[`media_${tabId}`], [legacyRow]);
});
