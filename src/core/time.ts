import type { EpochMs, ExpiryState } from "./types.ts";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** Refresh threshold: anything inside this window is "expiring". */
export const EXPIRING_WINDOW_MS = 15 * MINUTE_MS;

export function expiryState(expiresAt: EpochMs | null, now: EpochMs = Date.now()): ExpiryState {
  if (expiresAt === null) return "unknown";
  if (expiresAt <= now) return "expired";
  if (expiresAt - now <= EXPIRING_WINDOW_MS) return "expiring";
  return "fresh";
}

/** "in 2.7h" / "42 min ago" / "-" */
export function relative(target: EpochMs | null, now: EpochMs = Date.now()): string {
  if (target === null) return "-";
  const delta = target - now;
  const abs = Math.abs(delta);
  const suffix = delta >= 0 ? "" : " ago";
  const prefix = delta >= 0 ? "in " : "";
  if (abs < MINUTE_MS) return `${prefix}${Math.round(abs / 1000)}s${suffix}`;
  if (abs < HOUR_MS) return `${prefix}${Math.round(abs / MINUTE_MS)} min${suffix}`;
  if (abs < DAY_MS) return `${prefix}${(abs / HOUR_MS).toFixed(1)}h${suffix}`;
  return `${prefix}${(abs / DAY_MS).toFixed(1)}d${suffix}`;
}

export function stamp(target: EpochMs | null): string {
  if (target === null) return "-";
  const d = new Date(target);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
