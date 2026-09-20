/**
 * Guarantees Electron's runtime binary is present after install.
 *
 * Electron ships a ~235 MB binary that its own postinstall downloads. pnpm
 * blocks dependency install scripts unless allowlisted (see
 * pnpm-workspace.yaml), and even when allowed it skips the script for a
 * package it considers already built -- which happens whenever the store was
 * populated by a different package manager. The result is an `electron`
 * package with no executable and a confusing failure at first run.
 *
 * This runs from our own postinstall, which pnpm always executes, and is a
 * no-op when the binary is already there.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

let packageJsonPath;
try {
  packageJsonPath = require.resolve("electron/package.json");
} catch {
  console.log("electron is not installed; nothing to verify");
  process.exit(0);
}

const electronDir = dirname(packageJsonPath);
const binary =
  process.platform === "win32"
    ? join(electronDir, "dist", "electron.exe")
    : process.platform === "darwin"
      ? join(electronDir, "dist", "Electron.app")
      : join(electronDir, "dist", "electron");

if (existsSync(binary)) {
  console.log("electron runtime present");
  process.exit(0);
}

console.log("electron runtime missing -- downloading...");
await import(pathToFileURL(join(electronDir, "install.js")).href);

if (!existsSync(binary)) {
  console.error("electron runtime still missing after install");
  process.exit(1);
}
console.log("electron runtime installed");
