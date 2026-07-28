// Regression check for the storage-lane "ALSO EXPORT" item: SAVED_THUMB_MAX,
// SAVED_LABEL_MAX and the saved-id bound used to be module-private numbers in
// storage.ts (1024 / 16 / 258) while service-worker.ts's inbound-receipt
// validation hardcoded the same three literals with no compile-time link.
// storage.ts now exports SAVED_ID_MAX/SAVED_THUMB_MAX/SAVED_LABEL_MAX and uses
// them itself in sanitizeEntry, so this test locks the exported values to the
// ACTUAL persisted truncation behaviour of addSaved/getSaved — if a future
// edit ever let the exported constant and the real slice bound drift apart,
// this fails.
import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';

const { addSaved, getSaved, SAVED_ID_MAX, SAVED_LABEL_MAX, SAVED_THUMB_MAX } = await import('../src/shared/saved');

test('SAVED_ID_MAX, SAVED_THUMB_MAX and SAVED_LABEL_MAX are exported with the documented values', () => {
  assert.equal(SAVED_ID_MAX, 258);
  assert.equal(SAVED_THUMB_MAX, 1024);
  assert.equal(SAVED_LABEL_MAX, 16);
});

test('addSaved truncates an id/resLabel and drops an over-limit thumbUrl at exactly the exported bounds', async () => {
  await resetChromeStorage();
  const tabId = 96_000;
  const overlongId = `v:${'a'.repeat(SAVED_ID_MAX + 50)}`;
  const overlongLabel = 'x'.repeat(SAVED_LABEL_MAX + 20);
  const overlongThumb = `https://scontent.xx.fbcdn.net/v/t39/${'z'.repeat(SAVED_THUMB_MAX + 60)}.jpg`;

  await addSaved(tabId, {
    id: overlongId,
    kind: 'video',
    source: 'story',
    savedAt: 1_800_000_000_000,
    thumbUrl: overlongThumb,
    resLabel: overlongLabel,
  });

  const [entry] = await getSaved(tabId);
  assert.equal(entry.id.length, SAVED_ID_MAX);
  assert.equal(entry.id, overlongId.slice(0, SAVED_ID_MAX));
  assert.equal(entry.thumbUrl, undefined, 'a thumbUrl over SAVED_THUMB_MAX must be dropped, not truncated');
  assert.equal(entry.resLabel, overlongLabel.slice(0, SAVED_LABEL_MAX));
});

test('addSaved keeps a thumbUrl at exactly SAVED_THUMB_MAX characters', async () => {
  await resetChromeStorage();
  const tabId = 96_001;
  const prefix = 'https://scontent.xx.fbcdn.net/v/t39/';
  const suffix = '.jpg';
  const fillerLength = SAVED_THUMB_MAX - prefix.length - suffix.length;
  const validThumb = `${prefix}${'y'.repeat(fillerLength)}${suffix}`;
  assert.equal(validThumb.length, SAVED_THUMB_MAX);

  await addSaved(tabId, {
    id: 'v:within-bound',
    kind: 'video',
    source: 'story',
    savedAt: 1_800_000_000_001,
    thumbUrl: validThumb,
  });

  const [entry] = await getSaved(tabId);
  assert.equal(entry.thumbUrl, validThumb);
});
