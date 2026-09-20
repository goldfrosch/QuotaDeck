/**
 * A dependency-free PNG encoder, just large enough to draw the tray icon.
 *
 * The tray icon is the only part of this app visible when the window is
 * hidden, so it carries the signal: it is tinted by the worst quota window,
 * green -> amber -> red. That needs a new image per state, and shipping a
 * PNG asset per colour (or pulling in an image library) is more moving parts
 * than emitting 16x16 RGBA by hand.
 */

import { deflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Renders a filled circle with a vertical "fuel gauge" whose height tracks
 * `fill` (0..1), then encodes it as a PNG buffer.
 */
export function gaugeIconPng(size: number, colour: Rgb, fill: number): Buffer {
  const clamped = Math.max(0, Math.min(1, fill));
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const centre = (size - 1) / 2;
  const radius = centre + 0.5;
  const surfaceY = size - clamped * size;

  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const dy = y - centre;
      const inside = dx * dx + dy * dy <= radius * radius;
      const submerged = y >= surfaceY;
      // Outside the disc is transparent; the unfilled part of the disc is a
      // dim version of the same hue so the gauge reads at 16px.
      const alpha = inside ? (submerged ? 255 : 70) : 0;
      raw[offset++] = colour.r;
      raw[offset++] = colour.g;
      raw[offset++] = colour.b;
      raw[offset++] = alpha;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Green below 60%, amber to 85%, red beyond. */
export function severityColour(utilization: number): Rgb {
  if (utilization >= 85) return { r: 239, g: 68, b: 68 };
  if (utilization >= 60) return { r: 245, g: 158, b: 11 };
  return { r: 34, g: 197, b: 94 };
}
