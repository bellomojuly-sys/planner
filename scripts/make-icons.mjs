#!/usr/bin/env node
/**
 * Generates the PWA icon set as PNGs with no image-library dependency.
 *
 * Writes minimal, hand-assembled PNGs (single colour plus a simple glyph) so
 * `npm install` stays small and the build has no native dependencies. Replace
 * web/public/icons/*.png with real artwork whenever you have some.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x12, 0x14, 0x1a];
const FG = [0xff, 0xb4, 0x54];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Draws a rounded square with three horizontal rules — a small agenda page. */
function render(size) {
  // Each row is prefixed with a filter byte (0 = none), as PNG requires.
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(stride * size);

  const pad = Math.round(size * 0.18);
  const inner = size - pad * 2;
  const radius = Math.round(inner * 0.22);
  const lineHeight = Math.max(1, Math.round(inner * 0.075));
  const lineGap = Math.round(inner * 0.24);

  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      let colour = BG;

      const lx = x - pad;
      const ly = y - pad;
      const insideBox =
        lx >= 0 && ly >= 0 && lx < inner && ly < inner && !inCorner(lx, ly, inner, radius);

      if (insideBox) {
        const rel = ly - Math.round(inner * 0.24);
        const onLine =
          rel >= 0 &&
          rel % lineGap < lineHeight &&
          rel < lineGap * 3 &&
          lx > inner * 0.16 &&
          lx < inner * 0.84;
        if (onLine) colour = FG;
        else colour = [0x1e, 0x22, 0x2b];
      }

      const offset = y * stride + 1 + x * 3;
      raw[offset] = colour[0];
      raw[offset + 1] = colour[1];
      raw[offset + 2] = colour[2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inCorner(x, y, size, radius) {
  const cx = x < radius ? radius : x > size - radius ? size - radius : x;
  const cy = y < radius ? radius : y > size - radius ? size - radius : y;
  if (cx === x && cy === y) return false;
  return (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2;
}

for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['icon-180.png', 180],
  ['badge-72.png', 72],
]) {
  writeFileSync(join(outDir, name), render(size));
  console.log(`✓ ${name}`);
}
