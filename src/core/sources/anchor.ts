/**
 * Picks which on-disk token anchors a provider's quota band.
 *
 * The same account usually has tokens in several stores, and they go stale
 * independently: logging in with one tool can revoke another tool's token
 * while its `exp` still looks healthy. So instead of trusting one hardcoded
 * store, try the freshest live token first and fall through on a 401/403.
 * Any other failure (429, network) stops the walk -- another token would hit
 * the same wall and burn a scarce call doing it.
 */

import { liveCredentials } from "../stores.ts";
import type { LoadedCredential, LoadedStore } from "../stores.ts";
import type { QuotaFailure, QuotaResult } from "../types.ts";

export async function fetchFromFreshest(
  stores: readonly LoadedStore[],
  provider: string,
  fetcher: (credential: LoadedCredential | null) => Promise<QuotaResult>,
): Promise<QuotaResult> {
  const candidates = liveCredentials(stores, provider);
  if (candidates.length === 0) return fetcher(null);

  const rejected: string[] = [];
  let last: QuotaFailure | null = null;
  for (const { store, credential } of candidates) {
    const result = await fetcher(credential);
    if (result.ok) return { ...result, notes: [...result.notes, `via ${store.storeId}`] };
    last = result;
    if (result.reason !== "credentials-expired") {
      return { ...result, detail: `${result.detail} (via ${store.storeId})` };
    }
    rejected.push(store.storeId);
  }
  // Every candidate was rejected; name them so the user knows which to re-login.
  return last === null ? fetcher(null) : { ...last, detail: `${last.detail} (rejected: ${rejected.join(", ")})` };
}
