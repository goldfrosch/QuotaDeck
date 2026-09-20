/**
 * Executes a custody plan.
 *
 * Writes are batched per store: every credential in one file is folded into a
 * single cloned root and written once, so a store with two stale providers
 * takes one atomic replace rather than two, and never ends up half-updated.
 */

import { readFileSync } from "node:fs";
import { acquireLock } from "./lock.ts";
import { refreshFor } from "./oauth.ts";
import { applyToAccountJson, applyToCodexJson, applyToOpencodeAuthJson, atomicWriteJson } from "./writers.ts";
import type { ApplyResult, TokenUpdate } from "./writers.ts";
import type { PlanItem } from "./plan.ts";
import { fingerprint } from "../secret.ts";
import type { LoadedCredential, LoadedStore } from "../stores.ts";
import type { CustodyAction, EpochMs, StoreId } from "../types.ts";

export interface ExecutionResult {
  readonly item: PlanItem;
  readonly action: CustodyAction;
  readonly detail: string;
  readonly newFingerprint: string | null;
  readonly newExpiresAt: EpochMs | null;
  readonly backupPath: string | null;
}

function applyFor(storeId: StoreId, root: unknown, provider: string, update: TokenUpdate): ApplyResult {
  if (storeId === "opencode-account") return applyToAccountJson(root, provider, update);
  if (storeId === "codex") return applyToCodexJson(root, update);
  if (storeId === "opencode-auth-xdg" || storeId === "opencode-auth-localappdata") {
    return applyToOpencodeAuthJson(root, provider, update);
  }
  return { ok: false, error: `no writer registered for store "${storeId}"` };
}

function donorCredential(
  stores: readonly LoadedStore[],
  donorId: StoreId,
  provider: string,
): LoadedCredential | null {
  const store = stores.find((s) => s.storeId === donorId);
  if (store === undefined) return null;
  return (
    store.credentials.find(
      (c) => c.record.provider === provider && c.record.kind === "oauth" && c.accessToken !== null,
    ) ?? null
  );
}

function adoptUpdate(donor: LoadedCredential): TokenUpdate | null {
  if (donor.accessToken === null) return null;
  return {
    accessToken: donor.accessToken,
    // Mirror the donor's refresh token too, so the orphan stays usable if the
    // donor later disappears. We still never *call* the endpoint with it.
    refreshToken: donor.refreshToken ?? "",
    expiresAt: donor.record.expiresAt ?? Date.now(),
    idToken: null,
  };
}

/**
 * Resolves one plan item to a concrete token update, or an explanation.
 *
 * `apply` is load-bearing, not cosmetic. Both providers rotate refresh tokens
 * on use, so calling the token endpoint during a dry run would invalidate the
 * on-disk grant and then throw the replacement away -- destroying the
 * credential the command promised not to touch. A dry run therefore never
 * performs network rotation; adoption is safe to simulate because it only
 * copies a token that already exists.
 */
async function resolve(
  stores: readonly LoadedStore[],
  store: LoadedStore,
  item: PlanItem,
  apply: boolean,
): Promise<{ update: TokenUpdate; action: CustodyAction; detail: string } | { error: string; action: CustodyAction }> {
  if (item.kind === "adopt") {
    if (item.donor === null) return { error: "plan had no donor", action: "failed" };
    const donor = donorCredential(stores, item.donor, item.provider);
    const update = donor === null ? null : adoptUpdate(donor);
    if (update === null) return { error: `donor ${item.donor} no longer holds a usable token`, action: "failed" };
    return { update, action: "adopted", detail: `adopted from ${item.donor}` };
  }

  const credential = store.credentials.find(
    (c) => c.record.provider === item.provider && c.record.kind === "oauth",
  );
  const refreshToken = credential?.refreshToken ?? null;
  if (refreshToken === null) return { error: "no refresh token on disk", action: "skipped-no-refresh-token" };

  if (!apply) {
    const fallback = item.donor === null ? "" : `, else adopt from ${item.donor}`;
    return { error: `would rotate this store's grant at the token endpoint${fallback}`, action: "planned" };
  }

  const pending = refreshFor(item.provider, refreshToken);
  if (pending === null) return { error: `no refresh endpoint for provider "${item.provider}"`, action: "failed" };

  const result = await pending;
  if (result.ok) {
    return {
      update: {
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresAt: result.tokens.expiresAt,
        idToken: result.tokens.idToken,
      },
      action: "refreshed",
      detail: "rotated via token endpoint",
    };
  }

  // Documented fallback: a dead grant is exactly the case adoption exists for.
  if (item.donor !== null) {
    const donor = donorCredential(stores, item.donor, item.provider);
    const update = donor === null ? null : adoptUpdate(donor);
    if (update !== null) {
      return {
        update,
        action: "adopted",
        detail: `refresh failed (${result.reason}); adopted from ${item.donor} instead -- id_token left stale`,
      };
    }
  }
  return { error: `refresh failed: ${result.reason} -- ${result.detail}`, action: "failed" };
}

export async function runCustody(
  stores: readonly LoadedStore[],
  plan: readonly PlanItem[],
  options: { readonly apply: boolean },
): Promise<readonly ExecutionResult[]> {
  const results: ExecutionResult[] = [];
  const byStore = new Map<StoreId, PlanItem[]>();
  for (const item of plan) {
    if (item.kind === "skip") {
      results.push({
        item,
        action: item.converged ? "skipped-fresh" : "skipped-no-refresh-token",
        detail: item.reason,
        newFingerprint: null,
        newExpiresAt: null,
        backupPath: null,
      });
      continue;
    }
    const bucket = byStore.get(item.storeId) ?? [];
    bucket.push(item);
    byStore.set(item.storeId, bucket);
  }

  for (const [storeId, items] of byStore) {
    const store = stores.find((s) => s.storeId === storeId);
    if (store === undefined || store.raw === null) {
      for (const item of items) {
        results.push({ item, action: "failed", detail: "store is unreadable", newFingerprint: null, newExpiresAt: null, backupPath: null });
      }
      continue;
    }

    const lock = options.apply ? acquireLock(`store:${storeId}`) : ({ release() {} } as const);
    if (lock === null) {
      for (const item of items) {
        results.push({ item, action: "failed", detail: "another quotadeck instance holds the custody lock", newFingerprint: null, newExpiresAt: null, backupPath: null });
      }
      continue;
    }

    try {
      let root: unknown = store.raw;
      const staged: Array<{ item: PlanItem; update: TokenUpdate; detail: string; action: CustodyAction }> = [];

      for (const item of items) {
        const resolved = await resolve(stores, store, item, options.apply);
        if ("error" in resolved) {
          results.push({ item, action: resolved.action, detail: resolved.error, newFingerprint: null, newExpiresAt: null, backupPath: null });
          continue;
        }
        const applied = applyFor(storeId, root, item.provider, resolved.update);
        if (!applied.ok) {
          results.push({ item, action: "failed", detail: applied.error, newFingerprint: null, newExpiresAt: null, backupPath: null });
          continue;
        }
        root = applied.root;
        staged.push({ item, update: resolved.update, detail: resolved.detail, action: resolved.action });
      }

      if (staged.length === 0) continue;

      let backupPath: string | null = null;
      if (options.apply) {
        const previous = readFileSync(store.path, "utf8");
        backupPath = atomicWriteJson(storeId, store.path, previous, root);
      }
      for (const entry of staged) {
        results.push({
          item: entry.item,
          action: options.apply ? entry.action : "planned",
          detail: options.apply ? entry.detail : `would ${entry.item.kind}: ${entry.detail}`,
          newFingerprint: fingerprint(entry.update.accessToken),
          newExpiresAt: entry.update.expiresAt,
          backupPath,
        });
      }
    } finally {
      lock.release();
    }
  }

  return results;
}
