/**
 * Custody policy: decide what to do with each credential, without doing it.
 *
 * Two rules, both learned the hard way.
 *
 * RULE 1 -- ADOPT BEFORE REFRESH.
 * Both providers issue single-use, rotating refresh tokens, so every call to a
 * token endpoint invalidates the previous one. If two processes refresh the
 * same credential, one is guaranteed to end up holding a dead token: the
 * "suddenly logged out" symptom this tool exists to remove. The observed
 * credentials already have competent owners (the `claude` CLI and the
 * opencode-claude-auth plugin, with cross-process locking, proactive refresh
 * and 401 recovery), so for an orphan we prefer to COPY a live token someone
 * else already produced. Copying touches no endpoint, rotates nothing, and
 * therefore cannot race by construction.
 *
 * RULE 2 -- NEVER ROTATE A SHARED REFRESH TOKEN.
 * Adoption copies the refresh token too, so an orphan stays usable on its own.
 * That means one grant can legitimately live in several files -- and rotating
 * it in one would silently kill it in all the others. An earlier version
 * rotated Codex's adopted grant and stranded opencode's copy, which is exactly
 * the failure this tool exists to prevent. So a refresh token visible in more
 * than one store is untouchable: quotadeck mirrors it and lets the real owners
 * rotate.
 *
 * Net effect: quotadeck converges every store onto the freshest token it can
 * find, and only ever rotates a grant that nothing else holds.
 *
 * This module is secret-free. Plans carry fingerprints so they can be printed
 * and shown in the UI; `run.ts` re-resolves the actual tokens.
 */

import type { LoadedStore } from "../stores.ts";
import type { EpochMs, StoreId } from "../types.ts";

/** Do not adopt a donor that is about to expire anyway. */
export const DONOR_MIN_REMAINING_MS = 60_000;

export type PlanActionKind = "skip" | "adopt" | "refresh";

export interface PlanItem {
  readonly storeId: StoreId;
  readonly provider: string;
  readonly kind: PlanActionKind;
  readonly reason: string;
  /** True when a `skip` means "already at the converged state", as opposed to
   *  "blocked and needs attention". Callers must not infer this from `reason`. */
  readonly converged: boolean;
  /** Donor store for `adopt`; null otherwise. */
  readonly donor: StoreId | null;
  readonly currentFingerprint: string | null;
  readonly currentExpiresAt: EpochMs | null;
  readonly targetFingerprint: string | null;
  readonly targetExpiresAt: EpochMs | null;
}

interface Donor {
  readonly storeId: StoreId;
  readonly fingerprint: string | null;
  readonly expiresAt: EpochMs;
}

/**
 * Newest live OAuth token for `provider` held by some *other* store, but only
 * if it is strictly newer than `mineExpiresAt`.
 *
 * The strictness matters. Without it, two stores holding tokens a minute apart
 * each see the other as a donor and copy backwards forever -- observed in
 * practice as Codex and opencode's account store swapping the same pair of
 * tokens on every tick. Requiring a strict improvement makes convergence
 * monotonic: every adoption moves a store closer to the single newest token,
 * and the newest holder never moves.
 */
function findDonor(
  stores: readonly LoadedStore[],
  provider: string,
  exclude: StoreId,
  now: EpochMs,
  mineExpiresAt: EpochMs | null,
): Donor | null {
  const floor = mineExpiresAt ?? 0;
  let best: Donor | null = null;
  for (const store of stores) {
    if (store.storeId === exclude || !store.spec.donor) continue;
    for (const credential of store.credentials) {
      const record = credential.record;
      if (record.provider !== provider || record.kind !== "oauth") continue;
      if (credential.accessToken === null) continue;
      const expiresAt = record.expiresAt;
      if (expiresAt === null || expiresAt - now < DONOR_MIN_REMAINING_MS) continue;
      if (expiresAt <= floor) continue;
      if (best === null || expiresAt > best.expiresAt) {
        best = { storeId: store.storeId, fingerprint: record.accessFingerprint, expiresAt };
      }
    }
  }
  return best;
}

/** The other store holding this exact refresh token, if any. */
function refreshSharedWith(
  stores: readonly LoadedStore[],
  storeId: StoreId,
  refreshFingerprint: string | null,
): StoreId | null {
  if (refreshFingerprint === null) return null;
  for (const store of stores) {
    if (store.storeId === storeId) continue;
    for (const credential of store.credentials) {
      if (credential.record.refreshFingerprint === refreshFingerprint) return store.storeId;
    }
  }
  return null;
}

export function planCustody(stores: readonly LoadedStore[], now: EpochMs = Date.now()): readonly PlanItem[] {
  const items: PlanItem[] = [];

  for (const store of stores) {
    for (const credential of store.credentials) {
      const record = credential.record;
      if (record.kind !== "oauth") continue;
      // Hard gate, evaluated per (store, provider): a credential another
      // process rotates is never a write target.
      if (record.ownership !== "owned") continue;

      const base = {
        storeId: store.storeId,
        provider: record.provider,
        currentFingerprint: record.accessFingerprint,
        currentExpiresAt: record.expiresAt,
      } as const;

      const donor = findDonor(stores, record.provider, store.storeId, now, record.expiresAt);
      if (donor !== null) {
        items.push({
          ...base,
          kind: "adopt",
          reason: `copy newer token from ${donor.storeId} (no rotation, cannot race)`,
          converged: false,
          donor: donor.storeId,
          targetFingerprint: donor.fingerprint,
          targetExpiresAt: donor.expiresAt,
        });
        continue;
      }

      // Nothing strictly newer exists. If what we hold is still live, this
      // store is already at the converged state.
      if (record.expiresAt !== null && record.expiresAt - now >= DONOR_MIN_REMAINING_MS) {
        items.push({
          ...base,
          kind: "skip",
          reason: "holds the newest token available",
          converged: true,
          donor: null,
          targetFingerprint: record.accessFingerprint,
          targetExpiresAt: record.expiresAt,
        });
        continue;
      }

      // Expired, and nothing live to copy. Rotation is the only option left,
      // and it is allowed only if this grant is ours alone.
      const sharedWith = refreshSharedWith(stores, store.storeId, record.refreshFingerprint);
      if (sharedWith !== null) {
        items.push({
          ...base,
          kind: "skip",
          reason: `refresh token is shared with ${sharedWith}; rotating it would strand that store`,
          converged: false,
          donor: null,
          targetFingerprint: null,
          targetExpiresAt: null,
        });
        continue;
      }

      items.push({
        ...base,
        kind: credential.refreshToken === null ? "skip" : "refresh",
        reason:
          credential.refreshToken === null
            ? "no live donor and no refresh token -- needs interactive re-login"
            : "no live token anywhere to copy and this grant is held by no one else",
        converged: false,
        donor: null,
        targetFingerprint: null,
        targetExpiresAt: null,
      });
    }
  }

  return items;
}
