/**
 * Resolution of every on-disk location quotadeck touches.
 *
 * Paths mirror what the host tools actually do, verified on this machine:
 *  - opencode writes auth.json to BOTH the XDG path and %LOCALAPPDATA% on
 *    Windows (opencode-claude-auth credentials.js:84-88), so both are read.
 *  - opencode's v2 account store (account.json) is written by opencode itself
 *    and by nothing else -- the auth plugin has zero references to it.
 *  - Codex keeps its own auth.json under CODEX_HOME.
 *  - omo native keeps its own auth.json under its agent dir
 *    (OMO_CODING_AGENT_DIR, default ~/.omo/agent).
 *
 * These are only the *defaults* of the built-in store catalog. Users relocate
 * or extend it through stores.json -- see catalog.ts.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();

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

function omoAgentDir(): string {
  for (const key of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR"]) {
    const raw = process.env[key];
    if (raw && raw.length > 0) return raw;
  }
  return join(HOME, ".omo", "agent");
}

const OPENCODE_DATA = join(xdgDataHome(), "opencode");
const QUOTADECK_STATE = join(xdgDataHome(), "quotadeck");

export const PATHS = {
  claudeCredentials: join(claudeConfigDir(), ".credentials.json"),
  opencodeAuthXdg: join(OPENCODE_DATA, "auth.json"),
  opencodeAuthLocalAppData: join(localAppData(), "opencode", "auth.json"),
  opencodeAccount: join(OPENCODE_DATA, "account.json"),
  opencodeDb: join(OPENCODE_DATA, "opencode.db"),
  codexAuth: join(codexHome(), "auth.json"),
  omoAgentAuth: join(omoAgentDir(), "auth.json"),
  /**
   * Where opencode-claude-auth puts its advisory refresh lock. We honour the
   * same directory so a future write path can join its single-flight protocol
   * instead of racing it.
   */
  foreignLockDir: process.env["OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR"] ?? OPENCODE_DATA,
  /** quotadeck's own lock/state dir -- never shared. */
  stateDir: QUOTADECK_STATE,
  /**
   * Window preferences that must outlive a restart. Only the pin lives here:
   * a widget that forgets whether you wanted it on top has to be re-toggled
   * every launch.
   */
  uiSettings: join(QUOTADECK_STATE, "ui.json"),
} as const;

/**
 * The user's store catalog overrides. Resolved per call, not at import, so a
 * `QUOTADECK_STORES_FILE` set in `.env` (loaded after this module) still wins.
 */
export function storesConfigPath(): string {
  const raw = process.env["QUOTADECK_STORES_FILE"];
  return raw && raw.length > 0 ? raw : join(QUOTADECK_STATE, "stores.json");
}
