/**
 * Local opencode usage, read straight out of its SQLite database.
 *
 * This is the *fast path* of the anchor+dead-reckoning design: the quota APIs
 * are rate limited and can only be polled every few minutes, but this costs
 * nothing and can run every second. Measured on a 3.2 GB / 58k-message
 * database, a 5-hour window aggregates in ~46 ms.
 *
 * The connection is opened read-only and closed immediately after each query.
 * opencode is usually running and writing to this database (WAL mode), so we
 * never hold it open and never take a write lock.
 *
 * Note: `message` is indexed on `(session_id, time_created, id)` but has no
 * standalone index on `time_created`, so a window query is a full scan. That
 * is fine at the current row count; if it stops being fine, the fix is to keep
 * a cursor on the last seen `time_created` and scan only the tail.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { PATHS } from "../paths.ts";
import { asFiniteNumber, child, isRecord, parseJson } from "../json.ts";
import type { LocalUsage, UsageBucket } from "../types.ts";

interface MutableBucket {
  messages: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

function emptyBucket(): MutableBucket {
  return { messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
}

function num(value: unknown): number {
  return asFiniteNumber(value) ?? 0;
}

export class OpencodeDbUnavailable extends Error {
  public override readonly name = "OpencodeDbUnavailable";
}

/**
 * Time slots in the activity histogram. Sixteen is what the widget has room to
 * draw at 380px without the bars collapsing into a smear.
 */
const HISTOGRAM_SLOTS = 16;

/**
 * Aggregates assistant-message token usage over a rolling window.
 *
 * @param windowHours size of the rolling window, in hours
 * @param now        injectable clock, for tests
 */
export function readLocalUsage(windowHours: number, now: number = Date.now()): LocalUsage {
  const dbPath = PATHS.opencodeDb;
  if (!existsSync(dbPath)) {
    throw new OpencodeDbUnavailable(`opencode database not found at ${dbPath}`);
  }

  const since = now - windowHours * 3_600_000;
  const started = performance.now();

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    const statement = db.prepare("SELECT data, time_created FROM message WHERE time_created >= ?");
    rows = statement.all(since) as ReadonlyArray<Record<string, unknown>>;
  } finally {
    db.close();
  }

  const buckets = new Map<string, MutableBucket>();
  const histogram = new Array<number>(HISTOGRAM_SLOTS).fill(0);
  const slotMs = (windowHours * 3_600_000) / HISTOGRAM_SLOTS;
  let totalCostUsd = 0;
  let totalMessages = 0;

  for (const row of rows) {
    const raw = row["data"];
    if (typeof raw !== "string") continue;
    const parsed = parseJson(raw);
    if (!parsed.ok || !isRecord(parsed.value)) continue;
    const message = parsed.value;
    if (message["role"] !== "assistant") continue;

    const createdAt = asFiniteNumber(row["time_created"]);
    if (createdAt !== null) {
      const slot = Math.floor((createdAt - since) / slotMs);
      const clamped = slot < 0 ? 0 : slot >= HISTOGRAM_SLOTS ? HISTOGRAM_SLOTS - 1 : slot;
      histogram[clamped] = (histogram[clamped] ?? 0) + 1;
    }

    const key = `${String(message["providerID"] ?? "?")}/${String(message["modelID"] ?? "?")}`;
    const bucket = buckets.get(key) ?? emptyBucket();
    const tokens = child(message, "tokens");
    const cache = tokens === null ? null : child(tokens, "cache");

    bucket.messages += 1;
    bucket.input += tokens === null ? 0 : num(tokens["input"]);
    bucket.output += tokens === null ? 0 : num(tokens["output"]);
    bucket.reasoning += tokens === null ? 0 : num(tokens["reasoning"]);
    bucket.cacheRead += cache === null ? 0 : num(cache["read"]);
    bucket.cacheWrite += cache === null ? 0 : num(cache["write"]);
    bucket.costUsd += num(message["cost"]);
    buckets.set(key, bucket);

    totalCostUsd += num(message["cost"]);
    totalMessages += 1;
  }

  const sorted: UsageBucket[] = [...buckets.entries()]
    .map(([key, b]): UsageBucket => ({ key, ...b }))
    .sort((a, b) => b.output - a.output);

  return {
    windowHours,
    since,
    totalCostUsd,
    totalMessages,
    buckets: sorted,
    histogram,
    elapsedMs: Math.round(performance.now() - started),
  };
}
