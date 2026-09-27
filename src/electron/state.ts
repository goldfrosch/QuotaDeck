/**
 * The snapshot the renderer draws. Secret-free by construction: it is built
 * from `StoreSnapshot` (fingerprints only) and quota results, so it is safe to
 * push across the context bridge.
 */

import type {
  CustodyAction,
  EpochMs,
  LocalUsage,
  QuotaResult,
  QuotaSuccess,
  StoreConfigStatus,
  StoreSnapshot,
  StoreId,
} from "../core/types.ts";

export interface CustodyEntry {
  readonly storeId: StoreId;
  readonly provider: string;
  readonly action: CustodyAction;
  readonly detail: string;
}

export interface CustodyReport {
  readonly at: EpochMs;
  readonly applied: boolean;
  readonly entries: readonly CustodyEntry[];
}

/**
 * One provider's quota band. `latest` is what the most recent call returned;
 * `lastGood` is the newest success and outlives every failure after it, so a
 * 429, a network blip or a restart shows the old numbers marked stale instead
 * of blanking the band. `anchors.ts` owns the transitions.
 */
export interface QuotaAnchor {
  /** Outcome of the most recent call; null until the first one. */
  readonly latest: QuotaResult | null;
  readonly lastGood: QuotaSuccess | null;
  /** Consecutive 429s, the backoff exponent. Only a success resets it. */
  readonly strikes: number;
  /** While backing off from a 429, no call -- timed or manual -- goes out before this. */
  readonly retryAt: EpochMs | null;
}

export const NO_ANCHOR: QuotaAnchor = { latest: null, lastGood: null, strikes: 0, retryAt: null };

export interface DeckState {
  readonly updatedAt: EpochMs;
  readonly claude: QuotaAnchor;
  readonly codex: QuotaAnchor;
  readonly zai: QuotaAnchor;
  readonly local: LocalUsage | null;
  readonly localError: string | null;
  readonly stores: readonly StoreSnapshot[];
  /** How the user's stores.json was applied; null until the first store poll. */
  readonly storeConfig: StoreConfigStatus | null;
  readonly custody: CustodyReport | null;
  /** When the newest quota reading on screen was taken; null before the first. */
  readonly anchoredAt: EpochMs | null;
}

export function emptyState(): DeckState {
  return {
    updatedAt: Date.now(),
    claude: NO_ANCHOR,
    codex: NO_ANCHOR,
    zai: NO_ANCHOR,
    local: null,
    localError: null,
    stores: [],
    storeConfig: null,
    custody: null,
    anchoredAt: null,
  };
}

/** Worst utilization across every known window, stale readings included; drives the tray colour. */
export function worstUtilization(state: DeckState): number {
  let worst = 0;
  for (const anchor of [state.claude, state.codex, state.zai]) {
    for (const window of anchor.lastGood?.windows ?? []) worst = Math.max(worst, window.utilization);
  }
  return worst;
}
