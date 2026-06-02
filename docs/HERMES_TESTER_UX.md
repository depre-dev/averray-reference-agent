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

## 4. Live run panel *(poll-to-completion — honest)*

**Feasibility (verified):** full per-step streaming is NOT worth it now (the agent posts one terminal report). **Poll-to-completion is feasible and low-effort.** Build on existing wiring: `board.card.updated` SSE fires every poll (`monitor-v2.ts:1907`); `publishProgress` writes `progressMessage` + a sanitized stdout tail throttled to ~1 write / 2s (`testbed-mission-runner.ts:289`).

**Panel:** in `MissionBody` (`DrawerBody.tsx:458`), branch on `missionStatus === "running"` → a `MissionRunInProgress` view: a **stage badge** from `progressMessage` + scrollable **recent runner output** (the sanitized tail), refreshing ~every 2s; on completion the *same* `MissionBody` auto-swaps to the full verdict/path/blockers/evidence (P0) — no new component, no reload.
- **Honest copy:** "recent runner output" (it's a rolling ~12KB tail — older steps scroll off), and it refreshes ~2s; never imply a full per-step ledger (critique #4/#5). Never show a verdict before the agent posts one.
- **Optional [Codex] sub-task:** have the runner extract a `STAGE: …` marker from stdout into `progressMessage` (`testbed-mission-runner.ts:289`) so stages advance visibly — chain after the panel lands (touches the runner boundary Codex owns).

---

## 5. Gold-path flagship — the SIWE session *(prerequisite for the real flagship scope)*

The gold-path suite is first-class in the vision but can't run the *authed* flow on Basic-Auth alone — it needs the SIWE session on top (the #371 follow-up): the gold-path mission requests an authenticated session from the T3 signer sidecar (API Bearer + browser `storageState`), the browser context carries **both** Basic Auth `httpCredentials` and the SIWE `storageState`, testnet-only mutation, sponsored/starter jobs to run unfunded. *(Full prompt in `HERMES_TESTER_AUTH_DESIGN.md` follow-up.)*

---

## 6. Prioritized handoff prompts (one narrow PR each)

| # | Prompt | Type · Owner |
|---|---|---|
| **P0** | Attach the real report — **verify the `correlationId→missionIndex` join first** (likely culprit), project the verdict one-liner, honest no-report fallback that never masks a real FAILED. Regression test: a completed run with a structured report → populated `card.mission`. | BUG · Claude |
| **P1** | "Start a mission" launcher MVP (target → flow + Fresh/Memory → goal + request-approval; widen the POST body; wire the approve gate; mutation-flag-ignored test; no role step). | FEATURE · Claude |
| **P2** | Gold-path **SIWE session** (T3 sidecar → Bearer + storageState; browser carries Basic Auth + SIWE; testnet-only; sponsored jobs). | FEATURE · Codex |
| **P3** | Live run panel (poll-to-completion; `missionStatus==="running"` branch in `MissionBody`; honest "recent output ~2s"). | FEATURE · Claude |
| **P4** | Saved suite library (suite store + Suites panel + Run + run history) + the predefined/NL **+ New suite** paths. | FEATURE · Claude |
| **P5** | The agent authoring paths — test-writer (C3) suite proposals + platform-agent suite requests (T6 gate). | FEATURE · Codex+Claude |

**Sequence:** P0 (readable) → P2 (gold-path can actually run authed) → P1 (easy launch) → P3 (follow it live) → P4/P5 (the library + agent authoring). P0 first — the report-attachment bug is what makes the whole tester feel broken.

**Invariants:** truth-boundary throughout (real runs only — no fabricated verdicts, no implied per-step streaming, honest "recent output"); testnet-only mutation, server-enforced; the UI can never enable mutation on a prod target; keys/sessions stay in the sidecar.

---

*End. The tester becomes a library of named suites the operator grows and re-runs — readable reports, an approachable launcher, live-followable runs, gold-path as flagship. Build readability first; grow the library after.*
