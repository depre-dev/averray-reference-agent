# Hermes Handoff Monitor — Redesign Implementation Spec

- **Version:** 1.0
- **Status:** ready for implementation
- **Repo:** [`depre-dev/averray-reference-agent`](https://github.com/depre-dev/averray-reference-agent)
- **Production URL:** `monitor.averray.com`
- **Source of truth for visuals:** the Claude Design handoff bundle (`hermes v2-handoff.zip`) — direction A, 8 artboards. The bundle's `averray-tokens.css` defines the warm beige + sage palette; the bespoke `hermes.css` (~2000 lines) provides every `--hm-*` overlay token and every `.hm-*` class the React components consume.
- **Source of truth for product contract:** the existing `slack-operator` monitor surface (the HTML monitor currently served at `monitor.averray.com`) — board lanes, lifecycle, ownership, browser missions. Unchanged.

> **Why this spec exists:** an earlier draft was authored against the wrong codebase (the operator app `averray-agent/agent`), and four implementation milestones (M1–M4) landed there before the architecture mistake was caught. Those PRs have been reverted. This spec is the corrected version: the Hermes monitor is a **separate deployment** from the operator app — its own backend (`slack-operator`), its own auth (Cloudflare Access at the tunnel edge), its own Docker stack, its own URL. The redesign builds inside `monitor-memory-aware-narration/` (this repo).

---

## 1. Goal

Replace the existing terminal-aesthetic Hermes monitor with the Direction A redesign. Product contract is unchanged — the board, the lanes, the cards, the Hermes orchestration, the browser missions, all of it. What changes is the surface and the implementation:

- HTML rendered server-side from `slack-operator/src/monitor.ts` → React SPA built with Vite and served as static assets from the same backend.
- Inline `<style>` blocks → bundled `hermes.css` referenced via `--hm-*` design tokens.
- Polling-only updates → SSE-driven live updates with exponential-backoff reconnect.

**Primary success metric:** the operator can answer *"is anything blocked on me right now?"* in one second from a fresh glance at the page. Validate by sitting with the operator for one shift after launch and counting how often they read instead of glance.

---

## 2. Bundle Contents (authoritative)

The design handoff bundle (`hermes v2-handoff.zip`) lives outside the repo; engineering should keep a local copy. Inventory:

| File | Role |
|---|---|
| `averray-tokens.css` | Reconciled design tokens. The light/warm-beige palette is the starting point. |
| `hermes.css` | Monitor-specific token overlay (`--hm-*`) + all bespoke styles. Includes the A8 a11y-bumped values (`--hm-muted: #5e635a`, distinct Hermes sage `#0f6b5a`). |
| `components.jsx` | React 18 implementation reference for every component (TopStrip, BoardNowBanner, Lane, Card, DetailDrawer, CoPilotRail, AskHermesComposer, KeyboardHints, etc.). |
| `artboards.jsx` | All board scenes. Keyboard wiring embedded. |
| `data.jsx` | Fixture cards demonstrating the data model. |
| `states.jsx` | A7 states sheet — every card type × every state, plus degraded-mode header pattern. |
| `index.html` | Prototype entry point (UMD React + Babel-standalone). Do NOT ship this pattern — port to a compiled Vite build. |

**Rule:** when this spec and the bundle disagree on a visual decision, the bundle wins.

---

## 3. Scope

In scope for v1:
- The board page (all five board states: default, action-needed, drawer-open, Hermes-focused, empty/calm)
- Browser mission detail drawer
- Card vocabulary: PR, deploy, browser mission, Codex task, draft, done — five state variants each
- Full keyboard navigation
- The persistent Hermes co-pilot rail
- Live data integration via SSE
- Degraded-mode UI per the A7 states sheet
- Three-tier notifications: in-app audio/visual + browser tab badge + desktop notification

Held for v1.1+:
- Mobile glance view
- Card relationships (PR-waits-on-PR arrows)
- Per-agent activity sparklines
- Bulk-select cards in a lane
- Time-travel board snapshots UI (log the data, don't surface it)
- Dark mode (build palette with semantic tokens so the slot-in is cheap later)

---

## 4. Tech Stack & Architecture

- **Framework:** Vite 5 + React 18 + TypeScript strict.
- **Styling:** ship the bundle's `hermes.css` verbatim; Vite handles the CSS import. **No hex values in components** — every color goes through `--hm-*` or `--avy-*` tokens defined in the bundled CSS.
- **Live data:** SSE for push (`EventSource`), SWR for query cache + revalidation.
- **State:** React hooks + URL search params (`window.history.pushState` / a small router) for shareable view state (`?card`, `?lane`, `?search`).
- **Auth:** **Cloudflare Access at the tunnel edge.** The frontend trusts that any request reaching it has already been authenticated. No SIWE, no client-side hydration race, no `AuthedGuard`. Optional `SLACK_OPERATOR_MONITOR_TOKEN` bearer for defense-in-depth.
- **Backend:** existing `services/slack-operator` adds two new endpoints under `/monitor/v2/*` returning the spec's typed data model. Existing `/monitor/events` + `/monitor/stream` stay for the legacy HTML monitor until cutover.
- **Build:** Vite outputs a static bundle (`packages/monitor-ui/dist/`) which `slack-operator` serves via the same HTTP server that serves the legacy monitor.
- **Deploy:** Docker Compose at the existing monitor compose stack (`ops/compose.yml` + `ops/compose.prod.yml`). The new frontend is part of the `slack-operator` service image — no new container.

### Where it lives in this repo

```
monitor-memory-aware-narration/
  packages/
    monitor-ui/            ← NEW: Vite + React + TypeScript SPA (M2'+)
      package.json
      vite.config.ts
      tsconfig.json
      vitest.config.ts
      src/
        main.tsx
        styles/
          monitor.css      ← imported bundle CSS
        lib/monitor/
          card-types.ts
          lane-rules.ts + .test.ts
          urgency.ts + .test.ts
          board-state.ts + .test.ts
          keyboard-map.ts + .test.ts
          card-router.ts + .test.ts
          board-cache.ts + .test.ts
          drawer-routing.ts + .test.ts
          snapshot-store.ts + .test.ts
          live-stream.ts + .test.ts
          fixtures.ts
        components/
          TopStrip.tsx
          BoardNowBanner.tsx
          LanesBar.tsx
          Board.tsx
          Lane.tsx
          MiniRail.tsx
          cards/
            CardShell.tsx
            Card.tsx
            ChecksBar.tsx
            DegradedCard.tsx
            CardRouter.tsx
          drawer/
            DetailDrawer.tsx
            (per-type body splits during M6')
          hermes/
            CoPilotRail.tsx
            HermesTurn.tsx
            AskHermesComposer.tsx
          shortcuts/
            KeyboardOverlay.tsx
            useKeyboardNav.ts
        hooks/
          useMonitorBoard.ts
      dist/                 ← Vite build output (gitignored)

  services/
    slack-operator/
      src/
        index.ts            ← MODIFIED (M1'): add /monitor/v2/board + /v2/stream route handlers
        monitor.ts          ← unchanged (legacy HTML monitor)
        monitor-v2.ts       ← NEW (M1'): the typed board snapshot builder
        monitor-v2.test.ts  ← NEW (M1'): Vitest unit tests
```

The bundle's `index.html` UMD+Babel-standalone pattern is for the design prototype only — **do not ship it.** The Vite build compiles JSX/TSX ahead of time.

---

## 5. Data Model

Engineering should treat this as authoritative for the v2 endpoints. The existing `HermesBoardCardSnapshot` (in `services/slack-operator/src/monitor-hermes-voice.ts`) is slimmer and stays for the legacy HTML monitor.

```ts
type CardId = string;  // "agent #548" | "mission browser-onboard-04" | "task starter-coding-014" | "ext #246"

type Lane =
  | "needs-attention"
  | "drafts"
  | "codex-needed"
  | "hermes-checking"
  | "operator-review"
  | "release-queue"
  | "deploying"
  | "done";

type CardType = "pr" | "mission" | "task" | "deploy" | "draft" | "done";

type AgentType = "claude" | "codex" | "hermes" | "ext";

type CardState =
  | "fresh"
  | "stale"
  | "failed-fetch"
  | "source-offline"
  | "running";

type RiskTag =
  | "workflow" | "config" | "review-gated"
  | "contracts" | "secrets" | "indexer" | "xcm"
  | "docs" | "testbed" | "ui-only" | "deps" | "quality";

type WaitingOn = {
  actor: "operator" | "author" | "agent" | "CI" | "relay" | "branch-protection";
  tone: "warn" | "info" | "neutral";
};

type CardChecks = {
  pass: number;
  running: number;
  fail: number;
  pending: number;
  total: number;
};

type CardBase = {
  id: CardId;
  lane: Lane;
  type: CardType;
  agentType: AgentType;
  title: string;
  summary: string;
  repo: string;
  branch?: string;
  freshness: number;       // minutes since entering current lane
  state: CardState;
  risk: RiskTag[];
  checks?: CardChecks;
  waitingOn: WaitingOn;
  isAction?: boolean;
  isDraft?: boolean;
  archiveHint?: boolean;
};

type PRCard = CardBase & {
  type: "pr";
  files: { path: string; diff: string; critical: boolean }[];
  verdict?: string;
  action?: { kind: "operator-review"; primary: string; secondary: string };
};

type MissionCard = CardBase & {
  type: "mission";
  mission: MissionReport;  // verdict, confidence, path, blockers, evidence, mutation boundary, recommendations
};

type CodexTaskCard = CardBase & {
  type: "task";
  prompt: string;
  action?: { kind: "codex-approve"; primary: string; secondary: string };
  runnerHeartbeat?: { lastSeen: string; online: boolean };
};

type DeployCard = CardBase & {
  type: "deploy";
  deployId: string;
  verification: { current: number; total: number; label: string };
};

type DraftCard = CardBase & { type: "draft"; isDraft: true };

type DoneCard = CardBase & {
  type: "done";
  closedAt: string;
  mergeStatus: "MERGED" | "CLOSED";
  verdictText?: string;
};

type BoardCard =
  | PRCard
  | MissionCard
  | CodexTaskCard
  | DeployCard
  | DraftCard
  | DoneCard;
```

Lane derivation lives in a pure function in `lib/monitor/lane-rules.ts` and is unit-tested under Vitest. Same priority rules as before: `isAction` → `needs-attention`, `isDraft` → `drafts`, type-based routing for task/deploy/done, otherwise the stored lane.

---

## 6. Backend — v2 endpoints (M1')

Two new routes added to `services/slack-operator/src/index.ts`, returning the typed `BoardCard` shape above.

### `GET /monitor/v2/board`

Returns the full board snapshot:

```ts
{
  cards: BoardCard[];
  at: string;          // ISO timestamp
  repo: string;        // current AVERRAY_REPO env var (single-repo per §21.6)
}
```

Authorisation: same as `/monitor/events` — `isMonitorAuthorized()` check; Cloudflare Access has already filtered the request.

Implementation: a new `monitor-v2.ts` module reads the same internal `monitorSnapshot` source that `monitor.ts` reads, applies a mapping function `toBoardCard(item)` that:
- derives `type` from the existing item shape (PR vs mission vs task vs deploy heuristics)
- derives `freshness` (minutes) from the existing `ageLabel` or backing timestamp
- derives `state` (always `"fresh"` for v1; `stale` once items exceed a threshold; `failed-fetch` / `source-offline` populated when the backend itself detected an upstream issue)
- maps `tags[]` → `risk[]`
- maps `owner` / `next` → `waitingOn` + per-type `action`
- preserves `verdict`, `why`, etc. as `summary` or `verdict`

This mapping is the load-bearing M1' work. The function is the test boundary — Vitest cases assert every internal-item shape maps to a valid `BoardCard`.

### `GET /monitor/v2/stream`

SSE stream that emits:

```
board.snapshot       { cards, at }              // on subscribe
board.card.added     { card, at }
board.card.updated   { id, partial, at }
board.card.moved     { id, fromLane, toLane, at }
board.card.archived  { id, reason, at }
stream.keepalive     { at }                     // every 25s
```

Reconnect strategy: client-side exponential backoff (1s, 2s, 4s, 8s, max 30s).

Implementation: the slack-operator already exposes an SSE pattern for `/monitor/stream`. M1' wraps the same internal pub-sub with the new event-type vocabulary. Existing stream stays for the legacy HTML monitor.

### `POST /monitor/v2/debug/spawn` (admin-only, dev-only)

Acceptance vehicle for "spawn a card via API, see it appear within 500ms." Adds a fixture card to the in-memory store and emits `board.card.added`. Gated behind `MONITOR_V2_DEBUG_SPAWN=1`. Replaced by real GitHub/Codex/Hermes ingestion as the corresponding milestones land.

---

## 7. Data Flow & Integration

```
External sources
  ├─ GitHub                  (webhooks + REST)
  ├─ Codex runner            (REST + heartbeat)
  ├─ Browser-agent runtime   (REST + SSE for mission progress)
  ├─ Deploy workflow         (GitHub Actions)
  └─ Hermes service          (REST + SSE narration)
                  │
                  ▼
slack-operator (this repo, services/slack-operator)
  ├─ existing internal monitor state
  ├─ GET  /monitor/v2/board    → typed BoardCard[]
  ├─ GET  /monitor/v2/stream   → SSE per §6
  └─ POST /monitor/v2/debug/spawn  (dev-only)
                  │
                  ▼
monitor-ui (this repo, packages/monitor-ui)
  ├─ SWR for query, EventSource for push
  ├─ Optimistic cache patches on SSE events
  └─ localStorage snapshot writer (per §21.4)
```

---

## 8. Route Structure

Single-page application served at `monitor.averray.com/`. URL state via search params:

```
/                              → board (default)
/?lane=operator-review         → spotlight a lane
/?card=agent%23548             → open drawer (esc returns)
/?search=foo                   → filter board
```

The slack-operator currently redirects `/` to `/monitor` for the legacy HTML monitor. M1' keeps that redirect; the new SPA mounts at `/monitor` AND at `/` if needed. Exact mount path settled in M2'.

---

## 9. Component Tree

Same as the operator-app version:

```
<MonitorPage>
  <TopStrip (or TopStripDegraded)>
    <BrandMark /> <KPIPills /> <LiveIndicator /> <Refresh />
  </TopStrip>

  <BoardNowBanner>      // sage / amber / rose by mode
    <Eyebrow /> <Headline /> <Sub /> <PrimaryActions />
  </BoardNowBanner>

  <BoardLayout>         // grid: mini-rail-left | board | mini-rail-right | hermes-rail
    <MiniRail side="left" />
    <Board>{lanes.map(...)}</Board>
    <MiniRail side="right" />
    <CoPilotRail />     // M7'
  </BoardLayout>

  <DetailDrawer />      // M6' — mounts when ?card= set; type-routed body
  <NotificationBus />   // M9'
</MonitorPage>
```

---

## 10. Visual System / Design Tokens

`packages/monitor-ui/src/styles/monitor.css` ships the bundle's `hermes.css` verbatim. Contains:

- `--avy-*` tokens (warm beige, paper cream, sage primary, amber warn, etc.)
- `--hm-*` overlay tokens (`--hm-paper`, `--hm-muted: #5e635a`, distinct Hermes sage `--hm-hermes: #0f6b5a`, etc.)
- All `.hm-*` class definitions (`.hm-board`, `.hm-card`, `.hm-lane`, `.hm-drawer`, etc.)

**A8 a11y bumps** baked into the file: `--hm-muted` from `#6c7068` → `#5e635a`, `--hm-muted-soft` from `#8d8f86` → `#767870`, Hermes sage distinct from success sage.

---

## 11. Interaction Patterns

| Surface | Trigger | Behavior |
|---|---|---|
| Card | click | Sets `?card=`, opens drawer. Scrim over board. |
| Lane | click header | Toggle collapse / expand. |
| Drawer | esc | Close, restore focus. |
| Drawer | scrim click | Close. |
| Search | `/` | Focus the input. |
| Help | `?` | Toggle keyboard overlay. |

Same focus-restore contract: capture `document.activeElement` on open, restore on close. Use `focus-trap-react` or equivalent inside the drawer.

---

## 12. Keyboard Map

Same as the operator-app version. Single source of truth: `packages/monitor-ui/src/lib/monitor/keyboard-map.ts`.

```ts
export const KEYBOARD_BINDINGS = [
  // global
  { key: "?", action: "toggle_keyboard_overlay", scope: "global", wired: true },
  { key: "/", action: "focus_search", scope: "global", wired: true },
  { key: "Escape", action: "close_drawer_or_overlay", scope: "global", wired: true },
  // board
  { key: "j", action: "focus_next_card", scope: "board", wired: true },
  { key: "ArrowDown", action: "focus_next_card", scope: "board", wired: true },
  { key: "k", action: "focus_prev_card", scope: "board", wired: true },
  { key: "ArrowUp", action: "focus_prev_card", scope: "board", wired: true },
  { key: "Enter", action: "open_drawer_for_focused", scope: "board", wired: true },
  { key: "f", action: "spotlight_focused_lane", scope: "board", wired: true },
  { key: "o", action: "open_pr_for_focused", scope: "board", wired: false },  // M10'
  { key: "a", action: "ask_hermes_about_focused", scope: "board", wired: false },  // M10'
  // drawer
  { key: "j", action: "drawer_next_card", scope: "drawer", wired: true },
  { key: "k", action: "drawer_prev_card", scope: "drawer", wired: true },
  { key: "Enter", action: "drawer_primary_action", scope: "drawer", wired: false },
  { key: "A", action: "drawer_action_approve", scope: "drawer", wired: false },
  { key: "B", action: "drawer_action_send_back", scope: "drawer", wired: false },
  { key: "R", action: "drawer_action_rerun_fresh", scope: "drawer", wired: false },
  { key: "M", action: "drawer_action_rerun_memory", scope: "drawer", wired: false },
  { key: "C", action: "drawer_copy_report", scope: "drawer", wired: false },
  // hermes
  { key: "Enter", action: "hermes_send_message", scope: "hermes", wired: false },
  { key: "ArrowUp", action: "hermes_history_prev", scope: "hermes", wired: false },
  { key: "ArrowDown", action: "hermes_history_next", scope: "hermes", wired: false },
] as const;
```

**Input-focus rule:** when an `<input>` or `<textarea>` owns focus, only `Escape` is honored.

---

## 13. Animation & Motion

All animations honor `prefers-reduced-motion: reduce` → downgrade to instant.

| Event | Pattern | Duration |
|---|---|---|
| Lane collapse / expand | Width + opacity transition | 180ms |
| Card moves between lanes | Brief highlight + slide | 180ms |
| Card receives an update | Background pulse | 160ms |
| Action-needed card breathing | 4s slow opacity pulse on `--hm-amber-wash` | indefinite (only when `needs-attention` has exactly 1 card) |
| Drawer open / close | Slide + scrim fade | 180ms |
| Hermes new turn | Slide-in from bottom of rail | 160ms |
| Stream disconnect | LIVE indicator → rose; reconnect spinner | 160ms |

---

## 14. Accessibility

- **WCAG AA contrast minimum** on all text. A8 receipts in the bundle measure every pair.
- **Keyboard navigable end-to-end.** Acceptance: complete a full board → drawer → Hermes-question flow with mouse unplugged.
- **Screen-reader landmarks:** TopStrip is `role="banner"`, lanes are `role="region" aria-label="<lane name>"`, drawer is `role="dialog" aria-modal="true"`, Hermes rail is `role="complementary"`.
- **Focus visible:** sage 2px outline at 2px offset on `:focus-visible`.
- **Live regions:** BoardNowBanner `aria-live="polite"`, Hermes rail `aria-live="polite" aria-atomic="false"`, action-needed lane 0→1 transitions fire `aria-live="assertive"` once.
- **Color is never the only signal.** Urgency = tint + thin border + icon. Stale = fade + "stale Xm" badge. Failed-fetch = rose ribbon + retry button + reason code text.

---

## 15. Performance Budgets

- **First contentful paint:** ≤ 1.2s on a warm cache.
- **Time-to-interactive:** ≤ 2s.
- **Live update render budget:** ≤ 16ms per SSE event.
- **Hermes rail max retained turns:** 200.
- **Done lane max retained:** 50 cards.
- **SSE reconnect ceiling:** 30s max backoff.
- **Memory ceiling target:** ≤ 150MB heap after 8h of continuous use.

---

## 16. Error & Degraded States

`hm-card--err` (rose) and `hm-card--offline` (neutral grey) render through `DegradedCard` when state is `failed-fetch` or `source-offline`. Page-level `TopStripDegraded` swaps in when the SSE stream disconnects: KPIs show `?` instead of `0`, header shows "Hermes — degraded mode" with last-known timestamp, UNTRUSTED banner with reason code.

**Hard rule (§16):** zero tolerance for hiding "we don't know if there's action needed." When the stream is down, KPI counts show `?`, not the last cached number. The operator must always see *why* something didn't load.

---

## 17. Notifications & Alerts

Three tiers:

1. **In-app audio + visual.** Procedural Web Audio API tone (per §21.3) on action-needed 0→1 when tab is visible.
2. **Browser tab badge + title.** `document.title = "(N) Hermes — Averray"` on count change; canvas-rendered favicon swap; Badging API where supported.
3. **Desktop notification.** Action-needed 0→1 when tab hidden.

Mute controls via Hermes co-pilot ("mute for 1 hour" / "mute until 9am").

---

## 18. Testing Strategy

Vitest, matching the existing monitor repo convention.

### Unit (`packages/monitor-ui/src/lib/monitor/*.test.ts`)

- `lane-rules.test.ts` — every card type × every state → expected lane
- `urgency.test.ts` — freshness math, stale thresholds, archive-hint
- `board-state.test.ts` — selectors, KPI counts, mostUrgent, boardMode, boardNowBanner
- `keyboard-map.test.ts` — every binding has all fields; (scope, key) unique
- `card-router.test.ts` — pickRenderer, defaultDegradedContent
- `board-cache.test.ts` — applyEventToBoard per event type
- `drawer-routing.test.ts` — URL encode/decode + j/k traversal
- `snapshot-store.test.ts` — write, evict, read, quota handling
- `live-stream.test.ts` — backoff schedule, status machine

### Backend (`services/slack-operator/src/monitor-v2.test.ts`)

- `toBoardCard()` mapping for every internal-item shape
- `/monitor/v2/board` integration test (mocked store)
- SSE event-emission tests

### Component (Playwright OR Vitest's snapshot)

- Card renders correctly per type × state matrix
- Drawer opens/closes on click; focus restores
- Lane collapse / expand persists in URL

### Manual acceptance

Operator-shift acceptance test: one full shift with the new monitor; count "had to read" vs "could glance" moments.

---

## 19. Observability & Telemetry

- **Frontend logs:** browser console + optional `slack-operator` ingest endpoint (decided in M5').
- **Telemetry events:** `monitor.board.viewed`, `monitor.card.opened`, `monitor.card.action`, `monitor.hermes.question`, `monitor.mission.spawned`, `monitor.notification.sent`, `monitor.stream.disconnected`.
- **Error capture:** browser's `window.onerror` + top-level error boundary; ship to whatever the slack-operator already uses.

---

## 20. Build & Deploy

- **Vite build:** `npm --workspace packages/monitor-ui run build` → `packages/monitor-ui/dist/` (gitignored)
- **Slack operator integration:** at startup, slack-operator serves files from `packages/monitor-ui/dist/` at the monitor route. New route handler in `index.ts` reads the static bundle at boot.
- **Docker:** `ops/Dockerfile.node` already builds the monorepo; just needs to include the new package in the build step.
- **Compose:** no new container; the monitor-ui is part of the existing slack-operator service.
- **CI:** add a `monitor-ui` job to `.github/workflows/ci.yml` running `npm test` and `npm run build`.

---

## 21. Decisions Made

Locked decisions from the original §21 of the operator-app spec (the prior draft) — these are location-agnostic and carry forward unchanged.

1. **`document.title` update strategy** — **Direct mutation via `useEffect`** in a small top-level `TitleBadge` component. *Used by:* M9'.
2. **Favicon badge rendering** — **Canvas-rendered swap, with Badging API as progressive enhancement.** *Used by:* M9'.
3. **Audio asset for the alert tone** — **Procedural Web Audio API tone**. Soft sine-wave chime, 200ms duration, exponential decay. Operator can swap to an uploaded audio file later. *Used by:* M9'.
4. **Snapshot data retention** — **`localStorage` with 24h sliding TTL**, key shape `monitor.snapshot.<isoTimestamp>`. *Used by:* M5' (write); v1.1 (read).
5. **Mission-spawn auth boundary** — **Admin role OR new `mission-operator` role.** Cloudflare Access at the edge plus the existing `SLACK_OPERATOR_MONITOR_TOKEN` are the entry gate; in-app role check on the POST endpoint. *Used by:* M7'.
6. **Multi-repo support** — **Single repo via `AVERRAY_REPO` env var**, but every card carries a `repo: string` field so future aggregation requires no client migration. *Used by:* M1'.
7. **Card-relationships data model** — **Fully deferred to v1.1.** Fresh ADR when the platform tracks PR dependencies. *Used by:* v1.1.

---

## 22. Phased Milestones (PR breakdown)

One narrow PR per milestone, one branch per PR. The work is anchored to this repo (`depre-dev/averray-reference-agent`).

| PR | Title | Scope | Acceptance |
|---|---|---|---|
| **M1'** | `monitor v2: typed board endpoint + SSE in slack-operator` | New `monitor-v2.ts` + `monitor-v2.test.ts` + route handlers in `index.ts`. Maps existing internal items to the `BoardCard` discriminated union. | Vitest covers every mapping branch; `curl /monitor/v2/board` returns valid JSON; SSE keepalive observed. |
| **M2'** | `monitor-ui: scaffold + pure-logic modules` | New `packages/monitor-ui/` package (Vite + React + TS strict + Vitest). Ports lane-rules, urgency, board-state, keyboard-map, card-router, board-cache, drawer-routing, snapshot-store from the reverted operator-app work into the new package. No UI yet. | `npm --workspace packages/monitor-ui test` runs the ported unit tests; ≥120 cases pass. |
| **M3'** | `monitor-ui: top strip + Board Now banner + empty layout` | `<TopStrip>`, `<BoardNowBanner>`, `<LanesBar>`, `<Board>`, `<Lane>`, `<MiniRail>`. Reads against fixtures. | Calm/empty state renders end-to-end; visual matches A5. |
| **M4'** | `monitor-ui: card vocabulary` | `<Card>`, `<DegradedCard>`, `<CardRouter>`, `<ChecksBar>`. All six card types × five state variants. | Rich-mix board renders against fixtures; matches A1 / A7. |
| **M5'** | `monitor-ui: live data wiring` | `useMonitorBoard` SWR hook + `live-stream` SSE client wired to the M1' v2 endpoints. localStorage snapshot writer. Refresh button. | Spawn card via `/monitor/v2/debug/spawn` → appears in UI within 500ms. SSE reconnect verified. |
| **M6'** | `monitor-ui: detail drawer` | `<DetailDrawer>` with PR / Codex / Deploy / Draft / Done variants. URL routing via `?card=`. Focus trap. j/k traversal in drawer scope. | Click card → drawer; esc closes; focus restores. |
| **M7'** | `monitor-ui: browser mission drawer + spawn flow` | Mission-specific drawer body (path, blockers, evidence, mutation boundary, recommendations). `/mission <url>` slash command in Hermes composer. | Spawn a mission → card appears → drawer opens → live progress updates. |
| **M8'** | `monitor-ui: Hermes co-pilot rail` | `<CoPilotRail>` with card-stream narration + `<AskHermesComposer>` + focused-card scoping. | Ask question scoped to focused card; reply renders. |
| **M9'** | `monitor-ui: notifications + tab badge + audio` | All three tiers from §17. Mute settings (localStorage). | Verified across Chrome / Safari / Firefox. |
| **M10'** | `monitor-ui: keyboard shortcuts + overlay` | Full §12 map wired. `o` opens PR, `a` opens Ask-Hermes. `<KeyboardOverlay>` cheat sheet. | Operator does a full shift with mouse unplugged. |
| **M11'** | `monitor-ui: degraded states + error boundaries + a11y pass` | All §16 patterns. `<TopStripDegraded>`. WCAG AA audit. | Stream-down e2e passes; a11y audit clean. |

**Rough sizing:** ~2.5 weeks total for one focused engineer; M1' is ~1 day; M2' ~1.5 days; M3'–M6' ~2–3 days each; M7'–M11' ~1–2 days each.

---

## 23. Definition of Done (operator-shippable)

- All 11 milestones merged on `depre-dev/averray-reference-agent` main.
- WCAG AA audit clean.
- One full operator shift used the new monitor with zero "had to read instead of glance" moments.
- SSE disconnect → reconnect → catch-up works end-to-end.
- Browser missions spawn, run, and report through the MissionDrawer.
- Notifications fire on action-needed transitions in all three tiers.
- The "Error update failed" pill from the legacy HTML monitor is replaced by something that says exactly *what* failed and *what to do about it*.
- The legacy HTML monitor at `monitor.averray.com` can be retired with confidence.

---

## Appendix A — What the prior operator-app draft assumed wrong

The earlier version of this spec (v1.0 on `averray-agent/agent`) assumed the redesign would live inside the operator app at `app/app/(authed)/monitor/` with a backend at `mcp-server/src/services/monitor-service.js`. That was incorrect — the Hermes monitor is deliberately a separate deployment with separate auth (Cloudflare Access, not SIWE). Four implementation milestones (M1–M4) landed against the wrong codebase and have been reverted ([revert PR #563](https://github.com/averray-agent/agent/pull/563) on the operator app).

The visual design, the data model, the §21 decisions, and the milestone shape all carry forward unchanged. Only the implementation locations + stack choices change:

| | Reverted (wrong) | Correct |
|---|---|---|
| Repo | `averray-agent/agent` | `depre-dev/averray-reference-agent` |
| Frontend home | `app/app/(authed)/monitor/` (Next.js app-router) | `packages/monitor-ui/` (Vite SPA) |
| Frontend framework | Next.js 15 | Vite 5 + React 18 |
| Backend home | `mcp-server/src/services/monitor-service.js` | `services/slack-operator/src/monitor-v2.ts` |
| Auth | SIWE + AuthedGuard | Cloudflare Access + optional bearer |
| Tests | `node:test` + `.test.mjs` | Vitest + `.test.ts` |
| Deploy | Operator app static export | slack-operator serves the Vite-built `dist/` |
| URL | `app.averray.com/monitor` | `monitor.averray.com` |

This spec is the corrected v1.0.

---

*End of spec. v1.0 corrected.*
