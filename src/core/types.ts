/**
 * Domain types for quotadeck.
 *
 * Two hard rules encoded here:
 *  1. Secrets never leave the process. Tokens are represented only by a
 *     short fingerprint, so a record can be logged or sent to the renderer
 *     without leaking credentials.
 *  2. Ownership is explicit. `observed` stores belong to another refresher
 *     (today: the `opencode-claude-auth` plugin). We never write those --
 *     Anthropic refresh tokens are single-use and rotate, so a second writer
 *     deterministically breaks one of the two owners.
 */

/** Epoch milliseconds. */
export type EpochMs = number;

/**
 * Stores are data, not code: the built-in catalog in `catalog.ts` can be
 * extended or overridden from `stores.json`, so an id is any string.
 */
export type StoreId = string;

/** On-disk shape of a store. Each format has exactly one parser and writer. */
export type StoreFormat = "claude-code" | "opencode-auth" | "opencode-account" | "codex";

export const STORE_FORMATS: readonly StoreFormat[] = ["claude-code", "opencode-auth", "opencode-account", "codex"];

/**
 * `observed` -> read-only. Another process owns refresh.
 * `owned`    -> quotadeck is the sole refresher; nobody else touches it.
 */
export type Ownership = "observed" | "owned";

export type CredentialKind = "oauth" | "api";

export type ExpiryState = "fresh" | "expiring" | "expired" | "unknown";

export interface CredentialRecord {
  readonly storeId: StoreId;
  readonly ownership: Ownership;
  /** Provider slug as the host tool names it: anthropic, openai, zai, ... */
  readonly provider: string;
  readonly kind: CredentialKind;
  /** Free-form sub-identity within a store (account id, service id). */
  readonly label: string | null;
  readonly expiresAt: EpochMs | null;
  /** Only Claude Code records this; null elsewhere. */
  readonly refreshExpiresAt: EpochMs | null;
  /** sha256(token)[0..12). Never the token itself. */
  readonly accessFingerprint: string | null;
  readonly refreshFingerprint: string | null;
}

export interface StoreSnapshot {
  readonly storeId: StoreId;
  readonly format: StoreFormat;
  /** Whether the entry came from the built-in catalog or the user's stores.json. */
  readonly source: "builtin" | "user";
  readonly path: string;
  readonly ownership: Ownership;
  readonly exists: boolean;
  /** Null when the store parsed cleanly. */
  readonly error: string | null;
  readonly records: readonly CredentialRecord[];
}

/** Outcome of reading the user's stores.json, for display. */
export interface StoreConfigStatus {
  readonly path: string;
  readonly state: "absent" | "loaded" | "invalid";
  /** One line per rejected entry, or the parse error. Empty when clean. */
  readonly errors: readonly string[];
}

/* ------------------------------------------------------------------ quota */

export interface QuotaWindow {
  /** Stable machine key, e.g. `five_hour`. */
  readonly key: string;
  readonly label: string;
  /** Percent consumed, 0..100. */
  readonly utilization: number;
  readonly resetsAt: EpochMs | null;
}

export type QuotaFailureReason =
  | "no-credentials"
  | "credentials-expired"
  | "rate-limited"
  | "http-error"
  | "network-error"
  | "parse-error"
  /** Authenticated fine, but the account carries no subscription to report. */
  | "no-plan";

export interface QuotaFailure {
  readonly ok: false;
  readonly provider: string;
  readonly reason: QuotaFailureReason;
  readonly detail: string;
  /** Present when the server told us when to come back. */
  readonly retryAfterMs: number | null;
}

export interface QuotaSuccess {
  readonly ok: true;
  readonly provider: string;
  readonly fetchedAt: EpochMs;
  readonly windows: readonly QuotaWindow[];
  /** Provider-specific extras worth surfacing, already stringified. */
  readonly notes: readonly string[];
}

export type QuotaResult = QuotaSuccess | QuotaFailure;

/* ------------------------------------------------------------- local usage */

export interface UsageBucket {
  /** `providerID/modelID` */
  readonly key: string;
  readonly messages: number;
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly costUsd: number;
}

export interface LocalUsage {
  readonly windowHours: number;
  readonly since: EpochMs;
  readonly totalCostUsd: number;
  readonly totalMessages: number;
  readonly buckets: readonly UsageBucket[];
  /** Assistant messages per equal-width time slot across the window, oldest first. */
  readonly histogram: readonly number[];
  readonly elapsedMs: number;
}

/* ----------------------------------------------------------------- custody */

export type CustodyAction =
  | "planned"
  | "skipped-fresh"
  | "skipped-no-refresh-token"
  | "adopted"
  | "refreshed"
  | "failed";

export interface CustodyOutcome {
  readonly storeId: StoreId;
  readonly provider: string;
  readonly action: CustodyAction;
  readonly detail: string;
  readonly newExpiresAt: EpochMs | null;
}
