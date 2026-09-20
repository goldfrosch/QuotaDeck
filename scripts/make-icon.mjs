/**
 * Generates build/icon.ico for electron-builder.
 *
 * Reuses the same PNG encoder the tray uses, so the app icon and the tray
 * gauge are literally the same drawing -- and the repo carries no binary
 * assets, which keeps `git diff` meaningful.
 *
 * ICO layout: a 6-byte ICONDIR, then one 16-byte ICONDIRENTRY per size, then
 * the image payloads. Vista and later accept PNG payloads directly, which is
 * why no BMP encoder is needed here.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gaugeIconPng } from "../src/electron/icon.ts";

const SIZES = [16, 24, 32, 48, 64, 128, 256];
/** The accent colour from the renderer stylesheet. */
const BRAND = { r: 56, g: 189, b: 248 };
const FILL = 0.72;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "build");

const images = SIZES.map((size) => ({ size, png: gaugeIconPng(size, BRAND, FILL) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

const ENTRY_BYTES = 16;
let offset = header.length + images.length * ENTRY_BYTES;

const entries = images.map(({ size, png }) => {
  const entry = Buffer.alloc(ENTRY_BYTES);
  // 256 is encoded as 0 -- the field is a single byte.
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2); // palette size: not paletted
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
  return entry;
});

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, "icon.ico"), Buffer.concat([header, ...entries, ...images.map((i) => i.png)]));

console.log(`icon -> build/icon.ico (${SIZES.join(", ")} px)`);
