/**
 * Credential custody CLI.
 *
 *   npm run custody            # dry run -- prints the plan, writes nothing
 *   npm run custody -- --apply # execute
 *
 * Observed stores (Claude Code and opencode's auth.json, both already owned by
 * the opencode-claude-auth plugin) are never write targets. Only the orphans
 * are touched.
 */

import { loadAllStores } from "../core/stores.ts";
import { planCustody } from "../core/custody/plan.ts";
import { runCustody } from "../core/custody/run.ts";
import { loadCatalog } from "../core/catalog.ts";
import { expiryState, relative, stamp } from "../core/time.ts";

function heading(text: string): void {
  console.log(`\n${text}\n${"-".repeat(text.length)}`);
}

function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const catalog = loadCatalog();
  const stores = loadAllStores(catalog.specs);

  heading("OWNERSHIP (per store / provider)");
  console.log(`  stores.json: ${catalog.config.state} ${catalog.config.path}`);
  for (const error of catalog.config.errors) console.log(`    ! ${error}`);
  for (const store of stores) {
    const oauth = store.credentials.filter((c) => c.record.kind === "oauth");
    const summary =
      oauth.length === 0
        ? "(no oauth credentials)"
        : oauth
            .map((c) => `${c.record.provider}=${c.record.ownership === "owned" ? "OWNED" : "observed"}`)
            .join(" ");
    const donor = store.spec.donor ? "" : " (never a donor)";
    console.log(`  ${store.storeId.padEnd(28)} ${summary}${donor}`);
    console.log(`  ${"".padEnd(28)} ${store.path}`);
  }
  console.log("\n  observed = another process rotates it; quotadeck never writes that credential.");

  const plan = planCustody(stores);
  heading(apply ? "PLAN (APPLYING)" : "PLAN (dry run -- pass --apply to execute)");
  if (plan.length === 0) {
    console.log("  nothing to do: no owned OAuth credentials found");
    return Promise.resolve();
  }
  for (const item of plan) {
    const state = expiryState(item.currentExpiresAt);
    console.log(
      `  ${item.kind.toUpperCase().padEnd(8)} ${item.storeId.padEnd(18)} ${item.provider.padEnd(10)}` +
        ` cur=${(item.currentFingerprint ?? "-").padEnd(13)} ${state.padEnd(8)} ${relative(item.currentExpiresAt)}`,
    );
    console.log(`           -> ${item.reason}`);
    if (item.targetFingerprint !== null) {
      console.log(`           -> target ${item.targetFingerprint} expiring ${stamp(item.targetExpiresAt)}`);
    }
  }

  return runCustody(stores, plan, { apply }).then((results) => {
    heading("RESULT");
    let backup: string | null = null;
    for (const r of results) {
      console.log(`  ${r.action.padEnd(24)} ${r.item.storeId.padEnd(18)} ${r.item.provider.padEnd(10)} ${r.detail}`);
      if (r.newFingerprint !== null) {
        console.log(`           -> now ${r.newFingerprint}, expires ${stamp(r.newExpiresAt)} (${relative(r.newExpiresAt)})`);
      }
      if (r.backupPath !== null) backup = r.backupPath;
    }
    if (backup !== null) console.log(`\n  backups written next to: ${backup}`);
    if (!apply) console.log("\n  (dry run -- nothing was written)");
    console.log();
  });
}

await main();
