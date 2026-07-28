// stubCard: the card a Saved receipt renders as when its live capture is gone.
//
// Pure, so it needs no DOM — and load-bearing, because every honest-excuse path in the grid keys
// off the flags it sets. A stub that came back with target set, or without stale, would render a
// receipt whose media no longer exists as if it were downloadable.

import assert from 'node:assert/strict';
import test from 'node:test';

import { stubCard } from '../src/sidepanel/card-view';
import type { SavedEntry } from '../src/shared/saved';

const RECEIPT: SavedEntry = {
  id: 'v:vid:12345',
  savedAt: 1_770_000_000_000,
  kind: 'video',
  source: 'reel',
  thumbUrl: 'https://scontent.xx.fbcdn.net/v/t51/cover.jpg',
  resLabel: '1080p',
  durationSec: 34,
};

test('a receipt with no live capture is stale, unpickable and undownloadable', () => {
  const card = stubCard(RECEIPT);
  // No target: receipts store no media URLs, because fbcdn signatures rotate. There is nothing
  // truthful for a download button to fetch, and the grid disables both controls on this.
  assert.equal(card.target, undefined);
  assert.equal(card.stale, true);
  assert.equal(card.live, false);
  // Never "may lack audio": that is a property of a DASH track this card does not have.
  assert.equal(card.mayLackAudio, false);
});

test('carries the receipt identity and its display fields through unchanged', () => {
  const card = stubCard(RECEIPT);
  // The id IS the card id — the same namespaced value the cart, the busy set and the failure tags
  // are keyed on, so a stub and its live twin are the same card.
  assert.equal(card.id, RECEIPT.id);
  assert.equal(card.at, RECEIPT.savedAt);
  assert.equal(card.kind, 'video');
  assert.equal(card.source, 'reel');
  assert.equal(card.thumbUrl, RECEIPT.thumbUrl);
  assert.equal(card.resLabel, '1080p');
  assert.equal(card.durationSec, 34);
});

test('survives a receipt with only its required fields', () => {
  // Older receipts predate the cover and duration hints, and a Saved row still has to render.
  const bare: SavedEntry = { id: 'i:abc', savedAt: 1, kind: 'image', source: 'story' };
  const card = stubCard(bare);
  assert.equal(card.thumbUrl, undefined);
  assert.equal(card.resLabel, undefined);
  assert.equal(card.durationSec, undefined);
  assert.equal(card.stale, true);
  assert.equal(card.target, undefined);
});
