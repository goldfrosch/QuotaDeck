/**
 * Codex / ChatGPT subscription quota.
 *
 * `GET https://chatgpt.com/backend-api/wham/usage` returns the primary (5h)
 * and secondary (weekly) rate-limit windows for a ChatGPT plan, authenticated
 * with the same bearer Codex CLI stores in `~/.codex/auth.json`.
 *
 * Unlike the Anthropic endpoint this one is not UA-gated, but it does want the
 * account id that the id_token was minted for.
 */

import { asBoolean, asEpochMs, asFiniteNumber, asString, child, isRecord } from "../json.ts";
import { CONFIG } from "../config.ts";
import type { QuotaResult, QuotaWindow } from "../types.ts";

const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ["primary_window", "5-hour session"],
  ["secondary_window", "weekly"],
];

function readWindow(root: Record<string, unknown>, key: string, fallbackLabel: string): QuotaWindow | null {
  const node = child(root, key);
  if (node === null) return null;
  const used = asFiniteNumber(node["used_percent"]);
  if (used === null) return null;
  // `limit_window_seconds` lets us label the window from the server rather
  // than trusting the primary/secondary naming to stay stable.
  const seconds = asFiniteNumber(node["limit_window_seconds"]);
  const label =
    seconds === null
      ? fallbackLabel
      : seconds >= 604_800
        ? "weekly"
        : seconds >= 86_400
          ? `${Math.round(seconds / 86_400)}-day`
          : `${Math.round(seconds / 3600)}-hour`;
  return { key, label, utilization: used, resetsAt: asEpochMs(node["reset_at"]) };
}

export async function fetchCodexQuota(
  accessToken: string | null,
  accountId: string | null,
  signal?: AbortSignal,
): Promise<QuotaResult> {
  const provider = "openai";
  if (accessToken === null) {
    return { ok: false, provider, reason: "no-credentials", detail: "no Codex access token on disk", retryAfterMs: null };
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
  };
  if (accountId !== null) headers["chatgpt-account-id"] = accountId;

  let response: Response;
  try {
    response = await fetch(CONFIG.openai.usageUrl, { method: "GET", headers, ...(signal ? { signal } : {}) });
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
    return { ok: false, provider, reason: "rate-limited", detail: "HTTP 429", retryAfterMs: null };
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

  // The payload has been seen both at the root and nested under `rate_limit`.
  const limits = child(body, "rate_limit") ?? body;
  const windows: QuotaWindow[] = [];
  for (const [key, label] of WINDOWS) {
    const w = readWindow(limits, key, label);
    if (w !== null) windows.push(w);
  }
  if (windows.length === 0) {
    return { ok: false, provider, reason: "parse-error", detail: "no usable quota windows in response", retryAfterMs: null };
  }

  const notes: string[] = [];
  const plan = asString(body["plan_type"]);
  if (plan !== null) notes.push(`plan ${plan}`);
  const credits = child(body, "credits");
  if (credits !== null) {
    // `balance` comes back as a decimal *string* ("0"), not a number.
    const raw = credits["balance"];
    const balance = asFiniteNumber(raw) ?? Number.parseFloat(asString(raw) ?? "");
    if (Number.isFinite(balance)) notes.push(`credit balance ${balance}`);
  }
  if (asBoolean(child(body, "rate_limit")?.["limit_reached"] ?? null) === true) {
    notes.push("RATE LIMIT REACHED");
  }

  return { ok: true, provider, fetchedAt: Date.now(), windows, notes };
}
