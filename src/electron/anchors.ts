/**
 * Quota anchors that survive failures and restarts.
 *
 * Why this exists (2026-09-27): Anthropic's usage endpoint answers a handful
 * of calls and then 429s -- since about March 2026 often for hours, with
 * `retry-after: 0` or none (anthropics/claude-code#30930, #31637). The widget
 * kept calling on its fixed timer while its label claimed it was "backing
 * off", and every failed poll replaced the last good reading, so each 429,
 * network blip or restart made the Claude band look as if its token had
 * vanished. The token was valid every time.
 *
 * So each provider now keeps its newest successful reading, shown marked
 * stale while calls fail, and a real backoff: a 429 pushes the next call --
 * timed or manual -- out to 2x, 4x, 8x ... the poll interval, capped at an
 * hour and never sooner than a positive `retry-after`. A success resets it.
 *
 * Both persist in the state dir, so a restart shows data at once, keeps
 * honouring a backoff, and spends no call on a reading that is still fresh.
 * The file holds quota results only -- the secret-free shape the renderer
 * already receives -- never a token.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG } from "../core/config.ts";
import { asFiniteNumber, asString, child, isRecord, parseJson } from "../core/json.ts";
import { PATHS } from "../core/paths.ts";
import type { EpochMs, QuotaFailure, QuotaFailureReason, QuotaResult, QuotaSuccess, QuotaWindow } from "../core/types.ts";
import { NO_ANCHOR } from "./state.ts";
import type { QuotaAnchor } from "./state.ts";

/** The longest a run of 429s can push a provider's next call out. */
const MAX_BACKOFF_MS = 3_600_000;

export interface Anchors {
  readonly claude: QuotaAnchor;
  readonly codex: QuotaAnchor;
  readonly zai: QuotaAnchor;
}

/** Folds one call's outcome into the anchor it was made for. */
export function advanceAnchor(previous: QuotaAnchor, result: QuotaResult, now: EpochMs): QuotaAnchor {
  if (result.ok) return { latest: result, lastGood: result, strikes: 0, retryAt: null };
  // Only a 429 means "stop asking"; any other failure retries on the normal cadence.
  if (result.reason !== "rate-limited") return { ...previous, latest: result, retryAt: null };
  const strikes = previous.strikes + 1;
  const backoff = Math.min(CONFIG.poll.quotaMs * 2 ** strikes, MAX_BACKOFF_MS);
  return { ...previous, latest: result, strikes, retryAt: now + Math.max(backoff, result.retryAfterMs ?? 0) };
}

/**
 * Whether a provider may be called now. A backoff blocks every caller; a
 * reading younger than `freshForMs` is left alone.
 */
export function isDue(anchor: QuotaAnchor, now: EpochMs, freshForMs: number): boolean {
  if (anchor.retryAt !== null && now < anchor.retryAt) return false;
  return anchor.lastGood === null || now - anchor.lastGood.fetchedAt >= freshForMs;
}

/** When the newest reading on screen was taken. */
export function newestReading(anchors: Anchors): EpochMs | null {
  const times = [anchors.claude, anchors.codex, anchors.zai].flatMap((a) =>
    a.lastGood === null ? [] : [a.lastGood.fetchedAt],
  );
  return times.length === 0 ? null : Math.max(...times);
}

/* ------------------------------------------------------------ persistence */

const FAILURE_REASONS: readonly QuotaFailureReason[] = [
  "no-credentials",
  "credentials-expired",
  "rate-limited",
  "http-error",
  "network-error",
  "parse-error",
  "no-plan",
];

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readWindow(value: unknown): QuotaWindow | null {
  if (!isRecord(value)) return null;
  const key = asString(value["key"]);
  const label = asString(value["label"]);
  const utilization = asFiniteNumber(value["utilization"]);
  if (key === null || label === null || utilization === null) return null;
  return { key, label, utilization, resetsAt: asFiniteNumber(value["resetsAt"]) };
}

function readSuccess(value: unknown): QuotaSuccess | null {
  if (!isRecord(value) || value["ok"] !== true) return null;
  const provider = asString(value["provider"]);
  const fetchedAt = asFiniteNumber(value["fetchedAt"]);
  const windows = list(value["windows"]).map(readWindow).filter((w): w is QuotaWindow => w !== null);
  if (provider === null || fetchedAt === null || windows.length === 0) return null;
  const notes = list(value["notes"]).filter((n): n is string => typeof n === "string");
  return { ok: true, provider, fetchedAt, windows, notes };
}

function readFailure(value: unknown): QuotaFailure | null {
  if (!isRecord(value) || value["ok"] !== false) return null;
  const provider = asString(value["provider"]);
  const reason = FAILURE_REASONS.find((r) => r === value["reason"]);
  const detail = asString(value["detail"]);
  if (provider === null || reason === undefined || detail === null) return null;
  return { ok: false, provider, reason, detail, retryAfterMs: asFiniteNumber(value["retryAfterMs"]) };
}

function readAnchor(value: unknown): QuotaAnchor {
  if (!isRecord(value)) return NO_ANCHOR;
  const latest = readSuccess(value["latest"]) ?? readFailure(value["latest"]);
  const strikes = asFiniteNumber(value["strikes"]);
  return {
    latest,
    // A success is by definition the last good reading; keep that true for a hand-edited file.
    lastGood: latest?.ok === true ? latest : readSuccess(value["lastGood"]),
    strikes: strikes !== null && strikes > 0 ? Math.trunc(strikes) : 0,
    retryAt: asFiniteNumber(value["retryAt"]),
  };
}

export function loadAnchors(): Anchors {
  let text: string;
  try {
    text = readFileSync(PATHS.quotaAnchors, "utf8");
  } catch (err) {
    // First run, or an unreadable state dir: start empty, as before this file existed.
    if (err instanceof Error && "code" in err) return { claude: NO_ANCHOR, codex: NO_ANCHOR, zai: NO_ANCHOR };
    throw err;
  }
  const parsed = parseJson(text);
  const root = parsed.ok ? child(parsed.value, "anchors") : null;
  return { claude: readAnchor(root?.["claude"]), codex: readAnchor(root?.["codex"]), zai: readAnchor(root?.["zai"]) };
}

export function saveAnchors(anchors: Anchors): void {
  const body = { version: 1, anchors: { claude: anchors.claude, codex: anchors.codex, zai: anchors.zai } };
  try {
    mkdirSync(dirname(PATHS.quotaAnchors), { recursive: true });
    writeFileSync(PATHS.quotaAnchors, `${JSON.stringify(body)}\n`, "utf8");
  } catch (err) {
    // The file is a cache: an unwritable state dir costs the restart shortcut,
    // never the widget. Anything other than a filesystem error is a bug.
    if (!(err instanceof Error && "code" in err)) throw err;
  }
}
