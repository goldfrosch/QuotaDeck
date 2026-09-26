/**
 * Renderer. Deliberately framework-free: this is a 380px status widget that
 * runs all day next to heavy AI workloads, so the whole bundle is a few kB and
 * startup is instant. The core is UI-agnostic, so swapping in a framework
 * later is a shell change, not a rewrite.
 *
 * Three views share one shell. `Quotas` is a fixed comparison surface sized to
 * the viewport and never scrolls; `Activity` and `Health` own their own scroll
 * because their row counts are data-driven. The shell chrome (titlebar, tabs)
 * lives in index.html and is never re-rendered, so a two-second poll cannot
 * knock the user off the tab they are reading.
 */

import type { DeckApi } from "../electron/preload.ts";
import type { DeckState } from "../electron/state.ts";
import type { LocalUsage, QuotaResult, QuotaWindow, StoreSnapshot } from "../core/types.ts";

declare global {
  interface Window {
    readonly deck: DeckApi;
  }
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Bars in the activity histogram that count as "just now". */
const RECENT_SLOTS = 4;

type ProviderId = "claude" | "codex" | "zai";
type Severity = "ok" | "watch" | "high";

interface ProviderSpec {
  readonly id: ProviderId;
  readonly monogram: string;
  readonly name: string;
  /** Credential provider slug, as the host tools name it. */
  readonly slug: string;
  /**
   * Whether the plan tier can be read off the credential label. True only for
   * Claude, whose store records `subscriptionType / rateLimitTier`; the other
   * providers either report a plan in their quota payload or have none.
   */
  readonly planFromCredential: boolean;
  readonly fallbackPlan: string | null;
}

const PROVIDERS: readonly ProviderSpec[] = [
  { id: "claude", monogram: "CL", name: "Claude", slug: "anthropic", planFromCredential: true, fallbackPlan: null },
  { id: "codex", monogram: "CX", name: "Codex", slug: "openai", planFromCredential: false, fallbackPlan: null },
  {
    id: "zai",
    monogram: "ZA",
    name: "Z.ai",
    slug: "zai-coding-plan",
    planFromCredential: false,
    fallbackPlan: "coding plan",
  },
];

/** Maps a `providerID/modelID` prefix onto the band that owns it. */
const ROUTE_CLASS: Readonly<Record<string, ProviderId>> = {
  anthropic: "claude",
  openai: "codex",
  zai: "zai",
  "zai-coding-plan": "zai",
};

/* ----------------------------------------------------------------- utils */

function el(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );
}

/** "in 22m" / "3.5h ago" -- used where direction matters. */
function relative(target: number | null, now = Date.now()): string {
  if (target === null) return "-";
  const delta = target - now;
  const abs = Math.abs(delta);
  const tail = delta >= 0 ? "" : " ago";
  const head = delta >= 0 ? "in " : "";
  if (abs < MINUTE) return `${head}${Math.round(abs / 1000)}s${tail}`;
  if (abs < HOUR) return `${head}${Math.round(abs / MINUTE)}m${tail}`;
  if (abs < DAY) return `${head}${(abs / HOUR).toFixed(1)}h${tail}`;
  return `${head}${(abs / DAY).toFixed(1)}d${tail}`;
}

/** "22m" -- the compact form the rack uses, where the column implies "until". */
function shortRelative(target: number | null, now = Date.now()): string {
  if (target === null) return "-";
  const abs = Math.max(0, target - now);
  if (abs < MINUTE) return `${Math.round(abs / 1000)}s`;
  if (abs < HOUR) return `${Math.round(abs / MINUTE)}m`;
  if (abs < DAY) return `${(abs / HOUR).toFixed(1)}h`;
  return `${(abs / DAY).toFixed(1)}d`;
}

function severity(utilization: number): Severity {
  if (utilization >= 85) return "high";
  if (utilization >= 60) return "watch";
  return "ok";
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return String(value);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function failureText(result: Extract<QuotaResult, { ok: false }>): string {
  switch (result.reason) {
    case "no-credentials":
      return "no credentials on disk";
    case "credentials-expired":
      return "credentials expired -- run Sync credentials";
    case "rate-limited":
      return "rate limited; backing off";
    case "no-plan":
      return "no subscription on this key";
    default:
      return result.detail;
  }
}

/* ------------------------------------------------------------ quota rack */

function planLabel(spec: ProviderSpec, result: QuotaResult | null, state: DeckState): string | null {
  if (result !== null && result.ok) {
    for (const note of result.notes) {
      const match = /^plan\s+(.+)$/i.exec(note);
      if (match?.[1] !== undefined) return match[1];
    }
  }
  if (spec.planFromCredential) {
    for (const store of state.stores) {
      for (const record of store.records) {
        if (record.provider !== spec.slug || record.kind !== "oauth" || record.label === null) continue;
        const head = record.label.split("/")[0]?.trim();
        if (head !== undefined && head.length > 0) return head;
      }
    }
  }
  return spec.fallbackPlan;
}

/** Notes minus the one already consumed as the plan tier. */
function extraNotes(result: QuotaResult | null): readonly string[] {
  if (result === null || !result.ok) return [];
  return result.notes.filter((note) => !/^plan\s+/i.test(note));
}

function renderMetric(window: QuotaWindow | undefined, now: number): string {
  if (window === undefined) {
    return `<div class="metric unknown">
      <div class="metric-top"><span class="metric-label">no window</span><span class="metric-value">--</span></div>
      <div class="meter"><i data-fill="0"></i></div>
      <div class="metric-bottom"><span class="state-word">unknown</span><span class="reset">-</span></div>
    </div>`;
  }
  const percent = clampPercent(window.utilization);
  const cls = severity(window.utilization);
  const reset = shortRelative(window.resetsAt, now);
  return `<div class="metric ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"
      aria-label="${escapeHtml(`${window.label}, ${percent} percent used, ${cls}, resets ${relative(window.resetsAt, now)}`)}">
    <div class="metric-top">
      <span class="metric-label" title="${escapeHtml(window.label)}">${escapeHtml(window.label)}</span>
      <span class="metric-value">${percent}<small>% used</small></span>
    </div>
    <div class="meter"><i data-fill="${percent}"></i></div>
    <div class="metric-bottom"><span class="state-word">${cls}</span><span class="reset">${escapeHtml(reset)}</span></div>
  </div>`;
}

function renderBand(spec: ProviderSpec, result: QuotaResult | null, state: DeckState, now: number): string {
  const plan = planLabel(spec, result, state);
  const identity = `<div class="provider-id">
    <span class="monogram">${spec.monogram}</span>
    <span class="provider-name">${escapeHtml(spec.name)}</span>
    <span class="provider-plan" title="${escapeHtml(plan ?? "")}">${escapeHtml(plan ?? "")}</span>
  </div>`;

  if (result === null) {
    return `<article class="provider ${spec.id}" tabindex="0" aria-label="${escapeHtml(spec.name)} quota, waiting">
      ${identity}
      <div class="provider-status waiting">waiting for first anchor...</div>
    </article>`;
  }

  if (!result.ok) {
    const text = failureText(result);
    return `<article class="provider ${spec.id}" tabindex="0" aria-label="${escapeHtml(`${spec.name} quota unavailable: ${text}`)}">
      ${identity}
      <div class="provider-status bad" title="${escapeHtml(result.detail)}">${escapeHtml(text)}</div>
    </article>`;
  }

  // Sources emit their windows shortest-first, so slots 0 and 1 are the two
  // horizons worth comparing across providers; anything further is a scoped or
  // secondary cap and belongs in the note line rather than the stack.
  const extras = result.windows.slice(2).map((w) => `${w.label} ${clampPercent(w.utilization)}%`);
  const noteParts = [...extras, ...extraNotes(result)];
  const note =
    noteParts.length === 0
      ? `<div class="provider-note"><strong>anchored</strong>&nbsp;${escapeHtml(relative(result.fetchedAt, now))}</div>`
      : `<div class="provider-note" title="${escapeHtml(noteParts.join(" · "))}">${escapeHtml(noteParts.join(" · "))}</div>`;

  return `<article class="provider ${spec.id}" tabindex="0" aria-label="${escapeHtml(spec.name)} quota details">
    ${identity}
    <div class="metric-stack">
      ${renderMetric(result.windows[0], now)}
      ${renderMetric(result.windows[1], now)}
    </div>
    ${note}
  </article>`;
}

function resultFor(state: DeckState, id: ProviderId): QuotaResult | null {
  return id === "claude" ? state.claude : id === "codex" ? state.codex : state.zai;
}

function renderQuotas(state: DeckState): string {
  const now = Date.now();

  let peakName: string | null = null;
  let peakWindow: QuotaWindow | null = null;
  let live = 0;
  for (const spec of PROVIDERS) {
    const result = resultFor(state, spec.id);
    if (result === null || !result.ok) continue;
    live += 1;
    for (const window of result.windows) {
      if (peakWindow === null || window.utilization > peakWindow.utilization) {
        peakWindow = window;
        peakName = spec.name;
      }
    }
  }

  const constraint =
    peakWindow === null || peakName === null
      ? `<strong>waiting for first anchor...</strong>`
      : `<strong>${escapeHtml(peakName)} &middot; <span class="peak ${severity(peakWindow.utilization)}">${clampPercent(
          peakWindow.utilization,
        )}% used</span> &middot; resets ${escapeHtml(relative(peakWindow.resetsAt, now))}</strong>`;

  const bands = PROVIDERS.map((spec) => renderBand(spec, resultFor(state, spec.id), state, now)).join("");
  const dots = PROVIDERS.map((spec) => {
    const result = resultFor(state, spec.id);
    const down = result === null || !result.ok ? " down" : "";
    return `<i class="provider-dot ${spec.id}${down}"></i>`;
  }).join("");

  return `<div class="constraint">
      <div>
        <div class="eyebrow">most constrained</div>
        ${constraint}
      </div>
      <div class="freshness${live === PROVIDERS.length ? "" : " degraded"}">&#9679; ${live}/${PROVIDERS.length} live</div>
    </div>
    ${bands}
    <footer class="rack-footer">
      <span class="provider-dots" aria-hidden="true">${dots}</span>
      <span class="provider-count">${live} providers reporting</span>
      <span class="spacer mono">${escapeHtml(relative(state.anchoredAt, now))}</span>
    </footer>`;
}

/* --------------------------------------------------------------- activity */

interface RouteShare {
  readonly id: ProviderId | null;
  readonly name: string;
  readonly share: number;
}

function routeShares(usage: LocalUsage): readonly RouteShare[] {
  const totals = new Map<string, number>();
  for (const bucket of usage.buckets) {
    const provider = bucket.key.split("/")[0] ?? "?";
    totals.set(provider, (totals.get(provider) ?? 0) + bucket.messages);
  }
  const total = [...totals.values()].reduce((sum, n) => sum + n, 0);
  if (total === 0) return [];
  return [...totals.entries()]
    .map(([provider, messages]): RouteShare => {
      const id = ROUTE_CLASS[provider] ?? null;
      const spec = PROVIDERS.find((p) => p.id === id);
      return { id, name: spec?.name ?? provider, share: (messages / total) * 100 };
    })
    .sort((a, b) => b.share - a.share)
    .slice(0, 3);
}

function renderActivity(state: DeckState): string {
  const usage = state.local;
  if (usage === null) {
    return `<header class="section-head"><h2>opencode activity</h2></header>
      <div class="scroll-body"><p class="empty bad">${escapeHtml(state.localError ?? "no local usage data")}</p></div>`;
  }

  const shown = usage.buckets.slice(0, 4);
  const rows =
    shown.length === 0
      ? `<tr><td colspan="4">no assistant messages in window</td></tr>`
      : shown
          .map(
            (bucket) => `<tr>
              <td title="${escapeHtml(bucket.key)}">${escapeHtml(bucket.key)}</td>
              <td>${compact(bucket.output)}</td>
              <td>${compact(bucket.cacheRead)}</td>
              <td>$${bucket.costUsd.toFixed(2)}</td>
            </tr>`,
          )
          .join("");

  const routes = routeShares(usage)
    .map(
      (route) => `<div class="route-row ${route.id ?? ""}">
        <strong title="${escapeHtml(route.name)}">${escapeHtml(route.name)}</strong>
        <span class="route-meter"><i data-fill="${clampPercent(route.share)}"></i></span>
        <span class="mono">${clampPercent(route.share)}%</span>
      </div>`,
    )
    .join("");

  const cacheRead = usage.buckets.reduce((sum, b) => sum + b.cacheRead, 0);
  const planBilled = usage.buckets.filter((b) => b.costUsd === 0 && b.messages > 0).length;

  const peak = usage.histogram.reduce((max, n) => Math.max(max, n), 0);
  const bars = usage.histogram
    .map((count, index) => {
      const height = peak === 0 ? 0 : Math.round((count / peak) * 100);
      const recent = index >= usage.histogram.length - RECENT_SLOTS ? " recent" : "";
      return `<i class="${recent.trim()}" data-height="${height}"></i>`;
    })
    .join("");

  return `<header class="section-head">
      <h2>opencode &middot; last ${usage.windowHours}h</h2>
      <span class="mono">${usage.totalMessages} msg &middot; $${usage.totalCostUsd.toFixed(2)}</span>
    </header>
    <div class="scroll-body activity-body">
      <table class="table">
        <thead><tr><th scope="col">model</th><th scope="col">out</th><th scope="col">cache</th><th scope="col">cost</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <section class="activity-summary" aria-label="Provider routing summary">
        <h3>assistant routing</h3>
        <div class="route-list">${routes}</div>
        <div class="activity-facts">
          <div class="activity-fact"><span>cache read</span><strong>${compact(cacheRead)}</strong></div>
          <div class="activity-fact"><span>plan billed</span><strong>${planBilled} models</strong></div>
        </div>
        <p class="activity-note">Top ${shown.length} of ${usage.buckets.length} models by output &middot; aggregated in ${usage.elapsedMs} ms.</p>
        <div class="activity-trend">
          <div class="activity-trend-head"><span>${usage.windowHours}h activity shape</span><span class="mono">now</span></div>
          <div class="sparkbars" aria-hidden="true">${bars}</div>
        </div>
      </section>
    </div>`;
}

/* ----------------------------------------------------------------- health */

function storeExpiry(store: StoreSnapshot, now: number): { text: string; cls: string } {
  if (!store.exists) return { text: "missing", cls: "bad" };
  if (store.records.length === 0) return { text: "unreadable", cls: "bad" };
  const oauth = store.records.filter((r) => r.kind === "oauth" && r.expiresAt !== null);
  if (oauth.length === 0) return { text: "persistent", cls: "persistent" };
  const soonest = oauth.reduce((min, r) => ((r.expiresAt ?? 0) < min ? (r.expiresAt ?? 0) : min), Number.MAX_SAFE_INTEGER);
  if (soonest <= now) return { text: "expired", cls: "bad" };
  return { text: shortRelative(soonest, now), cls: "" };
}

function renderHealth(state: DeckState, isBusy: boolean): string {
  const now = Date.now();
  const failedStores = state.stores.filter((s) => s.exists && s.records.length === 0).length;

  const lines =
    state.stores.length === 0
      ? `<li class="health-line"><span class="store">no credential stores found</span></li>`
      : state.stores
          .map((store) => {
            const providers = [...new Set(store.records.map((r) => r.provider))].join(", ");
            const label = providers.length === 0 ? store.storeId : `${store.storeId} · ${providers}`;
            const expiry = storeExpiry(store, now);
            const origin = store.source === "user" ? "from stores.json" : "built-in";
            return `<li class="health-line">
              <span class="pill${store.ownership === "observed" ? " observed" : ""}">${store.ownership}</span>
              <span class="store" title="${escapeHtml(`${label}\n${store.path}\n${store.format} format, ${origin}`)}">${escapeHtml(label)}</span>
              <span class="expiry ${expiry.cls}">${escapeHtml(expiry.text)}</span>
            </li>`;
          })
          .join("");

  const providerCount = new Set(state.stores.flatMap((s) => s.records.map((r) => r.provider))).size;
  const report = state.custody;
  const changed = report?.entries.filter((e) => e.action === "adopted" || e.action === "refreshed").length ?? 0;
  const failed = report?.entries.filter((e) => e.action === "failed").length ?? 0;
  const custodyState = report === null ? "not run" : failed > 0 ? "attention" : changed > 0 ? "updated" : "converged";

  const custody = `<div class="custody-summary${failed > 0 ? " bad" : ""}">
    <div><span>custody state</span><strong>${custodyState}</strong></div>
    <small>${changed} updated &middot; ${failed} failed</small>
  </div>`;

  // Where the store list came from, so a user who edited stores.json can see
  // whether it took -- and why not, without opening a terminal.
  const config = state.storeConfig;
  const configBad = config !== null && (config.state === "invalid" || config.errors.length > 0);
  const configState =
    config === null
      ? "not read"
      : config.state === "absent"
        ? "built-in defaults"
        : config.state === "invalid"
          ? "ignored (invalid)"
          : "applied";
  const configDetail =
    config === null ? "" : config.errors.length > 0 ? `${config.errors.length} problem(s)` : config.state === "absent" ? "no file" : "ok";
  const configTitle = config === null ? "" : [config.path, ...config.errors].join("\n");
  const storeConfig = `<div class="custody-summary${configBad ? " bad" : ""}" title="${escapeHtml(configTitle)}">
    <div><span>stores.json</span><strong>${escapeHtml(configState)}</strong></div>
    <small>${escapeHtml(configDetail)}</small>
  </div>`;

  const disabled = isBusy ? " disabled" : "";
  return `<header class="section-head">
      <h2>credential health</h2>
      <span class="mono">${state.stores.length} stores &middot; ${failedStores} unreadable</span>
    </header>
    <div class="scroll-body health-body">
      <ul class="health-list">${lines}</ul>
      <section class="health-overview" aria-label="Credential custody summary">
        <h3>credential overview</h3>
        <div class="health-overview-grid">
          <div class="health-stat"><span>providers</span><strong>${providerCount} covered</strong></div>
          <div class="health-stat"><span>last custody</span><strong>${escapeHtml(relative(report?.at ?? null, now))}</strong></div>
        </div>
        ${custody}
        ${storeConfig}
      </section>
      <div class="health-actions">
        <button type="button" data-action="sync"${disabled}>${isBusy ? "working..." : "Sync credentials"}</button>
        <button type="button" data-action="check"${disabled}>${isBusy ? "working..." : "Run health check"}</button>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ paint */

/**
 * Proportional sizes are applied through the CSSOM rather than a
 * `style="width:..."` attribute. The page runs under a strict
 * `style-src 'self'` policy, which blocks style attributes parsed from markup
 * -- emitting them would silently leave every bar empty. Programmatic CSSOM
 * writes are not subject to it.
 */
function applySizes(root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLElement>("i[data-fill]")) {
    node.style.width = `${node.dataset["fill"] ?? "0"}%`;
  }
  for (const node of root.querySelectorAll<HTMLElement>("i[data-height]")) {
    node.style.height = `${node.dataset["height"] ?? "0"}%`;
  }
}

let latest: DeckState | null = null;
let busy = false;

function render(state: DeckState): void {
  latest = state;
  const quotas = el("view-quotas");
  const activity = el("view-activity");
  const health = el("view-health");

  quotas.innerHTML = renderQuotas(state);
  activity.innerHTML = renderActivity(state);
  health.innerHTML = renderHealth(state, busy);

  applySizes(quotas);
  applySizes(activity);

  el("anchor").textContent = state.anchoredAt === null ? "no anchor" : `anchor ${relative(state.anchoredAt)}`;
  (el("refresh") as HTMLButtonElement).disabled = busy;
}

/* -------------------------------------------------------------------- pin */

/**
 * The button is the single source of truth for pin state in the renderer:
 * `aria-pressed` drives both the screen-reader announcement and the CSS, so
 * there is no second copy to drift out of sync with the main process.
 */
function paintPin(value: boolean): void {
  const button = el("pin");
  button.setAttribute("aria-pressed", String(value));
  const label = value ? "Unpin -- let other windows cover this" : "Keep on top";
  button.setAttribute("title", label);
  button.setAttribute("aria-label", label);
}

/* ------------------------------------------------------------------- boot */

const TABS: readonly string[] = ["tab-quotas", "tab-activity", "tab-health"];

function selectTab(id: string): void {
  for (const tabId of TABS) {
    const tab = el(tabId) as HTMLButtonElement;
    const selected = tabId === id;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const view = el(tab.getAttribute("aria-controls") ?? "");
    view.hidden = !selected;
    view.classList.toggle("active", selected);
  }
}

async function runAction(action: string): Promise<void> {
  if (busy) return;
  busy = true;
  if (latest !== null) render(latest);
  try {
    const next =
      action === "sync"
        ? await window.deck.sync()
        : action === "check"
          ? await window.deck.check()
          : await window.deck.refresh();
    busy = false;
    render(next);
  } catch {
    busy = false;
    if (latest !== null) render(latest);
  }
}

function boot(): void {
  TABS.forEach((tabId, index) => {
    const tab = el(tabId);
    tab.addEventListener("click", () => selectTab(tabId));
    tab.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
      event.preventDefault();
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? TABS.length - 1
            : (index + (key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
      const target = TABS[next];
      if (target === undefined) return;
      selectTab(target);
      el(target).focus();
    });
  });

  // Health actions are re-created on every poll, so the listener lives on the
  // stable container rather than the buttons themselves.
  el("view-health").addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>("[data-action]");
    const action = button?.dataset["action"];
    if (action !== undefined) void runAction(action);
  });

  el("pin").addEventListener("click", () => {
    const next = el("pin").getAttribute("aria-pressed") !== "true";
    void window.deck.setPinned(next).then(paintPin);
  });
  el("refresh").addEventListener("click", () => void runAction("refresh"));
  el("hide").addEventListener("click", () => window.deck.hide());

  void window.deck.pinned().then(paintPin);
  window.deck.onUpdate(render);
  void window.deck.get().then(render);
}

boot();
