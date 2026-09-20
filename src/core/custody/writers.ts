/**
 * Write-back for the two stores quotadeck owns.
 *
 * Rules, in priority order:
 *  1. Never lose a field. Each writer mutates a clone of the parsed root and
 *     rewrites the whole document, so keys we do not understand survive a
 *     host-tool upgrade untouched.
 *  2. Never leave a torn file. Write to a sibling temp file, fsync, rename.
 *     `rename` replaces atomically on both POSIX and Win32.
 *  3. Never write without a backup. Credential files are the one thing on this
 *     machine a bug cannot un-break, so every apply snapshots first.
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isRecord } from "../json.ts";
import { PATHS } from "../paths.ts";
import type { StoreId } from "../types.ts";

export interface TokenUpdate {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly idToken: string | null;
}

export type ApplyResult =
  | { readonly ok: true; readonly root: unknown; readonly touched: number }
  | { readonly ok: false; readonly error: string };

/** `{ [provider]: { type: "oauth", access, refresh, expires } }` */
export function applyToOpencodeAuthJson(raw: unknown, provider: string, update: TokenUpdate): ApplyResult {
  if (!isRecord(raw)) return { ok: false, error: "auth.json root is not an object" };
  const root = structuredClone(raw) as Record<string, unknown>;
  const entry = root[provider];
  if (!isRecord(entry) || entry["type"] !== "oauth") {
    return { ok: false, error: `no oauth entry for provider "${provider}"` };
  }
  entry["access"] = update.accessToken;
  entry["refresh"] = update.refreshToken;
  entry["expires"] = update.expiresAt;
  return { ok: true, root, touched: 1 };
}

/** `accounts[*].credential` where `serviceID === provider` and type is oauth. */
export function applyToAccountJson(raw: unknown, provider: string, update: TokenUpdate): ApplyResult {
  if (!isRecord(raw)) return { ok: false, error: "account.json root is not an object" };
  const root = structuredClone(raw) as Record<string, unknown>;
  const accounts = root["accounts"];
  if (!isRecord(accounts)) return { ok: false, error: "account.json has no accounts object" };

  let touched = 0;
  for (const value of Object.values(accounts)) {
    if (!isRecord(value)) continue;
    if (value["serviceID"] !== provider) continue;
    const credential = value["credential"];
    if (!isRecord(credential) || credential["type"] !== "oauth") continue;
    credential["access"] = update.accessToken;
    credential["refresh"] = update.refreshToken;
    credential["expires"] = update.expiresAt;
    touched += 1;
  }
  if (touched === 0) return { ok: false, error: `no oauth account for provider "${provider}"` };
  return { ok: true, root, touched };
}

/** `tokens.{access_token,refresh_token,id_token}` plus `last_refresh`. */
export function applyToCodexJson(raw: unknown, update: TokenUpdate): ApplyResult {
  if (!isRecord(raw)) return { ok: false, error: "codex auth.json root is not an object" };
  const root = structuredClone(raw) as Record<string, unknown>;
  const tokens = root["tokens"];
  if (!isRecord(tokens)) return { ok: false, error: "codex auth.json has no tokens object" };

  tokens["access_token"] = update.accessToken;
  tokens["refresh_token"] = update.refreshToken;
  // Codex derives the plan/account from id_token, so only replace it when the
  // provider actually issued a new one -- clobbering it with null breaks login.
  if (update.idToken !== null) tokens["id_token"] = update.idToken;
  // `last_refresh` is when the credential was last renewed, not when it lapses.
  // Codex schedules its own refresh from this value, so writing a future
  // timestamp here would suppress its next attempt.
  root["last_refresh"] = new Date().toISOString();
  return { ok: true, root, touched: 1 };
}

function backup(storeId: StoreId, path: string, contents: string): string {
  const dir = join(PATHS.stateDir, "backups");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const target = join(dir, `${storeId}-${basename(path)}-${ts}`);
  writeFileSync(target, contents, { encoding: "utf8", mode: 0o600 });
  return target;
}

/**
 * Snapshots the current file, then atomically replaces it with `root`.
 * Returns the backup path so a caller can tell the user how to undo.
 */
export function atomicWriteJson(storeId: StoreId, path: string, previous: string, root: unknown): string {
  const backupPath = backup(storeId, path, previous);
  const serialized = `${JSON.stringify(root, null, 2)}\n`;
  const temp = join(dirname(path), `.${basename(path)}.quotadeck-${process.pid}.tmp`);

  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, serialized);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  return backupPath;
}
