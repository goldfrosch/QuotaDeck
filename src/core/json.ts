/**
 * Minimal, total helpers for walking untrusted JSON without `any`.
 *
 * Every credential store we read is written by a third-party tool that can
 * change its schema at any release, so parsing is deliberately defensive:
 * a shape we don't recognise degrades to `null` rather than throwing.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Reads `obj[key]` as a nested record, or null. */
export function child(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const next = value[key];
  return isRecord(next) ? next : null;
}

/** Parses an ISO-8601 timestamp to epoch ms, or null. */
export function asIsoEpochMs(value: unknown): number | null {
  const raw = asString(value);
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Accepts either an ISO string or a numeric epoch (seconds or milliseconds)
 * and normalises to epoch ms. Values below ~year 2001 in ms are treated as
 * seconds, which is how every store we read encodes them.
 */
export function asEpochMs(value: unknown): number | null {
  const iso = asIsoEpochMs(value);
  if (iso !== null) return iso;
  const n = asFiniteNumber(value);
  if (n === null) return null;
  return n < 1_000_000_000_000 ? Math.trunc(n * 1000) : Math.trunc(n);
}

export function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
