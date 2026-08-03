// Generates toolbar icons from the side-panel logo.

import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from './crc32.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'icons');

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
    // Pin compression so tracked icon bytes remain deterministic.
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const svg = readFileSync(join(ROOT, 'src', 'sidepanel', 'icons', 'logo.svg'), 'utf8');

function fail(what) {
  throw new Error(`generate-icons: could not parse the logo SVG's ${what} — keep the icon script in step`);
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex) ?? fail(`color "${hex}"`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// Accept a negative gradient origin.
const gradTag =
  svg.match(/<linearGradient id="tile" x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)"/) ??
  fail('tile gradient axis');
const [gx1, gy1, gx2, gy2] = gradTag.slice(1, 5).map(Number);
const stopFrom = svg.match(/<stop offset="0" stop-color="(#[0-9A-Fa-f]{6})"/) ?? fail('gradient start stop');
const stopTo = svg.match(/<stop offset="1" stop-color="(#[0-9A-Fa-f]{6})"/) ?? fail('gradient end stop');
const GRAD = { x1: gx1, y1: gy1, x2: gx2, y2: gy2, from: hexToRgb(stopFrom[1]), to: hexToRgb(stopTo[1]) };

const tileTag =
  svg.match(/<rect width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="url\(#tile\)"\s*\/>/) ??
  fail('rounded tile rect');
const [tileW, tileH, tileR] = tileTag.slice(1, 4).map(Number);
const TILE = { cx: tileW / 2, cy: tileH / 2, hx: tileW / 2, hy: tileH / 2, r: tileR };

// Keep the sun filled so it remains legible at 16px.
const sunTag =
  svg.match(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="(#[0-9A-Fa-f]{6})"\s*\/>/) ?? fail('sun disc');
const SUN = { cx: Number(sunTag[1]), cy: Number(sunTag[2]), r: Number(sunTag[3]), rgb: hexToRgb(sunTag[4]) };

// Everything inside the <g> shares one stroke colour and width.
const strokeTag =
  svg.match(/<g stroke="(#[0-9A-Fa-f]{6})" stroke-width="([\d.]+)"/) ?? fail('stroked group');
const STROKE = { rgb: hexToRgb(strokeTag[1]), half: Number(strokeTag[2]) / 2 };

const frameTag =
  svg.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"\s*\/>/) ??
  fail('photo frame rect');
const [fx, fy, fw, fh, fr] = frameTag.slice(1, 6).map(Number);
const FRAME = { cx: fx + fw / 2, cy: fy + fh / 2, hx: fw / 2, hy: fh / 2, r: fr };

// Accept only the absolute path syntax used by the logo.
const pathTag =
  svg.match(/<path d="M([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+) L([\d.]+) ([\d.]+)"\s*\/>/) ?? fail('mountain polyline');
const POLY = [
  [Number(pathTag[1]), Number(pathTag[2])],
  [Number(pathTag[3]), Number(pathTag[4])],
  [Number(pathTag[5]), Number(pathTag[6])],
];

// Signed distance to a rounded rectangle centered at (cx,cy), half-size (hx,hy),
// corner radius r. Negative inside.
function roundedRectSDF(px, py, cx, cy, hx, hy, r) {
  const dx = Math.abs(px - cx) - (hx - r);
  const dy = Math.abs(py - cy) - (hy - r);
  return dx > 0 && dy > 0 ? Math.hypot(dx, dy) - r : Math.max(dx, dy) - r;
}

// Distance to one segment, with the projection parameter clamped to [0,1].
function segmentDistance(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby));
}

// Clamped segment distances reproduce round caps and joins.
function polylineDistance(px, py, pts) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, segmentDistance(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  return d;
}

// Match the browser's default sRGB gradient interpolation.
function gradientAt(u, v) {
  const dx = GRAD.x2 - GRAD.x1;
  const dy = GRAD.y2 - GRAD.y1;
  const t = Math.max(0, Math.min(1, ((u - GRAD.x1) * dx + (v - GRAD.y1) * dy) / (dx * dx + dy * dy)));
  return [
    GRAD.from[0] + (GRAD.to[0] - GRAD.from[0]) * t,
    GRAD.from[1] + (GRAD.to[1] - GRAD.from[1]) * t,
    GRAD.from[2] + (GRAD.to[2] - GRAD.from[2]) * t,
  ];
}

// The mark on its 32×32 grid, in paint order. Returns [r,g,b] or null outside.
function markColor(u, v) {
  if (roundedRectSDF(u, v, TILE.cx, TILE.cy, TILE.hx, TILE.hy, TILE.r) > 0) return null;
  const frameRing = Math.abs(roundedRectSDF(u, v, FRAME.cx, FRAME.cy, FRAME.hx, FRAME.hy, FRAME.r));
  if (Math.min(frameRing, polylineDistance(u, v, POLY)) <= STROKE.half) return STROKE.rgb;
  if (Math.hypot(u - SUN.cx, v - SUN.cy) <= SUN.r) return SUN.rgb;
  return gradientAt(u, v);
}

// Map a pixel to the 32-grid and sample the mark; transparent outside the card.
function sample(px, py, size) {
  return markColor((px / size) * 32, (py / size) * 32);
}

// Use 8×8 supersampling to keep the thin diagonal smooth at 16px.
function pixel(x, y, size) {
  const SS = 8;
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
