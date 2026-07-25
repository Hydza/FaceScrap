// Generates real PNG icon files (16/48/128px) with zero dependencies.
// A hand-rolled PNG encoder (RGBA) using Node's built-in zlib.
//
// Draws the FaceScrap 2b mark: a Facebook-blue rounded mosaic tile with a warm
// sun and two landscape planes. Geometry and palette are parsed from the external
// side-panel SVG, so the toolbar PNGs and the panel brand share one source.

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size, pixel) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Parse the external 32×32 mark shipped with the side panel ───────────────
const svg = readFileSync(join(ROOT, 'src', 'sidepanel', 'icons', 'logo.svg'), 'utf8');

function fail(what) {
  throw new Error(`generate-icons: could not parse the logo SVG's ${what} — keep the icon script in step`);
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex) ?? fail(`color "${hex}"`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const tileTag =
  svg.match(/<rect width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="(#[0-9A-Fa-f]{6})"\s*\/>/) ??
  fail('rounded tile rect');
const [tileW, tileH, tileR] = tileTag.slice(1, 4).map(Number);
const TILE_RECT = { cx: tileW / 2, cy: tileH / 2, hx: tileW / 2, hy: tileH / 2, r: tileR };
const TILE = hexToRgb(tileTag[4]);

// The sun.
const sunTag = svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="(#\w{6})"/) ?? fail('sun circle');
const SUN = { cx: Number(sunTag[1]), cy: Number(sunTag[2]), r: Number(sunTag[3]), rgb: hexToRgb(sunTag[4]) };

// Triangles, in document (paint) order: back plane, then white foreground plane.
const TRI_RE = /<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) Z" fill="(#\w{6})"/g;
const tris = [...svg.matchAll(TRI_RE)].map((m) => ({ pts: m.slice(1, 7).map(Number), rgb: hexToRgb(m[7]) }));
if (tris.length !== 2) fail(`two triangle paths (found ${tris.length})`);
const [BACK_PLANE, FRONT_PLANE] = tris;

// Signed distance to a rounded rectangle centered at (cx,cy), half-size (hx,hy),
// corner radius r. Negative inside.
function roundedRectSDF(px, py, cx, cy, hx, hy, r) {
  const dx = Math.abs(px - cx) - (hx - r);
  const dy = Math.abs(py - cy) - (hy - r);
  return dx > 0 && dy > 0 ? Math.hypot(dx, dy) - r : Math.max(dx, dy) - r;
}

// Barycentric-sign point-in-triangle test.
function inTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// The 2b mosaic mark on its 32×32 grid. Returns [r,g,b] or null.
function markColor(u, v) {
  if (roundedRectSDF(u, v, TILE_RECT.cx, TILE_RECT.cy, TILE_RECT.hx, TILE_RECT.hy, TILE_RECT.r) > 0) return null;
  if (inTri(u, v, ...FRONT_PLANE.pts)) return FRONT_PLANE.rgb;
  if (inTri(u, v, ...BACK_PLANE.pts)) return BACK_PLANE.rgb;
  if (Math.hypot(u - SUN.cx, v - SUN.cy) <= SUN.r) return SUN.rgb;
  return TILE;
}

// Map a pixel to the 32-grid and sample the mark; transparent outside the card.
function sample(px, py, size) {
  return markColor((px / size) * 32, (py / size) * 32);
}

// 4×4 supersampling: the card corners and mountain edges need anti-aliasing.
function pixel(x, y, size) {
  const SS = 4;
  let r = 0, g = 0, b = 0, hits = 0;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      const col = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
      if (!col) continue;
      r += col[0];
      g += col[1];
      b += col[2];
      hits++;
    }
  }
  if (hits === 0) return [0, 0, 0, 0];
  return [Math.round(r / hits), Math.round(g / hits), Math.round(b / hits), Math.round((hits / (SS * SS)) * 255)];
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, encodePNG(size, pixel));
  console.log(`wrote icons/icon-${size}.png`);
}
