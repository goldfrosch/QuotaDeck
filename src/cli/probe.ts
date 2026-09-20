/**
 * End-to-end harness for the core: reads every credential store, calls both
 * quota APIs, and aggregates local opencode usage.
 *
 * Run: `npm run probe`
 *
 * Note this spends one of the Anthropic usage endpoint's scarce calls, so it
 * is a diagnostic, not something to loop on.
 */

import { loadAllStores, pickCredential, snapshot } from "../core/stores.ts";
import { fetchClaudeQuota } from "../core/sources/claude-quota.ts";
import { fetchCodexQuota } from "../core/sources/codex-quota.ts";
import { OpencodeDbUnavailable, readLocalUsage } from "../core/sources/opencode-db.ts";
import { ownershipFor } from "../core/paths.ts";
import { expiryState, relative, stamp } from "../core/time.ts";
import { asString, child } from "../core/json.ts";
import type { LoadedStore } from "../core/stores.ts";
import type { QuotaResult } from "../core/types.ts";

const WIDTH = 26;

function bar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * WIDTH);
  return `[${"#".repeat(filled)}${".".repeat(WIDTH - filled)}]`;
}

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function printStores(stores: readonly LoadedStore[]): void {
  heading("CREDENTIAL STORES");
  for (const store of stores) {
    const view = snapshot(store);
    if (!view.exists) {
      console.log(`  ${store.storeId.padEnd(28)} (missing) ${view.path}`);
      continue;
    }
    if (view.records.length === 0) {
      console.log(`  ${store.storeId.padEnd(28)} ERROR: ${view.error ?? "unknown"}`);
      continue;
    }
    console.log(`  ${store.storeId}`);
    for (const record of view.records) {
      const state = expiryState(record.expiresAt);
      const flag =
        state === "expired" ? "EXPIRED" : state === "expiring" ? "EXPIRING" : state === "fresh" ? "ok" : "-";
      const label = record.label === null ? "" : ` (${record.label})`;
      const fp = record.accessFingerprint ?? "-";
      const owner = ownershipFor(store.storeId, record.provider) === "owned" ? "OWNED " : "observe";
      console.log(
        `    ${owner} ${record.provider.padEnd(18)} ${record.kind.padEnd(5)} ${flag.padEnd(9)}` +
          ` ${stamp(record.expiresAt).padEnd(12)} ${relative(record.expiresAt).padEnd(14)}` +
          ` a=${fp} r=${record.refreshFingerprint ?? "-"}${label}`,
      );
      if (record.refreshExpiresAt !== null) {
        console.log(
          `      ${"".padEnd(18)} refresh token expires ${stamp(record.refreshExpiresAt)} (${relative(record.refreshExpiresAt)})`,
        );
      }
    }
  }
}

function printQuota(title: string, result: QuotaResult): void {
  heading(title);
  if (!result.ok) {
    const retry = result.retryAfterMs === null ? "" : ` retry in ${Math.round(result.retryAfterMs / 1000)}s`;
    console.log(`  unavailable: ${result.reason} -- ${result.detail}${retry}`);
    return;
  }
  for (const w of result.windows) {
    console.log(
      `  ${w.label.padEnd(20)} ${bar(w.utilization)} ${String(w.utilization).padStart(5)}%` +
        `  resets ${stamp(w.resetsAt).padEnd(12)} ${relative(w.resetsAt)}`,
    );
  }
  for (const note of result.notes) console.log(`  note: ${note}`);
}

function printLocalUsage(windowHours: number): void {
  heading(`OPENCODE LOCAL USAGE (last ${windowHours}h)`);
  try {
    const usage = readLocalUsage(windowHours);
    console.log(
      `  ${usage.totalMessages} assistant messages, $${usage.totalCostUsd.toFixed(4)} total  [${usage.elapsedMs} ms]`,
    );
    for (const b of usage.buckets) {
      console.log(
        `    ${b.key.padEnd(34)} msgs=${String(b.messages).padStart(4)}` +
          ` in=${b.input.toLocaleString().padStart(10)} out=${b.output.toLocaleString().padStart(9)}` +
          ` cacheR=${b.cacheRead.toLocaleString().padStart(12)} $${b.costUsd.toFixed(4)}`,
      );
    }
  } catch (err) {
    if (err instanceof OpencodeDbUnavailable) {
      console.log(`  unavailable: ${err.message}`);
      return;
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const stores = loadAllStores();
  printStores(stores);

  const claudeStore = stores.find((s) => s.storeId === "claude-code");
  const claudeToken = claudeStore ? (pickCredential(claudeStore, "anthropic")?.accessToken ?? null) : null;

  const codexStore = stores.find((s) => s.storeId === "codex");
  const codexCred = codexStore ? pickCredential(codexStore, "openai") : null;
  const codexTokens = codexStore === undefined ? null : child(codexStore.raw, "tokens");
  const codexAccountId = codexTokens === null ? null : asString(codexTokens["account_id"]);

  const [claude, codex] = await Promise.all([
    fetchClaudeQuota(claudeToken),
    fetchCodexQuota(codexCred?.accessToken ?? null, codexAccountId),
  ]);

  printQuota("CLAUDE QUOTA (api.anthropic.com/api/oauth/usage)", claude);
  printQuota("CODEX QUOTA (chatgpt.com/backend-api/wham/usage)", codex);
  printLocalUsage(5);
  console.log();
}

await main();
