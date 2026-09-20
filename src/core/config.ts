/**
 * Runtime configuration, overridable from the environment or a `.env` file.
 *
 * Nothing here is a secret. The two client IDs are *public* OAuth client
 * identifiers for native apps -- RFC 6749 §2.1 classifies these as public
 * clients, which by definition cannot hold a secret, and both values ship in
 * the corresponding open-source CLIs. quotadeck never stores a token: access
 * and refresh tokens are read from the user's own credential files at call
 * time and are represented everywhere else by a fingerprint.
 *
 * They are configurable anyway, because they are the parts most likely to be
 * changed by a provider. When Anthropic moved its token endpoint from
 * console.anthropic.com to claude.ai, every tool with the URL compiled in
 * broke; an override means editing `.env` instead of rebuilding.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PATHS } from "./paths.ts";

/**
 * Loads the first `.env` found, best effort.
 *
 * Search order matters for a packaged build: the portable exe runs with an
 * unpredictable cwd, so the directory holding the executable and the per-user
 * state directory are both checked.
 */
function loadDotEnv(): string | null {
  const explicit = process.env["QUOTADECK_ENV_FILE"];
  const candidates = [
    ...(explicit !== undefined && explicit.length > 0 ? [explicit] : []),
    join(process.cwd(), ".env"),
    join(dirname(process.execPath), ".env"),
    join(PATHS.stateDir, ".env"),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      process.loadEnvFile(candidate);
      return candidate;
    } catch {
      // A malformed .env must not stop the app from starting on defaults.
    }
  }
  return null;
}

export const LOADED_ENV_FILE = loadDotEnv();

function str(key: string, fallback: string): string {
  const value = process.env[key];
  return value !== undefined && value.length > 0 ? value : fallback;
}

function int(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return fallback;
  return value !== "0" && value.toLowerCase() !== "false";
}

export const CONFIG = {
  anthropic: {
    usageUrl: str("QUOTADECK_ANTHROPIC_USAGE_URL", "https://api.anthropic.com/api/oauth/usage"),
    tokenUrl: str("QUOTADECK_ANTHROPIC_TOKEN_URL", "https://claude.ai/v1/oauth/token"),
    clientId: str("QUOTADECK_ANTHROPIC_CLIENT_ID", "9d1c250a-e61b-44d9-88ed-5944d1962f5e"),
    oauthBeta: str("QUOTADECK_ANTHROPIC_OAUTH_BETA", "oauth-2025-04-20"),
    /** The usage endpoint is User-Agent gated and wants a claude-cli UA. */
    claudeVersion: str("QUOTADECK_CLAUDE_VERSION", "2.1.261"),
  },
  openai: {
    usageUrl: str("QUOTADECK_OPENAI_USAGE_URL", "https://chatgpt.com/backend-api/wham/usage"),
    tokenUrl: str("QUOTADECK_OPENAI_TOKEN_URL", "https://auth.openai.com/oauth/token"),
    clientId: str("QUOTADECK_OPENAI_CLIENT_ID", "app_EMoamEEZ73f0CkXaXp7hrann"),
  },
  zai: {
    /**
     * Coding-plan monitoring surface. Absent from the public API reference,
     * but Z.ai's own usage-query plugin calls exactly this path with an API
     * key, and the console's usage page is backed by it. Override for the
     * China platform, which serves the same paths from open.bigmodel.cn.
     */
    usageUrl: str("QUOTADECK_ZAI_USAGE_URL", "https://api.z.ai/api/monitor/usage/quota/limit"),
  },
  /**
   * Used only for token-endpoint calls. It must NOT start with "claude": the
   * Anthropic token endpoint rate-limits such agents, which is the exact
   * opposite of what its usage endpoint requires.
   */
  refreshUserAgent: str("QUOTADECK_REFRESH_USER_AGENT", "quotadeck/0.1"),
  custodyEnabled: bool("QUOTADECK_CUSTODY", true),
  windowHours: int("QUOTADECK_WINDOW_HOURS", 5),
  poll: {
    /** Free: reads the local opencode database. */
    localMs: int("QUOTADECK_POLL_LOCAL_MS", 2_000),
    storesMs: int("QUOTADECK_POLL_STORES_MS", 15_000),
    /** Rate-limited anchors. Lower this at your peril. */
    quotaMs: int("QUOTADECK_POLL_QUOTA_MS", 180_000),
    custodyMs: int("QUOTADECK_POLL_CUSTODY_MS", 300_000),
  },
} as const;
