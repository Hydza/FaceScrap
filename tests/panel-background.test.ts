// The custom background's read guard, and the storage area it reads from.
//
// Two properties matter and neither is cosmetic.
//
// It must come back from storage.LOCAL. The whole promise of the feature is that the image is
// still there after the browser is closed, and storage.session — which every other key in this
// extension uses — is wiped on restart. A one-word slip there passes every visual check and
// fails the only requirement the user actually stated.
//
// And it must be a data: URL. The stored value is a bare string, so a corrupt or tampered
// store could hold an http(s) one; letting that reach `background-image: url(...)` would turn
// a settings value into an outbound request from an extension page. The panel's CSP already
// blocks it, but a guard that depends on the CSP staying exactly as it is today is not a guard.

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

    // Not session. A value parked there must not be found, or the feature would appear to
    // work for a whole session and silently lose the image on the next browser start.
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
      // A data: URL of the wrong type is still not an image, and would resolve to nothing.
      'data:text/html,<script>1</script>',
      'javascript:alert(1)',
      ' data:image/webp;base64,AA',
      '',
      // SVG is an image type, and the only one that carries markup. A background-image does
      // not run its scripts, but nothing written here is ever an SVG — everything goes out of
      // storePanelBackground as WebP — so admitting one could only ever mean the store was
      // tampered with. The guard names the exact format instead of the family.
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:image/svg+xml,<svg onload="alert(1)"/>',
      // Right family, wrong encoding: the reader only ever produces base64.
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
  // createImageBitmap allocates width × height × 4 bytes no matter how small the compressed
  // file was, and the downscale that follows cannot help because the decode happens first. A
  // 20000×20000 PNG is 1.6 GB of bitmap from a file of a few hundred kilobytes.
  //
  // Reachable without a DOM precisely BECAUSE the guard comes first: the size is all it reads,
  // so nothing here needs a canvas, a real image, or a browser. If this ever starts throwing
  // instead of returning, the guard has moved behind the decode.
  await resetChromeStorage();
  const { storePanelBackground } = await import('../src/sidepanel/panel-background');
  const huge = { size: 64 * 1024 * 1024, type: 'image/png', name: 'huge.png' } as unknown as File;
  assert.deepEqual(await storePanelBackground(huge), { ok: false, reason: 'bgTooLarge' });
  // And nothing was stored on the way out.
  assert.deepEqual(await chrome.storage.local.get(KEY), {});
});

test('an empty store is simply no background, not a failure', async () => {
  await resetChromeStorage();
  const { loadPanelBackground } = await import('../src/sidepanel/panel-background');
  assert.equal(await loadPanelBackground(), undefined);
});
