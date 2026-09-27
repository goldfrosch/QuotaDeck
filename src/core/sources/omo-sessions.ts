/**
 * Local usage recorded by omo native -- the fast path's second source.
 *
 * opencode's database only sees opencode. omo logs every model call to
 * append-only JSONL instead: interactive sessions under its agent dir, and the
 * memory agents that run beside them under `memory/agents/<agent>/runtime`
 * (those run on the ChatGPT subscription, so they are most of a typical day's
 * Codex traffic). Each assistant entry carries
 * `message.{provider, model, usage, timestamp}` -- the same signal the
 * database gives -- so the widget keeps moving for someone who left opencode
 * for omo.
 *
 * This is polled every couple of seconds, so files are read incrementally:
 * only the bytes appended since the last poll, up to the last complete line.
 * A file untouched since the window opened holds nothing inside it and is
 * skipped without being read.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../paths.ts";
import { asEpochMs, asFiniteNumber, asString, child, isRecord, parseJson } from "../json.ts";
import { HISTOGRAM_SLOTS } from "./opencode-db.ts";
import type { LocalUsage, UsageBucket } from "../types.ts";

type Tally = { -readonly [K in keyof UsageBucket]: UsageBucket[K] };

interface Call {
  /** Entry id + timestamp: a call copied into a forked session counts once. */
  readonly identity: string;
  readonly at: number;
  /** `provider/model`, the same key shape as opencode's buckets. */
  readonly key: string;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
}

interface Tail {
  /** Bytes consumed so far; always just past a newline. */
  offset: number;
  calls: Call[];
}

/** Per-file read position and the calls parsed from it, kept between polls. */
const tails = new Map<string, Tail>();

function num(value: unknown): number {
  return asFiniteNumber(value) ?? 0;
}

function readCall(line: string): Call | null {
  const parsed = parseJson(line);
  if (!parsed.ok || !isRecord(parsed.value)) return null;
  const entry = parsed.value;
  const message = child(entry, "message");
  if (message === null || message["role"] !== "assistant") return null;
  const usage = child(message, "usage");
  const at = asEpochMs(message["timestamp"]) ?? asEpochMs(entry["timestamp"]);
  if (usage === null || at === null) return null;
  const input = num(usage["input"]);
  const output = num(usage["output"]);
  const cacheRead = num(usage["cacheRead"]);
  const cacheWrite = num(usage["cacheWrite"]);
  // A call that failed before streaming logs all zeros: it spent nothing.
  if (input + output + cacheRead + cacheWrite === 0) return null;
  const provider = asString(message["provider"]) ?? "?";
  return {
    identity: `${asString(entry["id"]) ?? ""}@${at}`,
    at,
    key: `${provider}/${asString(message["model"]) ?? "?"}`,
    input,
    output,
    cacheRead,
    cacheWrite,
    // omo prices subscription calls at list rates too, but they are plan-billed;
    // opencode logs those at 0, which is what the Activity view's "plan billed" reads.
    costUsd: provider.endsWith("-subscription") ? 0 : num(child(usage, "cost")?.["total"]),
  };
}

function list(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return []; // absent (omo not installed) or unreadable
  }
}

/** Every `.jsonl` under the session roots. */
function logFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    for (const entry of list(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 6) walk(path, depth + 1);
      } else if (entry.name.endsWith(".jsonl")) {
        found.push(path);
      }
    }
  };
  walk(PATHS.omoSessions, 0);
  // Only `runtime/`: the rest of an agent dir is its git-backed memory repo.
  for (const agent of list(PATHS.omoMemoryAgents)) {
    if (agent.isDirectory()) walk(join(PATHS.omoMemoryAgents, agent.name, "runtime"), 0);
  }
  return found;
}

/** Parses whatever complete lines were appended since the last poll. */
function advance(path: string, tail: Tail, size: number): void {
  const length = size - tail.offset;
  if (length <= 0) return;
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  let read = 0;
  try {
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, tail.offset + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }
  // Stop at the last newline: a line still being written waits for the next poll.
  const end = buffer.subarray(0, read).lastIndexOf(0x0a);
  if (end < 0) return;
  for (const line of buffer.toString("utf8", 0, end).split("\n")) {
    // Cheap filter first: most lines are tool output, not assistant turns.
    if (!line.includes('"assistant"')) continue;
    const call = readCall(line);
    if (call !== null) tail.calls.push(call);
  }
  tail.offset += end + 1;
}

function add(buckets: Map<string, Tally>, key: string, part: Omit<UsageBucket, "key">): void {
  const sum = buckets.get(key);
  if (sum === undefined) {
    buckets.set(key, { key, ...part });
    return;
  }
  sum.messages += part.messages;
  sum.input += part.input;
  sum.output += part.output;
  sum.reasoning += part.reasoning;
  sum.cacheRead += part.cacheRead;
  sum.cacheWrite += part.cacheWrite;
  sum.costUsd += part.costUsd;
}

function sorted(buckets: Map<string, Tally>): UsageBucket[] {
  return [...buckets.values()].sort((a, b) => b.output - a.output);
}

/**
 * Aggregates omo's assistant calls over a rolling window. Never throws: a
 * machine without omo simply reads as empty.
 *
 * @param now injectable clock; pass the same value to `readLocalUsage` before merging
 */
export function readOmoUsage(windowHours: number, now: number = Date.now()): LocalUsage {
  const started = performance.now();
  const since = now - windowHours * 3_600_000;
  const current = new Set<string>();
  for (const path of logFiles()) {
    try {
      const { size, mtimeMs } = statSync(path);
      if (mtimeMs < since) continue;
      current.add(path);
      let tail = tails.get(path);
      if (tail === undefined || size < tail.offset) {
        // New, or rewritten in place: start over.
        tail = { offset: 0, calls: [] };
        tails.set(path, tail);
      }
      advance(path, tail, size);
      tail.calls = tail.calls.filter((call) => call.at >= since);
    } catch {
      // Vanished or locked mid-poll; the next poll resumes from the same offset.
    }
  }
  for (const path of [...tails.keys()]) if (!current.has(path)) tails.delete(path);

  const seen = new Set<string>();
  const buckets = new Map<string, Tally>();
  const histogram = new Array<number>(HISTOGRAM_SLOTS).fill(0);
  const slotMs = (windowHours * 3_600_000) / HISTOGRAM_SLOTS;
  let totalCostUsd = 0;
  let totalMessages = 0;
  for (const tail of tails.values()) {
    for (const call of tail.calls) {
      if (seen.has(call.identity)) continue;
      seen.add(call.identity);
      const slot = Math.min(HISTOGRAM_SLOTS - 1, Math.max(0, Math.floor((call.at - since) / slotMs)));
      histogram[slot] = (histogram[slot] ?? 0) + 1;
      add(buckets, call.key, {
        messages: 1,
        input: call.input,
        output: call.output,
        reasoning: 0,
        cacheRead: call.cacheRead,
        cacheWrite: call.cacheWrite,
        costUsd: call.costUsd,
      });
      totalCostUsd += call.costUsd;
      totalMessages += 1;
    }
  }

  return {
    windowHours,
    since,
    totalCostUsd,
    totalMessages,
    buckets: sorted(buckets),
    histogram,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** Sums two readings of the same window (same `now`, same slot count). */
export function mergeUsage(a: LocalUsage, b: LocalUsage): LocalUsage {
  const buckets = new Map<string, Tally>();
  for (const { key, ...part } of [...a.buckets, ...b.buckets]) add(buckets, key, part);
  return {
    windowHours: a.windowHours,
    since: a.since,
    totalCostUsd: a.totalCostUsd + b.totalCostUsd,
    totalMessages: a.totalMessages + b.totalMessages,
    buckets: sorted(buckets),
    histogram: a.histogram.map((count, slot) => count + (b.histogram[slot] ?? 0)),
    elapsedMs: a.elapsedMs + b.elapsedMs,
  };
}
