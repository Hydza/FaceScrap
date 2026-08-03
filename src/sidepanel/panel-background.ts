// The panel's custom background image.
//
// Held in chrome.storage.local under its OWN key, deliberately not inside Settings. Two
// reasons: a settings write is a read-modify-write of one small object on a serialized
// lane, and a megabyte-scale data URL riding along on every unrelated toggle would make
// each of them pay for it; and storage.local is what makes the image survive the browser
// closing, which storage.session would not.
//
// What the user hands over is never what gets stored. An 8 MP phone photo is ~4 MB and
// storage.local's whole quota is ~10 MB, shared with the Saved receipts and the
// diagnostics counters — so the image is decoded, downscaled and re-encoded to WebP
// first, and refused outright if it is still too big afterwards.

import type { MsgKey } from '../shared/i18n';

const BACKGROUND_KEY = 'panelBackground';
/** Longest side of the stored copy. The panel is ~400px wide, so this is already generous
 *  for a 2x display and leaves the image sharp when the panel is dragged wider. */
const MAX_EDGE_PX = 1400;
/** WebP quality. Below ~0.7 a photographic background starts showing blocking in the flat
 *  areas the cards sit on, which is the one place it would be noticed. */
const ENCODE_QUALITY = 0.8;
/** Cap on what actually reaches storage — the base64 data URL, not the binary, because
 *  base64 is what is measured against the quota and it inflates by a third. */
const MAX_STORED_BYTES = 2 * 1024 * 1024;
/** Cap on the file before it is DECODED — a separate limit from the one above, because
 *  createImageBitmap allocates width × height × 4 bytes however small the compressed file was.
 *  A crafted 20000×20000 PNG is 1.6 GB of bitmap from a few hundred kilobytes, and the downscale
 *  cannot help: the decode comes first. */
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
/** And a cap on the decoded pixels, which the file size cannot predict. 80 MP is four times the
 *  largest phone sensor in circulation, and ~320 MB of bitmap. */
const MAX_SOURCE_PIXELS = 80_000_000;

/** Bumped by every store and every clear, so whoever asked last wins. Encoding a large photo
 *  takes long enough to press Remove in the middle of it, and a store that finished afterwards
 *  would otherwise put the image back. */
let generation = 0;

type StoreResult = { ok: true } | { ok: false; reason: MsgKey };

/** Fit within MAX_EDGE_PX without changing the aspect, and never upscale: enlarging a
 *  small image would cost bytes and add nothing. */
function scaledSize(width: number, height: number): { width: number; height: number } {
  const factor = Math.min(1, MAX_EDGE_PX / Math.max(width, height));
  return { width: Math.round(width * factor), height: Math.round(height * factor) };
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(blob);
  });
}

/** Decode, downscale, re-encode and store. Returns a user-actionable failure reason. */
export async function storePanelBackground(file: File): Promise<StoreResult> {
  const mine = ++generation;
  /** Did a Remove — or a second Choose — happen while this one was encoding? */
  const superseded = (): boolean => generation !== mine;
  // Refused BEFORE the decode, which is the only point at which it can be refused cheaply.
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, reason: 'bgTooLarge' };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // Not an image, or an encoding this browser cannot decode.
    return { ok: false, reason: 'bgUnreadable' };
  }
  try {
    if (bitmap.width * bitmap.height > MAX_SOURCE_PIXELS) return { ok: false, reason: 'bgTooLarge' };
    const { width, height } = scaledSize(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (context == null) return { ok: false, reason: 'bgUnreadable' };
    context.drawImage(bitmap, 0, 0, width, height);
    const encoded = await canvas.convertToBlob({ type: 'image/webp', quality: ENCODE_QUALITY });
    const dataUrl = await readAsDataUrl(encoded);
    if (dataUrl.length > MAX_STORED_BYTES) return { ok: false, reason: 'bgTooLarge' };
    // Checked immediately before the write, which is the only moment that matters: everything
    // above this line is pure work on a local bitmap and abandoning it changes nothing.
    if (superseded()) return { ok: false, reason: 'bgSuperseded' };
    // Its own try: a rejection here is the quota, not an unreadable file, and the outer catch
    // would report it as one — sending the user to look at their photo instead of their storage.
    try {
      await chrome.storage.local.set({ [BACKGROUND_KEY]: dataUrl });
    } catch {
      return { ok: false, reason: 'bgNoRoom' };
    }
    applyPanelBackground(dataUrl);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'bgUnreadable' };
  } finally {
    // Frees the decoded pixels now: a GC has no idea how much native memory is behind a handle.
    bitmap.close();
  }
}

export async function loadPanelBackground(): Promise<string | undefined> {
  try {
    const stored = (await chrome.storage.local.get(BACKGROUND_KEY))[BACKGROUND_KEY];
    // Accept only the WebP data URL written by storePanelBackground. This also excludes
    // remote URLs and SVG markup independently of the extension CSP.
    return typeof stored === 'string' && stored.startsWith('data:image/webp;base64,') ? stored : undefined;
  } catch {
    return undefined;
  }
}

export async function clearPanelBackground(): Promise<void> {
  // Bumped first, so a store still encoding sees itself superseded and abandons its write
  // instead of resurrecting the image after this removal lands.
  generation++;
  await chrome.storage.local.remove(BACKGROUND_KEY);
  applyPanelBackground(undefined);
}

/** Paint it, or take it away. The class is what the stylesheet keys off — .app then draws
 *  the image instead of its flat --cv fill, with body's own --cv still underneath as a
 *  floor for anything transparent or short. */
export function applyPanelBackground(dataUrl: string | undefined): void {
  const app = document.getElementById('app');
  if (app == null) return;
  app.classList.toggle('has-bg', dataUrl != null);
  if (dataUrl == null) app.style.removeProperty('--panel-bg');
  else app.style.setProperty('--panel-bg', `url("${dataUrl}")`);
}
