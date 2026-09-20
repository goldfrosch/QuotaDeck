/**
 * Advisory single-flight lock for credential writes.
 *
 * Deliberately the same shape as the lock `opencode-claude-auth` uses
 * (open O_EXCL, TTL, stale takeover by mtime, degrade-open on FS error) --
 * that design is already proven against this exact failure mode, and matching
 * it means a future write path can join their directory instead of inventing
 * a second, incompatible protocol.
 *
 * "Advisory" and "best-effort" are intentional: a filesystem error degrades to
 * running without the lock rather than wedging custody, and a crashed holder
 * cannot block forever because the lock carries a TTL.
 */

import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PATHS } from "../paths.ts";

export interface Lock {
  release(): void;
}

export const DEFAULT_LOCK_TTL_MS = 20_000;

const NOOP_LOCK: Lock = { release() {} };

function lockPath(name: string): string {
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 16);
  return join(PATHS.stateDir, `custody-${digest}.lock`);
}

/**
 * Returns a lock when this process may proceed, or null when a live holder
 * owns it -- in which case the caller must NOT write, and should re-read the
 * store to adopt whatever the winner produced.
 */
export function acquireLock(name: string, ttlMs: number = DEFAULT_LOCK_TTL_MS, now: () => number = Date.now): Lock | null {
  const path = lockPath(name);
  try {
    mkdirSync(PATHS.stateDir, { recursive: true });
  } catch {
    // Non-fatal; the open below surfaces anything that actually matters.
  }

  // Two attempts: the second only runs after clearing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return NOOP_LOCK;
      let stale: boolean;
      try {
        stale = now() - statSync(path).mtimeMs > ttlMs;
      } catch {
        stale = true; // vanished between open and stat -- retry
      }
      if (!stale) return null;
      try {
        unlinkSync(path);
      } catch {
        // lost the race to remove it; the next attempt settles it
      }
      continue;
    }

    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, ts: now() }));
    } catch {
      // held regardless of whether the payload wrote
    }
    return {
      release() {
        try {
          closeSync(fd);
        } catch {
          // already closed
        }
        try {
          unlinkSync(path);
        } catch {
          // already gone (a stale takeover may have removed it)
        }
      },
    };
  }
  return null;
}
