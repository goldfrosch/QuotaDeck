/**
 * Z.ai Coding Plan quota.
 *
 * `GET https://api.z.ai/api/monitor/usage/quota/limit` returns the plan's
 * rolling windows. It is absent from Z.ai's public API reference, but it is
 * not guesswork: Z.ai's own usage-query plugin (`zai-org/zai-coding-plugins`,
 * linked from their devpack docs) calls this exact path, and the web console's
 * usage page is backed by the same surface.
 *
 * Three things about this endpoint differ from the other providers here:
 *
 *  1. The API key goes in a **bare** `Authorization` header. No `Bearer`
 *     prefix -- that is what the first-party plugin sends. The server also
 *     tolerates `Bearer`, but matching the official client is the safer bet.
 *
 *  2. `usage` is the *limit*, not the consumption. Consumption is
 *     `currentValue`. Reading `usage` as "used" inverts every bar.
 *
 *  3. Failure can arrive inside an HTTP 200: the envelope carries its own
 *     `code`/`success` pair, so an expired key shows up as
 *     `{"code":401,...,"success":false}` with a 200 status line.
 *
 * A key that authenticates but has no coding plan attached (a pay-as-you-go
 * key) returns an empty `limits` array. That is a distinct, legitimate state
 * rather than an error, so it maps to `no-plan`.
 */

import { asEpochMs, asFiniteNumber, asString, child, isRecord } from "../json.ts";
import { CONFIG } from "../config.ts";
import type { QuotaResult, QuotaWindow } from "../types.ts";

/** `unit` codes the endpoint uses to express a window duration. */
const UNIT_HOUR = 3;
const UNIT_MONTH = 5;
const UNIT_WEEK = 6;

/** Token/credit budgets. Newer payloads renamed TOKENS_LIMIT to CREDIT_LIMIT. */
const BUDGET_TYPES: ReadonlySet<string> = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

interface Limit {
  readonly type: string;
  readonly unit: number;
  readonly number: number;
  readonly utilization: number;
  readonly resetsAt: number | null;
}

function readLimit(entry: unknown): Limit | null {
  if (!isRecord(entry)) return null;
  const type = asString(entry["type"]);
  const unit = asFiniteNumber(entry["unit"]);
  const count = asFiniteNumber(entry["number"]);
  if (type === null || unit === null || count === null) return null;

  // `percentage` is normally present; derive it when it is not, remembering
  // that `usage` is the denominator here.
  const percentage = asFiniteNumber(entry["percentage"]);
  const used = asFiniteNumber(entry["currentValue"]);
  const limit = asFiniteNumber(entry["usage"]);
  const utilization =
    percentage ?? (used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null);
  if (utilization === null) return null;

  return {
    type,
    unit,
    number: count,
    utilization: Math.max(0, Math.min(100, utilization)),
    resetsAt: asEpochMs(entry["nextResetTime"]),
  };
}

function label(limit: Limit): string {
  if (limit.type === "TIME_LIMIT") return "monthly MCP";
  if (limit.unit === UNIT_HOUR) return `${limit.number}-hour session`;
  if (limit.unit === UNIT_WEEK) return limit.number === 1 ? "weekly" : `${limit.number}-week`;
  if (limit.unit === UNIT_MONTH) return limit.number === 1 ? "monthly" : `${limit.number}-month`;
  return `${limit.number}-unit${limit.unit}`;
}

/**
 * Shortest budget window first, then the longer one, then the MCP lane. The
 * renderer reads slots 0 and 1 as the two comparable horizons, so this order
 * is load-bearing rather than cosmetic.
 */
function rank(limit: Limit): number {
  if (limit.type === "TIME_LIMIT") return 3;
  if (limit.unit === UNIT_HOUR) return 0;
  if (limit.unit === UNIT_WEEK) return 1;
  return 2;
}

function toWindow(limit: Limit, index: number): QuotaWindow {
  return {
    key: `${limit.type}:${limit.unit}:${limit.number}:${index}`,
    label: label(limit),
    utilization: limit.utilization,
    resetsAt: limit.resetsAt,
  };
}

function retryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export async function fetchZaiQuota(apiKey: string | null, signal?: AbortSignal): Promise<QuotaResult> {
  const provider = "zai-coding-plan";
  if (apiKey === null) {
    return { ok: false, provider, reason: "no-credentials", detail: "no Z.ai API key on disk", retryAfterMs: null };
  }

  let response: Response;
  try {
    response = await fetch(CONFIG.zai.usageUrl, {
      method: "GET",
      headers: {
        // Bare key: this is what Z.ai's own plugin sends.
        authorization: apiKey,
        accept: "application/json",
        "accept-language": "en-US,en",
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

  // A 200 can still carry a failure envelope.
  const code = asFiniteNumber(body["code"]);
  if (body["success"] === false || (code !== null && code !== 200)) {
    const detail = asString(body["msg"]) ?? `code ${code ?? "unknown"}`;
    const reason = code === 401 || code === 403 ? "credentials-expired" : "http-error";
    return { ok: false, provider, reason, detail, retryAfterMs: null };
  }

  const data = child(body, "data");
  const raw = data === null ? null : data["limits"];
  if (!Array.isArray(raw)) {
    return { ok: false, provider, reason: "parse-error", detail: "response carried no limits array", retryAfterMs: null };
  }

  const limits = raw.map(readLimit).filter((l): l is Limit => l !== null);
  const budgets = limits.filter((l) => BUDGET_TYPES.has(l.type));
  if (budgets.length === 0) {
    return {
      ok: false,
      provider,
      reason: "no-plan",
      detail: "key has no active coding plan",
      retryAfterMs: null,
    };
  }

  const windows = [...budgets, ...limits.filter((l) => l.type === "TIME_LIMIT")]
    .sort((a, b) => rank(a) - rank(b))
    .map(toWindow);

  const notes: string[] = [];
  const level = data === null ? null : asString(data["level"]);
  if (level !== null) notes.push(`plan ${level}`);

  return { ok: true, provider, fetchedAt: Date.now(), windows, notes };
}
