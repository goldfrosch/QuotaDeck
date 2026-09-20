/**
 * quotadeck main process: tray-resident always-on-top widget.
 *
 * Polling follows the anchor + dead-reckoning design. The quota endpoints are
 * aggressively rate limited (the Anthropic one allows only a handful of calls
 * before 429, usually with no retry-after), so they are *anchors* refreshed on
 * a multi-minute cadence. The local opencode database costs nothing to read
 * and carries the fast path, so the widget still moves every couple of seconds
 * between anchors.
 */

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, screen, shell } from "electron";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadAllStores, pickCredential, snapshot } from "../core/stores.ts";
import type { LoadedStore } from "../core/stores.ts";
import { fetchClaudeQuota } from "../core/sources/claude-quota.ts";
import { fetchCodexQuota } from "../core/sources/codex-quota.ts";
import { fetchZaiQuota } from "../core/sources/zai-quota.ts";
import { OpencodeDbUnavailable, readLocalUsage } from "../core/sources/opencode-db.ts";
import { planCustody } from "../core/custody/plan.ts";
import { runCustody } from "../core/custody/run.ts";
import { asString, child } from "../core/json.ts";
import { CONFIG } from "../core/config.ts";
import { PATHS } from "../core/paths.ts";
import { gaugeIconPng, severityColour } from "./icon.ts";
import { emptyState, worstUtilization } from "./state.ts";
import type { CustodyEntry, DeckState } from "./state.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const { poll: POLL, windowHours: WINDOW_HOURS, custodyEnabled: CUSTODY_ENABLED } = CONFIG;

let state: DeckState = emptyState();
let win: BrowserWindow | null = null;
let tray: Tray | null = null;

function publish(patch: Partial<DeckState>): void {
  state = { ...state, ...patch, updatedAt: Date.now() };
  win?.webContents.send("deck:update", state);
  updateTray();
}

/* ------------------------------------------------------------------ tray */

function updateTray(): void {
  if (tray === null) return;
  const worst = worstUtilization(state);
  const png = gaugeIconPng(16, severityColour(worst), worst / 100);
  tray.setImage(nativeImage.createFromBuffer(png));
  const claude = state.claude?.ok === true ? state.claude.windows[0] : undefined;
  tray.setToolTip(
    claude === undefined
      ? "quotadeck -- no quota data yet"
      : `quotadeck -- Claude ${claude.label} ${claude.utilization}%`,
  );
}

/* --------------------------------------------------------------- pollers */

function pollLocal(): void {
  try {
    publish({ local: readLocalUsage(WINDOW_HOURS), localError: null });
  } catch (err) {
    if (err instanceof OpencodeDbUnavailable) {
      publish({ local: null, localError: err.message });
      return;
    }
    publish({ local: null, localError: err instanceof Error ? err.message : String(err) });
  }
}

function pollStores(): void {
  publish({ stores: loadAllStores().map(snapshot) });
}

/**
 * Only the coding-plan key can read Z.ai's monitor endpoint; a plain
 * pay-as-you-go `zai` key authenticates but reports no plan. Prefer the
 * former, fall back to the latter so a single-key setup still says something
 * truthful rather than nothing.
 */
function zaiKey(stores: readonly LoadedStore[]): string | null {
  for (const slug of ["zai-coding-plan", "zai"]) {
    for (const store of stores) {
      const token = pickCredential(store, slug)?.accessToken;
      if (token !== null && token !== undefined && token.length > 0) return token;
    }
  }
  return null;
}

async function pollQuota(): Promise<void> {
  const stores = loadAllStores();
  const claudeStore = stores.find((s) => s.storeId === "claude-code");
  const codexStore = stores.find((s) => s.storeId === "codex");
  const codexTokens = codexStore === undefined ? null : child(codexStore.raw, "tokens");

  const [claude, codex, zai] = await Promise.all([
    fetchClaudeQuota(claudeStore ? (pickCredential(claudeStore, "anthropic")?.accessToken ?? null) : null),
    fetchCodexQuota(
      codexStore ? (pickCredential(codexStore, "openai")?.accessToken ?? null) : null,
      codexTokens === null ? null : asString(codexTokens["account_id"]),
    ),
    fetchZaiQuota(zaiKey(stores)),
  ]);
  publish({ claude, codex, zai, anchoredAt: Date.now() });
}

async function runCustodyTick(apply: boolean): Promise<void> {
  const stores = loadAllStores();
  const plan = planCustody(stores);
  const results = await runCustody(stores, plan, { apply });
  const entries: CustodyEntry[] = results.map((r) => ({
    storeId: r.item.storeId,
    provider: r.item.provider,
    action: r.action,
    detail: r.detail,
  }));
  publish({ custody: { at: Date.now(), applied: apply, entries } });
  pollStores();
}

/* ---------------------------------------------------------------- window */

function createWindow(): BrowserWindow {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 380;
  // Tall enough that the custody panel is visible without scrolling, but
  // clamped so the widget still fits a laptop work area.
  const height = Math.min(660, workArea.height - 32);
  const created = new BrowserWindow({
    width,
    height,
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 16,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: join(HERE, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // "screen-saver" keeps it above full-screen apps, which is the point of a
  // glanceable widget you never want to hunt for.
  created.setAlwaysOnTop(true, "screen-saver");
  void created.loadFile(join(HERE, "index.html"));
  created.once("ready-to-show", () => created.show());
  created.on("closed", () => {
    win = null;
  });
  return created;
}

/**
 * Headless self-check: render every view, screenshot each one, dump the
 * visible text and any renderer console output, then exit. This is how the
 * widget gets verified without a browser-automation harness -- Electron can
 * already drive and photograph itself.
 *
 * Each tab is clicked through its real handler rather than by toggling
 * classes, so the capture exercises the same code path a user does.
 *
 *   QUOTADECK_SMOKE=<dir> electron dist/main.mjs
 */
const SMOKE_TABS: readonly string[] = ["tab-quotas", "tab-activity", "tab-health"];

async function runSmoke(target: BrowserWindow, dir: string): Promise<void> {
  const logs: string[] = [];
  target.webContents.on("console-message", (details) => {
    logs.push(`[${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });
  target.webContents.on("render-process-gone", (_event, details) => {
    logs.push(`RENDERER GONE: ${details.reason}`);
  });
  target.webContents.on("did-fail-load", (_event, code, description) => {
    logs.push(`DID-FAIL-LOAD ${code}: ${description}`);
  });

  await new Promise<void>((resolve) => setTimeout(resolve, 4_000));

  const sections: string[] = [];
  for (const tab of SMOKE_TABS) {
    await target.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(tab)}).click()`);
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const text: string = await target.webContents.executeJavaScript("document.body.innerText");
    const image = await target.webContents.capturePage();
    const name = tab.replace("tab-", "");
    await writeFile(join(dir, `smoke-${name}.png`), image.toPNG());
    sections.push(`=== ${name} ===\n${text}`);
  }

  await writeFile(
    join(dir, "smoke.txt"),
    `${sections.join("\n\n")}\n\n--- renderer console (${logs.length}) ---\n${logs.join("\n")}\n`,
    "utf8",
  );
  app.exit(0);
}

function toggleWindow(): void {
  if (win === null) {
    win = createWindow();
    return;
  }
  if (win.isVisible()) win.hide();
  else win.show();
}

/* ------------------------------------------------------------------ boot */

function wireIpc(): void {
  ipcMain.handle("deck:get", () => state);
  ipcMain.handle("deck:refresh", async () => {
    pollLocal();
    pollStores();
    await pollQuota();
    return state;
  });
  ipcMain.handle("deck:sync", async () => {
    await runCustodyTick(true);
    return state;
  });
  // Dry run: re-read every store and report what custody *would* do, without
  // writing a single credential.
  ipcMain.handle("deck:check", async () => {
    await runCustodyTick(false);
    return state;
  });
  ipcMain.handle("deck:open-state-dir", async () => {
    await shell.openPath(PATHS.stateDir);
  });
  ipcMain.on("deck:hide", () => win?.hide());
}

app.whenReady().then(async () => {
  wireIpc();

  tray = new Tray(nativeImage.createFromBuffer(gaugeIconPng(16, severityColour(0), 0)));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show / hide", click: toggleWindow },
      { label: "Sync credentials now", click: () => void runCustodyTick(true) },
      { label: "Refresh quota", click: () => void pollQuota() },
      { type: "separator" },
      { label: "Quit", click: () => app.exit(0) },
    ]),
  );
  tray.on("click", toggleWindow);

  win = createWindow();

  pollLocal();
  pollStores();
  setInterval(pollLocal, POLL.localMs);
  setInterval(pollStores, POLL.storesMs);
  setInterval(() => void pollQuota(), POLL.quotaMs);
  if (CUSTODY_ENABLED) {
    setInterval(() => void runCustodyTick(true), POLL.custodyMs);
    await runCustodyTick(true);
  }
  await pollQuota();

  const smokeDir = process.env["QUOTADECK_SMOKE"];
  if (smokeDir !== undefined && smokeDir.length > 0 && win !== null) {
    await runSmoke(win, smokeDir);
  }
});

// Tray-resident: closing the window must not end the process.
app.on("window-all-closed", () => {});
