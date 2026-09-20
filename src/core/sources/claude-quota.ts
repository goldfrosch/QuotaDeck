/**
 * Claude subscription quota.
 *
 * `GET https://api.anthropic.com/api/oauth/usage` is undocumented but is what
 * the Claude Code client itself calls; it returns the real 5-hour and 7-day
 * window utilisation for Pro/Max subscriptions. Verified against a live Max
 * account: HTTP 200 with `five_hour.utilization` and `resets_at`.
 *
 * Two constraints drive the design:
 *
 *  1. It is aggressively rate limited per access token (a handful of calls
 *     before 429, usually with no `retry-after`). Callers must poll on the
 *     order of minutes, not seconds, and treat this as the slow *anchor* while
 *     local DB deltas carry the fast path.
 *
 *  2. The User-Agent requirements of the two Anthropic endpoints are opposite:
 *     this one wants a `claude-cli/*` UA, while the OAuth *token* endpoint
 *     rejects UAs starting with `claude`. Never share an HTTP client or a
 *     default header set between them -- hence USAGE_USER_AGENT lives here and
 *     the refresh module declares its own.
 */

import { asEpochMs, asFiniteNumber, asString, child, isRecord } from "../json.ts";
import { CONFIG } from "../config.ts";
import type { QuotaResult, QuotaWindow } from "../types.ts";

/** `claude-cli/<version> (external, cli)` -- required, the endpoint is UA-gated. */
export function usageUserAgent(): string {
  return `claude-cli/${CONFIG.anthropic.claudeVersion} (external, cli)`;
}

/** Windows Anthropic reports by name; unknown/null entries are skipped. */
const NAMED_WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ["five_hour", "5-hour session"],
  ["seven_day", "7-day all"],
  ["seven_day_opus", "7-day Opus"],
  ["seven_day_sonnet", "7-day Sonnet"],
  ["seven_day_cowork", "7-day Cowork"],
  ["seven_day_oauth_apps", "7-day OAuth apps"],
];

function readWindow(root: Record<string, unknown>, key: string, label: string): QuotaWindow | null {
  const node = child(root, key);
  if (node === null) return null;
  const utilization = asFiniteNumber(node["utilization"]);
  if (utilization === null) return null;
  return { key, label, utilization, resetsAt: asEpochMs(node["resets_at"]) };
}

/**
 * `limits[]` repeats the named windows but adds model-scoped weekly entries
 * that have no top-level key, e.g. a per-model 7-day cap. Only those are
 * lifted, to avoid duplicating what NAMED_WINDOWS already produced.
 */
function readScopedLimits(root: Record<string, unknown>): QuotaWindow[] {
  const limits = root["limits"];
  if (!Array.isArray(limits)) return [];
  const out: QuotaWindow[] = [];
  for (const entry of limits) {
    if (!isRecord(entry)) continue;
    if (asString(entry["kind"]) !== "weekly_scoped") continue;
    const percent = asFiniteNumber(entry["percent"]);
    if (percent === null) continue;
    const model = child(child(entry, "scope"), "model");
    const name = model === null ? null : asString(model["display_name"]);
    out.push({
      key: `weekly_scoped:${name ?? "unknown"}`,
      label: `7-day ${name ?? "scoped"}`,
      utilization: percent,
      resetsAt: asEpochMs(entry["resets_at"]),
    });
  }
  return out;
}

function readNotes(root: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const breakdown = child(root, "seven_day_breakdown");
  if (breakdown !== null && Array.isArray(breakdown["rows"])) {
    const parts: string[] = [];
    for (const row of breakdown["rows"]) {
      if (!isRecord(row)) continue;
      const percent = asFiniteNumber(row["percent"]);
      const name = asString(row["display_name"]);
      if (percent === null || name === null || percent === 0) continue;
      parts.push(`${name} ${percent}%`);
    }
    if (parts.length > 0) notes.push(`7-day split: ${parts.join(", ")}`);
  }
  const extra = child(root, "extra_usage");
  if (extra !== null && extra["is_enabled"] === true) {
    notes.push("extra usage credits enabled");
  }
  return notes;
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export async function fetchClaudeQuota(
  accessToken: string | null,
  signal?: AbortSignal,
): Promise<QuotaResult> {
  const provider = "anthropic";
  if (accessToken === null) {
    return { ok: false, provider, reason: "no-credentials", detail: "no Anthropic access token on disk", retryAfterMs: null };
  }

  let response: Response;
  try {
    response = await fetch(CONFIG.anthropic.usageUrl, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "anthropic-beta": CONFIG.anthropic.oauthBeta,
        "user-agent": usageUserAgent(),
        accept: "application/json",
      },
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      provider,
      reason: "network-error",
      detail: err instanceof Error ? err.message : String(err),
      retryAfterMs: null,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, provider, reason: "credentials-expired", detail: `HTTP ${response.status}`, retryAfterMs: null };
  }
  if (response.status === 429) {
    return { ok: false, provider, reason: "rate-limited", detail: "HTTP 429", retryAfterMs: retryAfterMs(response.headers) };
  }
  if (!response.ok) {
    return { ok: false, provider, reason: "http-error", detail: `HTTP ${response.status}`, retryAfterMs: null };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return { ok: false, provider, reason: "parse-error", detail: err instanceof Error ? err.message : String(err), retryAfterMs: null };
  }
  if (!isRecord(body)) {
    return { ok: false, provider, reason: "parse-error", detail: "response was not an object", retryAfterMs: null };
  }

  const windows: QuotaWindow[] = [];
  for (const [key, label] of NAMED_WINDOWS) {
    const w = readWindow(body, key, label);
    if (w !== null) windows.push(w);
  }
  windows.push(...readScopedLimits(body));

  if (windows.length === 0) {
    return { ok: false, provider, reason: "parse-error", detail: "no usable quota windows in response", retryAfterMs: null };
  }

  return { ok: true, provider, fetchedAt: Date.now(), windows, notes: readNotes(body) };
}
