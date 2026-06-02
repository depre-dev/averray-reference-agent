# Hermes Tester UX — Saved Suite Library, Readable Reports, Live Runs

- **Status:** Plan / handoff. Grounded in a code-level audit (3 auditors + adversarial critique) of the live tester, anchored on the operator's refined vision.
- **Date:** 2026-06-01
- **Companions:** [`HERMES_E2E_TESTER_DESIGN.md`](./HERMES_E2E_TESTER_DESIGN.md), [`HERMES_TESTER_AUTH_DESIGN.md`](./HERMES_TESTER_AUTH_DESIGN.md), [`HERMES_BOARD_WORKFLOW_REDESIGN.md`](./HERMES_BOARD_WORKFLOW_REDESIGN.md).

> **Method note:** seams below are **verified** against the source; the adversarial pass corrected several (the live P0 bug is the *join*, not normalization; runner/store line citations fixed). Re-confirm a seam before cutting its prompt.

---

## 0. The operator's vision — the tester is a SAVED SUITE LIBRARY

Not "fire an ad-hoc mission" — a **library of named, saved test suites** you build up and re-run, accruing **regression coverage** (operator chose *saved named suites*, not ad-hoc).

**A suite = name + target(page/route) + scope + test cases + run history.** Re-run per deploy or on demand; each run produces a readable report and appends to the suite's history.

**Test cases are authored by all four sources** (operator chose all four), each an entry point to create/grow a suite:
1. **Predefined / built-in** — pick `gold-path` / `surface-sweep` / `role-gating` off the shelf.
2. **Operator natural-language** — describe the goal ("a new user can claim a job and see a receipt"); the LLM tester (T4) interprets + drives + self-judges; saved as a suite.
3. **Agent-authored** — the C3 **test-writer specialist** generates suites for changed surfaces / coverage gaps; saved + re-run.
4. **Platform-agent requested** — product-repo agents propose a suite for their feature; operator approves (the T6 gate).

**Flagship scope = the GOLD-PATH FLOW** (onboard → claim → submit → verify → payout → receipt) — first-class in the launcher. *It needs the SIWE session (the #371 Basic-Auth follow-up) to run the authed flow.*

**Scope ladder:** smoke (loads) · surface-sweep (routes + truth-boundary honesty) · gold-path (journey) · targeted-feature (assertion).

The launch UX becomes a **Suites panel** — pick a saved suite → Run, or **+ New suite** via any of the four authoring paths — replacing the obscure `/mission <url>` command.

---

## 1. Honest state

**What already works (real, end-to-end):** a mission launches, the testbed runner claims the browser, authenticates (Basic Auth #371), drives a real run (surface-sweep or gold-path), and **produces a genuine structured report** — verdict, confidence, scores, path, blockers, evidence, mutation-boundary — written to `run.result.structuredReport` (`monitor-testbed-missions.ts:414`). The drawer even has a real `MissionBody` renderer (`DrawerBody.tsx:458`) that draws all of it *when a report is present*.

**The three gaps (your three asks):**
1. **Report doesn't reach the card** → drawer shows generic "CLOSED", "says nothing to me." The report is on the run, but `card.mission` only populates when the `correlationId→missionIndex` join **and** `mapMissionReport` normalization both succeed; when either misses, the drawer falls back (`DrawerBody.tsx:461-470`).
2. **Obscure launch** → only `/mission <url>` (`hermes-commands.ts:34-59`); flow, role, goal, save, and the approve gate are invisible.
3. **No live follow** → only `progressMessage` + a sanitized stdout tail update during a run; the structured verdict/path materialize once, at the end.

---

## 2. P0 — Make reports readable *(the foundation — do first)*

A tester whose results say "CLOSED" is useless, so this is first and small. **Reuse the existing `MissionBody` — do not invent a renderer.**

**Diagnose before coding (critique's correction):** the stated culprit (normalization) is probably *not* the live bug. `testbedMissionStructuredReport`→`normalizeTestbedMissionStructuredReport` returns `undefined` only when `normalizeVerdict` is undefined, and completed runs already write a normalized report. **The likely live bug is the JOIN:** `missionIndex` keys on `run.id`, and the join is `missionIndex.get(item.correlationId)` (`monitor-v2.ts:1814-1817`) — it only resolves if the mission **board item** carries `correlationId === run.id`, which is stamped upstream in `monitor-hermes-board.ts` and is *unverified*. **Verify the snapshot's mission-item `correlationId` end-to-end first**, with a real completed run, before touching any normalization.

**Then fix:**
- (a) **Join:** ensure the mission board item's `correlationId` equals the run id so `ctx.missionRun` populates and `card.mission` attaches (`monitor-v2.ts:1446-1453`).
- (b) **Card one-liner:** project verdict + top blocker into `card.summary`/`verdictText` via `reportSource` (`monitor-v2.ts:1242-1245`) so a closed card reads e.g. `PASS · gold-path · 0 blockers`, not `CLOSED`.
- (c) **Honest fallback:** in `MissionBody` (`DrawerBody.tsx:461-470`), when status is completed/closed **and** `card.mission` is genuinely absent, show the run's `statusReason`/`summary` as coaching text ("Run finished without a structured report — see recent output"), **never a fabricated verdict.** Confirm this fires only on the true no-report case — a real `verdict:"fail"` run *must* still render the full FAILED `MissionBody`, not be masked behind "see console."
- **Truth-boundary:** never synthesize a verdict; don't loosen `normalizeVerdict` to accept junk.

---

## 3. The Suite Library + launch *(the operator's vision, built in slices)*

### 3a. MVP launcher (first slice — reuses existing endpoints)
A board **"Start a mission"** entry → a small launcher (reuse v2 drawer chrome):
- **Target:** URL input, validate `https?://`, default `https://app.averray.com`.
- **Flow:** radio — **Surface Sweep** (read-only, prod-safe → `mode:"surface_sweep"`) vs **Gold Path** (transactional, testnet → `mode:"gold_path"`) + Fresh/Memory toggle.
- **Goal** (optional textarea, for NL missions) + **"Request approval"** checkbox (`initialStatus:"requested"` vs `"ready"`).
- *(Drop the role selector in v1 — only `operator` is usable today; add it when admin/verifier exist. Critique #7.)*

**Wiring (no new state machine):** widen the POST body in `MonitorPage.tsx:158-166` to `{ targetUrl, mode, goal?, freshMemory, initialStatus }` — the endpoint already accepts these (`monitor-testbed-missions.ts:34-83`). The T6 approve gate already exists (`initialStatus:"requested"` → `POST /monitor/testbed-missions/:id/approve`, `:303-329`); surface **Approve/Dismiss** on requested cards. Keep `/mission <url>` working. **Mutation safety:** the launcher must NOT send a raw `allowTestMutations:true`; the server derives mutation from `mode` + env + target — add a test that a client mutation flag against a prod target is ignored (critique #6).

### 3b. Saved suites (the library)
Promote a launched config into a **named, saved suite** = `{ name, target, mode, goal?, role?, author: predefined|operator|test-writer|platform, createdAt }` + **run history** (each run's id, verdict, timestamp). New store alongside the testbed-missions store; a **Suites panel** lists suites with last-run verdict + a **Run** button (fires a run with the saved config) and **+ New suite**.

### 3c. The four authoring paths into "+ New suite"
1. **Predefined** — pick a built-in flow (gold-path/surface-sweep/role-gating) + target → save.
2. **Operator NL** — name + target + goal → save (the LLM tester interprets at run time).
3. **Test-writer (C3)** — Hermes/test-writer proposes a suite for a surface/PR → operator approves → save. *(Wire the existing C3 specialist to emit suite proposals.)*
4. **Platform-agent request** — product-repo agent proposes a suite (the T6 request endpoint) → approve → save.

*(3a is the MVP; 3b+3c grow the library. Gold-path as flagship needs §5.)*

---

## 4. The run lifecycle — dispatch → live follow → end report *(the operator's "1:1" ask)*

The operator's flow: **send the command → it's dispatched and goes "ready/running" → open the drawer and watch what's happening → when done, an end report with a conclusion + a fix suggestion if it failed.** That's a clear lifecycle the drawer should make visible:

`requested / dispatched → running (live) → done (verdict + conclusion + recommendations)`

**Believability note:** a run's *depth* (and time) comes from its scope — an explore mission does ~2 steps in ~3s; a gold-path run does many steps + on-chain txs and takes tens of seconds. The runner genuinely drives Chromium (video/trace/screenshots prove it); thin/fast runs are thin *because the scope is thin*. (Confirm `TESTBED_GOLDPATH_LIVE=1` so the gold-path uses the real driver, not the fake.)

### 4a. Live follow panel (poll-to-completion — honest)
**Feasibility (verified):** the agent posts one terminal report, so per-step *field* streaming isn't free — but **poll-to-completion is low-effort** on existing wiring: `board.card.updated` SSE fires every poll (`monitor-v2.ts:1907`); `publishProgress` writes `progressMessage` + a sanitized stdout tail throttled to ~1 write / 2s (`testbed-mission-runner.ts:289`).

In `MissionBody` (`DrawerBody.tsx:458`), branch on `missionStatus === "running"` → a `MissionRunInProgress` view: a **stage badge** (from `progressMessage`), the **latest screenshot**, and scrollable **recent runner output** (the rolling tail), refreshing ~every 2s; on completion the *same* `MissionBody` auto-swaps to the full end report — no new component, no reload.
- **Honest copy:** "recent runner output" (a rolling ~12KB tail — older steps scroll off); refreshes ~2s; never imply a full per-step ledger or show a verdict before the agent posts one.
- **Optional [Codex]:** extract a `STAGE: …` marker from stdout into `progressMessage` so stages advance visibly.

### 4b. The end report = conclusion + fix suggestion
On completion the drawer must read like a verdict you can act on: the **scope/goal** at top, the **verdict + a one-line conclusion**, the **path/steps**, and — if it failed or found issues — the **recommendations** ("the fix") plus the **"Create product fix → Codex"** action (already in the footer) to dispatch that fix. The report already carries `goal`, `scores`, `blockers`, `recommendations`, and the agent's `what_i_tried` narrative — *surface them* (see P0b); today the drawer shows only verdict/path/evidence, so a thin run "says nothing."

### 4c. True 1:1 live *(optional upgrade — P3b)*
The 2s poll panel gets you "watch the steps + latest screenshot advance." A literal frame-by-frame **live screencast of the browser** is a separate, bigger build (a video / CDP screencast stream) — offered as **P3b**, not pretended into the poll panel.

---

## 5. Gold-path flagship — the SIWE session *(prerequisite for the real flagship scope)*

The gold-path suite is first-class in the vision but can't run the *authed* flow on Basic-Auth alone — it needs the SIWE session on top (the #371 follow-up): the gold-path mission requests an authenticated session from the T3 signer sidecar (API Bearer + browser `storageState`), the browser context carries **both** Basic Auth `httpCredentials` and the SIWE `storageState`, testnet-only mutation, sponsored/starter jobs to run unfunded. *(Full prompt in `HERMES_TESTER_AUTH_DESIGN.md` follow-up.)*

---

## 6. External-agent invocation protocol

How a product-repo (external) agent discovers what the tester can do, sees what's ready, and asks it to run a mission. **Most of this already exists** — T7 (capabilities manifest, `tester-capabilities.ts`) + T6 (request/approve, `monitor-testbed-missions.ts`). The contract is **Discover → Request → Approve → Run → Report**, and the manifest is *where the agent learns capabilities + readiness*.

### The five-step contract
1. **DISCOVER** — `GET /monitor/tester/capabilities` → a self-describing manifest: each flow with `status`, `scope`, `mutationRule`, and an example invocation:
   - `surface_sweep` · read_only · `available`
   - `authed_surface_sweep` · read_only · `available` | `ready_needs_session` (tells the agent if the T2 session is wired)
   - `siwe_auth` · read_only
   - `gold_path` · testbed_mutation_only · `available_live_driver` | `ready_needs_live_driver` (tells the agent if the real driver is on)
   The `status` field is the truth-boundary — it never advertises a capability that isn't actually runnable.
2. **REQUEST** — POST a mission with `initialStatus: "requested"` + `requesterAgent` + `requestReason` → it parks as a `requested` card. **External agents REQUEST, they cannot RUN** — the security boundary.
3. **APPROVE** — the requested card appears on the board; the operator approves (`/approve`) or dismisses. The human decides whether to spend the run. (A future trust policy could auto-approve low-risk read-only requests.)
4. **RUN** — the testbed-mission-runner claims + runs (read-only by default; mutating only on testnet per the env binding; the server overrides any client-supplied mutation flag).
5. **REPORT** — the structured report (verdict/path/blockers/evidence — the §2 report) flows back to the requester (poll the mission id / callback) and onto the board.

### What's missing to make it a real external contract (→ P6–P8)
The manifest describes capability *types* but not the live *inventory* of runnable suites; it isn't *advertised* to external agents; and the report doesn't flow *back* to the requester. Three narrow PRs close it.

### Invariant
External agents are **requesters, never runners.** They discover via the manifest, request with an identity + reason, and read the report back — every actual run passes the operator approve gate (or an explicit trust policy), and mutation stays server-enforced testnet-only.

---

## 6.5 Invocation autonomy — internal runs autonomous within budget, external runs operator-gated

The operator is **not in the loop for the tester's own runs.** Two trigger classes, two policies:

| Trigger | Policy |
|---|---|
| **Internal** — operator-scheduled, per-deploy, or a saved-suite run | **Autonomous** within a spend/safety budget. No per-run approval: auto-posts a claimable test job, auto-runs the smoke ladder, then claims → completes → submits → settles. |
| **External** — a product-repo agent's request (T6, `requesterAgent`) | **Operator-gated.** Parks as `requested` until the operator approves; then runs the same autonomous flow. |

**The spend/safety budget — set once, then hands-off** — replaces per-run approval for internal runs:
- **testnet-only** wallet; configurable **caps** (max USDC/day, max stake/run, max concurrent runs);
- **D3 anomaly-pause + `HALT_FILE`** interlock; **abort-on-red-preflight** (a failed smoke ladder never claims);
- **stop + escalate** on any revert / policy rejection / anomaly — never retry blindly;
- a run that would exceed the budget is **blocked + escalated**, not silently run.

So "without the operator's involvement" means *bounded once by the budget*, then autonomous — the operator steps in only for (a) external-agent requests and (b) anything that hits a rail. Mirrors the O4 autopilot model: set the bounds once, the system operates inside them; merge/deploy and over-budget stay human.

---

## 7. Prioritized handoff prompts (one narrow PR each)

| # | Prompt | Type · Owner |
|---|---|---|
| **P0** | Attach the real report — **verify the `correlationId→missionIndex` join first** (likely culprit), project the verdict one-liner, honest no-report fallback that never masks a real FAILED. Regression test: a completed run with a structured report → populated `card.mission`. | BUG · Claude ✅ #383 |
| **P0b** | **Mission report detail** — in `MissionBody` (`DrawerBody.tsx`) surface the report's `goal`/scope at the top, the `what_i_tried` agent narrative as a "What the agent did" section, and the **recommendations** + **Create-product-fix** as the "conclusion + fix" — plus per-step detail (status + latency) and scores/blockers when present. Truth-boundary: show only what the report contains; a thin run shows its real thin path. | FEATURE · Claude |
| **P1** | "Start a mission" launcher MVP (target → flow + Fresh/Memory → goal + request-approval; widen the POST body; wire the approve gate; mutation-flag-ignored test; no role step). | FEATURE · Claude |
| **P2** | Gold-path **SIWE session** (T3 sidecar → Bearer + storageState; browser carries Basic Auth + SIWE; testnet-only; sponsored jobs). | FEATURE · Codex |
| **P3** | **Run lifecycle + live follow** — drive the drawer through `requested/dispatched → running (live) → done`: while running, show a stage badge + latest screenshot + recent output (~2s poll); auto-swap to the end report on completion. Honest copy (no fake per-step ledger; no verdict before the agent posts one). | FEATURE · Claude |
| **P3b** | **True 1:1 live screencast** *(optional upgrade)* — a frame-by-frame video/CDP screencast of the browser as the mission runs, streamed to the drawer. Separate, bigger build; only if the 2s step-view isn't enough. | FEATURE · Codex+Claude |
| **P4** | Saved suite library (suite store + Suites panel + Run + run history) + the predefined/NL **+ New suite** paths. | FEATURE · Claude |
| **P5** | The agent authoring paths — test-writer (C3) suite proposals + platform-agent suite requests (T6 gate). | FEATURE · Codex+Claude |
| **P6** | Manifest: add the **ready-to-test inventory** — extend `GET /monitor/tester/capabilities` (`tester-capabilities.ts`) beyond flow *types* to list saved suites (name, flow, target, last-run verdict+ts), available targets/envs + reachability + mutation profile; keep per-flow `status` honest. | FEATURE · Claude+Codex |
| **P7** | **Report-back to the requester** — when a mission carries `requesterAgent` (T6), make the structured report retrievable by it (`GET /monitor/testbed-missions/:id` returning the same MissionBody report / a callback). Read-only; no operator-private data leaks. | FEATURE · Codex |
| **P8** | **Advertise the tester in the product repo** (`averray-agent/agent`, T7 follow-up) — a thin request helper + AGENTS.md pointer: discover (manifest) → request (T6, requester+reason) → read report (P7); operator-gated, request-only, read-only by default. | FEATURE · Claude |
| **P9** | **Autonomous gold-path runs within a spend budget** (§6.5) — internal runs (scheduled / per-deploy / suite) auto-post a claimable test job + auto-run the smoke ladder + claim→submit→settle with **no operator step**, bounded by an operator-set testnet-only spend budget (USDC/day, stake/run, concurrency) + D3/HALT interlock + abort-on-red-preflight + stop-on-anomaly; **external-agent (T6) requests stay operator-gated.** | FEATURE · Codex |

**Sequence:** P0 ✅ (readable) → **P0b ✅ (report detail — scope/conclusion/fix)** → P2 ✅ (gold-path authed) → **P9 (autonomous runs within budget — so the tester runs itself, hands-off)** → P1 (easy launch) → P3 (run lifecycle + live follow) → P3b (optional 1:1 screencast) → P4/P5 (library + agent authoring) → P6/P7/P8 (external-agent contract). With P0/P0b/P2 done, **P9 is the move that makes it autonomous** — internal runs execute within the budget without the operator; the operator's only gate is approving external-agent requests.

**Invariants:** truth-boundary throughout (real runs only — no fabricated verdicts, no implied per-step streaming, honest "recent output"); testnet-only mutation, server-enforced; the UI can never enable mutation on a prod target; keys/sessions stay in the sidecar.

---

*End. The tester becomes a library of named suites the operator grows and re-runs — readable reports, an approachable launcher, live-followable runs, gold-path as flagship. Build readability first; grow the library after.*
