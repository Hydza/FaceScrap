// Packages the unpacked extension into FaceScrap-v<version>.zip — the asset the
// README tells people to download from Releases, which until now was zipped by
// hand.
//
// Zero dependencies, like the rest of this repo: the archive is written on top
// of node:zlib the same way generate-icons.mjs writes a PNG. It rebuilds from
// scratch first and then checks the inventory, because dist/ is a working
// directory: Chrome drops a `_metadata/` into an unpacked extension when it
// loads one, and a bundle whose source has since been deleted lingers until the
// next `rm -rf`.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

// The two halves of `npm run build`, run directly: invoking npm itself would
// need a shell on Windows and buys nothing here.
function runScript(name) {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', name)], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`scripts/${name} exited with ${result.status}`);
}

runScript('generate-icons.mjs');
runScript('build.mjs');

// What build.mjs produces: one .js per entryPoint plus copyStatic()'s files.
// Spelled out rather than imported — build.mjs does its work on import — so the
// two drifting apart fails the packaging step loudly instead of shipping a
// release with a file nobody meant to publish.
const EXPECTED_FILES = [
  'content-recovery.js',
  'content.js',
  'manifest.json',
  'offscreen/offscreen.html',
  'offscreen/offscreen.js',
  'page-hook.js',
  'rules/referer-rules.json',
  'service-worker.js',
  'sidepanel/sidepanel.css',
  'sidepanel/sidepanel.html',
  'sidepanel/sidepanel.js',
];
// Copied whole, so their contents may change without touching this script.
const EXPECTED_TREES = ['_locales/', 'icons/', 'sidepanel/fonts/', 'sidepanel/icons/'];

function walk(dir, out = []) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    // Zip entry names are always '/'-separated, whatever the host separator is.
    else out.push(relative(DIST, full).split('\\').join('/'));
  }
  return out;
}

const files = walk(DIST);
const problems = [
  ...files
    .filter((p) => !EXPECTED_FILES.includes(p) && !EXPECTED_TREES.some((tree) => p.startsWith(tree)))
    .map((p) => `  unexpected: ${p}`),
  ...EXPECTED_FILES.filter((p) => !files.includes(p)).map((p) => `  missing: ${p}`),
  ...EXPECTED_TREES.filter((tree) => !files.some((p) => p.startsWith(tree))).map((tree) => `  empty: ${tree}`),
];
if (problems.length > 0) {
  throw new Error(`dist/ is not what build.mjs is supposed to produce:\n${problems.join('\n')}`);
}

// Its own table rather than a shared helper: generate-icons.mjs carries the same
// eight lines, and a module for two standalone build scripts is not worth a file.
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

// Every entry carries the same 1980-01-01 DOS stamp, so the same dist/ always
// yields a byte-identical zip. A release asset anyone can re-derive is worth
// more than one that records the minute it was built.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const localParts = [];
const centralParts = [];
let offset = 0;

for (const name of files) {
  const data = readFileSync(join(DIST, name));
  const deflated = deflateRawSync(data, { level: 9 });
  // The woff2 and the PNGs are already compressed; storing them is smaller.
  const compress = deflated.length < data.length;
  const body = compress ? deflated : data;
  const method = compress ? 8 : 0;
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, 'utf8');

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4); // version needed to extract: 2.0
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(method, 8);
  localHeader.writeUInt16LE(DOS_TIME, 10);
  localHeader.writeUInt16LE(DOS_DATE, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(body.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28); // extra field length
  localParts.push(localHeader, nameBuf, body);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4); // version made by
  centralHeader.writeUInt16LE(20, 6); // version needed
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(method, 10);
  centralHeader.writeUInt16LE(DOS_TIME, 12);
  centralHeader.writeUInt16LE(DOS_DATE, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(body.length, 20);
  centralHeader.writeUInt32LE(data.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30); // extra field length
  centralHeader.writeUInt16LE(0, 32); // comment length
  centralHeader.writeUInt16LE(0, 34); // disk number
  centralHeader.writeUInt16LE(0, 36); // internal attributes
  centralHeader.writeUInt32LE(0, 38); // external attributes
  centralHeader.writeUInt32LE(offset, 42);
  centralParts.push(centralHeader, nameBuf);

  offset += localHeader.length + nameBuf.length + body.length;
}

const central = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4); // this disk
end.writeUInt16LE(0, 6); // disk with the central directory
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(central.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20); // comment length

// manifest.json at the zip ROOT, no wrapping folder: that is what "Load
// unpacked" and the Web Store both expect.
const { version } = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const out = join(ROOT, `FaceScrap-v${version}.zip`);
writeFileSync(out, Buffer.concat([...localParts, central, end]));
console.log(`wrote ${relative(ROOT, out)} — ${files.length} files, ${Math.round(statSync(out).size / 1024)} KB`);
