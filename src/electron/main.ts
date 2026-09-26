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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadAllStores, pickCredential, snapshot } from "../core/stores.ts";
import { loadCatalog } from "../core/catalog.ts";
import { fetchFromFreshest } from "../core/sources/anchor.ts";
import type { LoadedStore } from "../core/stores.ts";
import { fetchClaudeQuota } from "../core/sources/claude-quota.ts";
import { fetchCodexQuota } from "../core/sources/codex-quota.ts";
import { fetchZaiQuota } from "../core/sources/zai-quota.ts";
import { OpencodeDbUnavailable, readLocalUsage } from "../core/sources/opencode-db.ts";
import { planCustody } from "../core/custody/plan.ts";
import { runCustody } from "../core/custody/run.ts";
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

/**
 * Whether the widget is held above every other window.
 *
 * Pinning is a real trade-off rather than a nicety: always-on-top is what
 * makes a glance-first widget useful, and also what makes it a nuisance the
 * moment you need the space underneath. So it is a user decision, and it
 * persists -- defaulting to on keeps the behaviour the widget shipped with.
 */
let pinned = true;

function publish(patch: Partial<DeckState>): void {
  state = { ...state, ...patch, updatedAt: Date.now() };
  win?.webContents.send("deck:update", state);
  updateTray();
}

/* ----------------------------------------------------------- preferences */

function loadPinned(): boolean {
  try {
    const raw: unknown = JSON.parse(readFileSync(PATHS.uiSettings, "utf8"));
    if (typeof raw === "object" && raw !== null) {
      const value = (raw as Record<string, unknown>)["pinned"];
      if (typeof value === "boolean") return value;
    }
  } catch {
    // First run, or the file was hand-edited into nonsense. Either way the
    // shipped default is the safe answer, so fall through to it.
  }
  return true;
}

function savePinned(value: boolean): void {
  try {
    mkdirSync(dirname(PATHS.uiSettings), { recursive: true });
    writeFileSync(PATHS.uiSettings, `${JSON.stringify({ pinned: value })}\n`, "utf8");
  } catch {
    // A preference that cannot be written must not take the widget down; the
    // toggle still applies to this session.
  }
}

/**
 * "screen-saver" is deliberately the highest practical level: it keeps the
 * widget above full-screen apps, which is the point of something you never
 * want to hunt for. Unpinning drops it to an ordinary window so anything can
 * cover it.
 */
function applyPin(target: BrowserWindow, value: boolean): void {
  if (value) target.setAlwaysOnTop(true, "screen-saver");
  else target.setAlwaysOnTop(false);
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
  const catalog = loadCatalog();
  publish({ stores: loadAllStores(catalog.specs).map(snapshot), storeConfig: catalog.config });
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
  const [claude, codex, zai] = await Promise.all([
    fetchFromFreshest(stores, "anthropic", (c) => fetchClaudeQuota(c?.accessToken ?? null)),
    fetchFromFreshest(stores, "openai", (c) => fetchCodexQuota(c?.accessToken ?? null, c?.accountId ?? null)),
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
    alwaysOnTop: pinned,
    show: false,
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: join(HERE, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  applyPin(created, pinned);
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

  // The pin is a main-process window property, so driving the button and
  // reading the window back is the only way to prove the wiring. Two clicks
  // exercise both directions and leave the saved preference where it started.
  const pinStates: boolean[] = [target.isAlwaysOnTop()];
  for (let click = 0; click < 2; click += 1) {
    await target.webContents.executeJavaScript("document.getElementById('pin').click()");
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    pinStates.push(target.isAlwaysOnTop());
    if (click === 0) {
      await writeFile(join(dir, "smoke-unpinned.png"), (await target.webContents.capturePage()).toPNG());
    }
  }

  await writeFile(
    join(dir, "smoke.txt"),
    `${sections.join("\n\n")}\n\n--- alwaysOnTop: ${pinStates.join(" -> ")} ---` +
      `\n\n--- renderer console (${logs.length}) ---\n${logs.join("\n")}\n`,
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
  ipcMain.handle("deck:pin-get", () => pinned);
  ipcMain.handle("deck:pin-set", (_event, value: unknown) => {
    pinned = value === true;
    if (win !== null) applyPin(win, pinned);
    savePinned(pinned);
    return pinned;
  });
  ipcMain.handle("deck:open-state-dir", async () => {
    await shell.openPath(PATHS.stateDir);
  });
  ipcMain.on("deck:hide", () => win?.hide());
}

app.whenReady().then(async () => {
  pinned = loadPinned();
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
