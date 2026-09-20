# quotadeck Design System

## 1. Atmosphere & Identity

quotadeck is a quiet developer instrument: compact, exact, and readable from the edge of the screen. Its signature is the **quota rack**, a continuous telemetry surface where providers occupy stable horizontal bands instead of separate dashboard cards. The interface preserves the existing dark CLI-adjacent character while using stronger type contrast and a stricter information hierarchy.

## 2. Color

### Palette

| Role | Token | Value | Usage |
|---|---|---:|---|
| Canvas | `--surface-canvas` | `#0B0F14` | Window background |
| Panel | `--surface-panel` | `#121820` | Rack and secondary views |
| Raised | `--surface-raised` | `#18212B` | Controls and selected states |
| Recessed | `--surface-recessed` | `#0A0E13` | Meter tracks |
| Text primary | `--text-primary` | `#E9EEF4` | Values and provider names |
| Text secondary | `--text-secondary` | `#B5C0CC` | Reset times and supporting text |
| Text muted | `--text-muted` | `#8996A5` | Metadata and dormant controls |
| Rule | `--line` | `#2A3542` | Structural separators |
| Focus | `--focus` | `#9DDCFF` | Keyboard focus ring |
| Brand | `--brand` | `#38BDF8` | quotadeck wordmark and active navigation |
| Claude channel | `--provider-claude` | `#E6A57A` | Claude keyline and monogram only |
| Codex channel | `--provider-codex` | `#78C7E8` | Codex keyline and monogram only |
| Z.ai channel | `--provider-zai` | `#B8A6FF` | Z.ai keyline and monogram only |
| Healthy | `--status-ok` | `#73C991` | Usage below 60% |
| Warning | `--status-watch` | `#F0B65A` | Usage from 60% through 84% |
| Critical | `--status-high` | `#FF7272` | Usage at or above 85% |
| Ownership/owned | `--ownership-owned` | `#7CC7C1` | Credentials managed by quotadeck |
| Ownership/observed | `--ownership-observed` | `#D6B36A` | Read-only credentials |
| Concept | `--concept` | `#9FC7DD` | Prototype-only disclosure |
| Trend recent | `--trend-recent` | `#687D91` | Recent local activity buckets |

### Rules

- Provider colors identify source only; they never encode health.
- Status always combines color with visible text and a shape.
- The brand cyan is reserved for navigation, focus, and the wordmark.
- No gradients, decorative glows, or pure black surfaces.

## 3. Typography

### Scale

| Level | Size | Weight | Line height | Tracking | Usage |
|---|---:|---:|---:|---:|---|
| Metric | 15px | 650 | 18px | -0.04em | Utilization values |
| Provider | 13px | 650 | 18px | -0.01em | Provider names |
| Body | 12px | 500 | 16px | 0 | Actions and supporting content |
| Label | 10px | 600 | 14px | 0.04em | Window, state, and reset labels |
| Micro | 9px | 650 | 13px | 0.08em | Technical overlines and duplicated metadata |

### Font Stack

- UI: `"Segoe UI Variable", "Segoe UI", system-ui, sans-serif`
- Data: `"Cascadia Mono", Consolas, ui-monospace, monospace`
- Numeric values use tabular figures.

### Rules

- Decision-driving values and provider names never drop below 12px; 9–10px text is limited to adjacent labels or duplicated metadata.
- Provider names use sentence case; machine slugs use the data face.
- Percentages are always explicitly labelled `used` to prevent direction ambiguity.

## 4. Spacing & Layout

### Base Unit

All spacing uses a 4px base.

| Token | Value | Usage |
|---|---:|---|
| `--space-1` | 4px | Tight inline relationships |
| `--space-2` | 8px | Compact component padding |
| `--space-3` | 12px | Shell gutters |
| `--space-4` | 16px | Section spacing |

### Viewport Contract

- Production window: 380px wide and up to 660px tall.
- Review capture: 380 × 632px, matching the current rendered content viewport.
- The shell owns the viewport and never scrolls.
- `Quotas` is a fixed comparison surface with no scroll owner.
- Only `Activity`, `Health`, and future provider detail bodies may own vertical scroll.
- Provider order is stable: Claude, Codex, Z.ai.

## 5. Components

### App Shell

- **Structure**: fixed header, view tabs, one bounded view body.
- **States**: default and concept-preview marker.
- **Accessibility**: semantic header/main/nav regions; visible focus.
- **Layout**: `scroll-body-shell`; the default Quotas body does not scroll.

### View Tabs

- **Structure**: three buttons in one tablist: Quotas, Activity, Health.
- **States**: default, hover, active, focus.
- **Accessibility**: arrow-key navigation; `aria-selected` and `aria-controls`.
- **Motion**: color and opacity only, 120ms.

### Provider Band

- **Structure**: provider identity, freshness, two aligned quota metrics, one fixed status line.
- **Variants**: Claude, Codex, Z.ai; live, stale, auth, retry, offline, error.
- **States**: default, hover, focus, unavailable.
- **Accessibility**: the complete row is one keyboard target; provider monogram is decorative.
- **Layout**: fixed-height row; no hover expansion and no data-driven reordering.

### Quota Metric

- **Structure**: window label, percentage used, calibrated meter, status, reset time.
- **Variants**: healthy, warning, critical, unknown.
- **Accessibility**: `role="progressbar"`, numeric ARIA values, visible status text.
- **Layout**: paired two-column metric grid. Additional windows move to provider details.

### Technical Table

- **Structure**: title/totals followed by aligned model rows.
- **States**: populated, empty, loading, error.
- **Accessibility**: real table semantics and text alternatives for truncated model names.
- **Layout**: Activity view scroll owner only when real data exceeds the viewport.

### Credential Line

- **Structure**: ownership label, store name, provider, health/expiry.
- **States**: owned, observed, missing, unreadable, expired.
- **Accessibility**: status is visible text, never color alone.
- **Layout**: Health view only; failures may promote a badge to the global tab.

## 6. Motion & Interaction

| Type | Duration | Easing | Usage |
|---|---:|---|---|
| Micro | 120ms | ease-out | Hover, focus, tab selection |
| View switch | 160ms | ease-out | Opacity transition between views |

- Only `opacity`, `transform`, and color transition.
- No hover expansion, provider reordering, or decorative animation.
- `prefers-reduced-motion` disables non-essential transitions.
- `Escape` returns from future detail views; a second Escape may hide the production widget.

## 7. Depth & Surface

The strategy is **borders plus tonal shift**. The quota rack is one continuous panel, not a stack of floating cards. Elevation comes from luminance steps and thin separators; there are no drop shadows. Provider identity appears as a 2px inset keyline and a compact monogram.

## 8. Accessibility Constraints & Accepted Debt

### Constraints

- WCAG 2.2 AA target: 4.5:1 text contrast and 3:1 non-text contrast.
- All interactive controls are keyboard reachable with a 2px focus ring.
- Status meaning combines words, shapes, and color.
- Live polling must not steal focus, reorder providers, or announce routine updates.
- Long model names truncate visually but preserve their full accessible label.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|---|---|---|---|
| The Z.ai quota endpoint is absent from the public API reference | `src/core/sources/zai-quota.ts` | Z.ai's own usage-query plugin calls this exact path, and the URL is overridable from `.env`, so provider drift is a config change rather than a rebuild | Revisit if Z.ai publishes a documented endpoint |
| The ownership pill is per store, while ownership is really per store and provider | `src/renderer/main.ts` health list | A store mixing observed and owned providers displays as owned; the custody engine still treats each provider separately, so behaviour is correct and only the badge is coarse | Split the badge if a mixed store ever needs per-provider display |
| `design-prototypes/` keeps the approved static mockup alongside the live renderer | `design-prototypes/` | It is the visual contract the implementation was approved against | Delete once the shipped UI is the reference |
