/**
 * Resolution of every on-disk location quotadeck touches.
 *
 * Paths mirror what the host tools actually do, verified on this machine:
 *  - opencode writes auth.json to BOTH the XDG path and %LOCALAPPDATA% on
 *    Windows (opencode-claude-auth credentials.js:84-88), so both are read.
 *  - opencode's v2 account store (account.json) is written by opencode itself
 *    and by nothing else -- the auth plugin has zero references to it.
 *  - Codex keeps its own auth.json under CODEX_HOME.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { Ownership, StoreId } from "./types.ts";

const HOME = homedir();

function xdgDataHome(): string {
  const raw = process.env["XDG_DATA_HOME"];
  return raw && raw.length > 0 ? raw : join(HOME, ".local", "share");
}

function localAppData(): string {
  const raw = process.env["LOCALAPPDATA"];
  return raw && raw.length > 0 ? raw : join(HOME, "AppData", "Local");
}

function claudeConfigDir(): string {
  const raw = process.env["CLAUDE_CONFIG_DIR"];
  return raw && raw.length > 0 ? raw : join(HOME, ".claude");
}

function codexHome(): string {
  const raw = process.env["CODEX_HOME"];
  return raw && raw.length > 0 ? raw : join(HOME, ".codex");
}

const OPENCODE_DATA = join(xdgDataHome(), "opencode");

export const PATHS = {
  claudeCredentials: join(claudeConfigDir(), ".credentials.json"),
  opencodeAuthXdg: join(OPENCODE_DATA, "auth.json"),
  opencodeAuthLocalAppData: join(localAppData(), "opencode", "auth.json"),
  opencodeAccount: join(OPENCODE_DATA, "account.json"),
  opencodeDb: join(OPENCODE_DATA, "opencode.db"),
  codexAuth: join(codexHome(), "auth.json"),
  /**
   * Where opencode-claude-auth puts its advisory refresh lock. We honour the
   * same directory so a future write path can join its single-flight protocol
   * instead of racing it.
   */
  foreignLockDir: process.env["OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR"] ?? OPENCODE_DATA,
  /** quotadeck's own lock/state dir -- never shared. */
  stateDir: join(xdgDataHome(), "quotadeck"),
} as const;

/**
 * Ownership is per (store, provider), not per store.
 *
 * An earlier version keyed this by store alone and that was wrong in a way
 * that caused real damage: `opencode-claude-auth` owns only the **anthropic**
 * entry inside opencode's auth.json, but treating the whole file as foreign
 * meant quotadeck could strand the openai entry in it -- it copied that
 * entry's refresh token into Codex, Codex rotated it, and opencode was left
 * holding a dead grant it was never allowed to repair.
 */
const FOREIGN_OWNED: ReadonlySet<string> = new Set([
  // The `claude` CLI and the opencode-claude-auth plugin already implement
  // locking, proactive refresh, rotation adoption and 401 recovery for these.
  "claude-code:anthropic",
  "opencode-auth-xdg:anthropic",
  "opencode-auth-localappdata:anthropic",
]);

export function ownershipFor(storeId: StoreId, provider: string): Ownership {
  return FOREIGN_OWNED.has(`${storeId}:${provider}`) ? "observed" : "owned";
}

/** Coarse per-store view, for display only. A store is "observed" when every
 *  provider in it is foreign-owned. */
export const STORE_IS_FULLY_OBSERVED: Readonly<Record<StoreId, boolean>> = {
  "claude-code": true,
  "opencode-auth-xdg": false,
  "opencode-auth-localappdata": false,
  "opencode-account": false,
  codex: false,
} as const;

export const STORE_PATHS: Readonly<Record<StoreId, string>> = {
  "claude-code": PATHS.claudeCredentials,
  "opencode-auth-xdg": PATHS.opencodeAuthXdg,
  "opencode-auth-localappdata": PATHS.opencodeAuthLocalAppData,
  "opencode-account": PATHS.opencodeAccount,
  codex: PATHS.codexAuth,
} as const;

export const ALL_STORE_IDS: readonly StoreId[] = [
  "claude-code",
  "opencode-auth-xdg",
  "opencode-auth-localappdata",
  "opencode-account",
  "codex",
] as const;
