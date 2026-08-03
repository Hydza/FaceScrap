// Validate persistent local storage and strict data-URL handling for custom backgrounds.

import assert from 'node:assert/strict';
import test from 'node:test';

import { resetChromeStorage } from './chrome-fake';

const KEY = 'panelBackground';
const SAMPLE = 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA=';

test('reads the stored image back out of storage.local', async () => {
  await resetChromeStorage();
  const { loadPanelBackground } = await import('../src/sidepanel/panel-background');
  try {
    await chrome.storage.local.set({ [KEY]: SAMPLE });
    assert.equal(await loadPanelBackground(), SAMPLE);

    // Ignore session values because backgrounds must persist across restarts.
    await chrome.storage.local.remove(KEY);
    await chrome.storage.session.set({ [KEY]: SAMPLE });
    assert.equal(await loadPanelBackground(), undefined, 'session is the wrong area for this');
  } finally {
    await resetChromeStorage();
  }
});

test('refuses anything that is not a data: image', async () => {
  await resetChromeStorage();
  const { loadPanelBackground } = await import('../src/sidepanel/panel-background');
  try {
    for (const stored of [
      'https://example.com/tracker.png',
      'http://example.com/a.png',
      // Reject non-image data URLs.
      'data:text/html,<script>1</script>',
      'javascript:alert(1)',
      ' data:image/webp;base64,AA',
      '',
      // Accept only the WebP format written by the background encoder.
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:image/svg+xml,<svg onload="alert(1)"/>',
      // Require the base64 encoding written by the encoder.
      'data:image/webp,notbase64',
      'data:image/png;base64,iVBORw0KGgo=',
      42,
      null,
      { url: SAMPLE },
    ]) {
      await chrome.storage.local.set({ [KEY]: stored });
      assert.equal(
        await loadPanelBackground(),
        undefined,
        `${JSON.stringify(stored)} must not reach a background-image`,
      );
    }
  } finally {
    await resetChromeStorage();
  }
});

test('an oversized file is refused before anything decodes it', async () => {
  // Reject oversized compressed input before allocating its decoded bitmap.
  await resetChromeStorage();
  const { storePanelBackground } = await import('../src/sidepanel/panel-background');
  const huge = { size: 64 * 1024 * 1024, type: 'image/png', name: 'huge.png' } as unknown as File;
  assert.deepEqual(await storePanelBackground(huge), { ok: false, reason: 'bgTooLarge' });
  // Rejecting input must not modify storage.
  assert.deepEqual(await chrome.storage.local.get(KEY), {});
});

test('an empty store is simply no background, not a failure', async () => {
  await resetChromeStorage();
  const { loadPanelBackground } = await import('../src/sidepanel/panel-background');
  assert.equal(await loadPanelBackground(), undefined);
});
