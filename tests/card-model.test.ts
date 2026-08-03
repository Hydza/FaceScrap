// Validate the placeholder card rendered for a receipt without a live capture.

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
  // Receipts omit expiring media URLs, so placeholders have no download target.
  assert.equal(card.target, undefined);
  assert.equal(card.stale, true);
  assert.equal(card.live, false);
  // Audio availability is unknown without a live DASH track.
  assert.equal(card.mayLackAudio, false);
});

test('carries the receipt identity and its display fields through unchanged', () => {
  const card = stubCard(RECEIPT);
  // The placeholder and its live card share one identity.
  assert.equal(card.id, RECEIPT.id);
  assert.equal(card.at, RECEIPT.savedAt);
  assert.equal(card.kind, 'video');
  assert.equal(card.source, 'reel');
  assert.equal(card.thumbUrl, RECEIPT.thumbUrl);
  assert.equal(card.resLabel, '1080p');
  assert.equal(card.durationSec, 34);
});

test('survives a receipt with only its required fields', () => {
  // Receipts without optional cover and duration hints must still render.
  const bare: SavedEntry = { id: 'i:abc', savedAt: 1, kind: 'image', source: 'story' };
  const card = stubCard(bare);
  assert.equal(card.thumbUrl, undefined);
  assert.equal(card.resLabel, undefined);
  assert.equal(card.durationSec, undefined);
  assert.equal(card.stale, true);
  assert.equal(card.target, undefined);
});
