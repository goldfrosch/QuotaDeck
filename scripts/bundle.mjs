/**
 * Bundles the Electron app into dist/.
 *
 * Output is ESM (.mjs) for main and preload so `import.meta.url` works and the
 * package stays `"type": "module"` end to end -- Electron has supported ESM in
 * both since v28, and this app requires far newer than that for node:sqlite.
 */

import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: "node24",
};

await build({
  ...shared,
  entryPoints: [join(root, "src/electron/main.ts")],
  platform: "node",
  format: "esm",
  external: ["electron"],
  outfile: join(dist, "main.mjs"),
});

await build({
  ...shared,
  entryPoints: [join(root, "src/electron/preload.ts")],
  platform: "node",
  format: "esm",
  external: ["electron"],
  outfile: join(dist, "preload.mjs"),
});

await build({
  ...shared,
  entryPoints: [join(root, "src/renderer/main.ts")],
  platform: "browser",
  format: "iife",
  target: "chrome152",
  outfile: join(dist, "renderer.js"),
});

await cp(join(root, "src/renderer/index.html"), join(dist, "index.html"));
await cp(join(root, "src/renderer/styles.css"), join(dist, "styles.css"));

console.log("bundled -> dist/");
