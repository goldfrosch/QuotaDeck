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

export interface DeckState {
  readonly updatedAt: EpochMs;
  readonly claude: QuotaResult | null;
  readonly codex: QuotaResult | null;
  readonly zai: QuotaResult | null;
  readonly local: LocalUsage | null;
  readonly localError: string | null;
  readonly stores: readonly StoreSnapshot[];
  /** How the user's stores.json was applied; null until the first store poll. */
  readonly storeConfig: StoreConfigStatus | null;
  readonly custody: CustodyReport | null;
  /** When the slow quota anchors were last refreshed. */
  readonly anchoredAt: EpochMs | null;
}

export function emptyState(): DeckState {
  return {
    updatedAt: Date.now(),
    claude: null,
    codex: null,
    zai: null,
    local: null,
    localError: null,
    stores: [],
    storeConfig: null,
    custody: null,
    anchoredAt: null,
  };
}

/** Worst utilization across every known window; drives the tray colour. */
export function worstUtilization(state: DeckState): number {
  let worst = 0;
  for (const result of [state.claude, state.codex, state.zai]) {
    if (result === null || !result.ok) continue;
    for (const window of result.windows) worst = Math.max(worst, window.utilization);
  }
  return worst;
}
