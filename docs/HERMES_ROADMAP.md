# Hermes Orchestration — Roadmap & Naming Index (canonical)

- **Status:** Code-backed planning index. This is the **single source of truth for work-item IDs and order.** It supersedes the old `P#` / `Phase #` labels.
- **Date:** 2026-06-01

> **Naming:** one prefix per stream, numbered within it. **`P#` and `Phase #` are retired** — they collided (`P2` Claude worker vs `Phase 2` A+D). Use the IDs below in all handoff prompts and discussion.

> **Reconciliation note (2026-06-01, rev 2):** This index was reconciled against merged PRs #252-#339, a fresh `gh pr list --state open` check showing **no open PRs**, and local code/ops evidence. It marks only code-backed shipped slices as done; where a row is a partial slice, the status says so and names the remaining follow-up. No row should imply active work unless an open PR exists. This revision marks **T4 live driver (#337)** and **C3 security/docs specialists (#339)** done, both verified in code.

## Streams

| ID | Stream | Design doc |
|----|--------|-----------|
| **O** | Orchestration core | `HERMES_ORCHESTRATION_DESIGN.md` (+ `HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md`, `HERMES_INTEGRATION_MAP.md`) |
| **A** | Agent performance | `HERMES_PHASE2_DESIGN.md` *(historical)*, `HERMES_AGENT_MODELS_AND_EFFORT.md` (A4) |
| **D** | Operator trust | `HERMES_PHASE2_DESIGN.md` *(historical)*, `HERMES_AGENT_REQUESTS_AND_ALERTS.md` (D4) |
| **B** | Hermes as planner | `HERMES_PHASE3_DESIGN.md` *(file name historical)* |
| **C** | Multi-agent collaboration | `HERMES_PHASE4_DESIGN.md` *(file name historical)* |
| **T** | E2E tester | `HERMES_E2E_TESTER_DESIGN.md`, `HERMES_TESTER_AUTH_DESIGN.md`, `HERMES_AGENT_REQUESTS_AND_ALERTS.md` (T6/T7) |

## Work items

| ID | Item | Status |
|----|------|--------|
| O0 | Discovery (integration map) | ✅ done (#245; `docs/HERMES_INTEGRATION_MAP.md`) |
| O1 | Agent attribution (branch-prefix → agentType) | ✅ done (#252) |
| O2 | Claude Code worker (greenfield, Agent SDK) | ✅ done (#256 queue · #259 auth · #260 runner · #262 worker · #263 ops) |
| O3 | Board-driven dispatch | ✅ done — create/approve form (agent picker) + `/task` verb live on the board (#271) |
| O4 | Hermes enqueue + dispatch guardrail + autonomy mode | ✅ done — PR1 enqueue+guardrail (#280) · PR2 routing taxonomy (#281) · PR3a autonomy mode (#288) · PR3b autopilot auto-approval (#289); merge/deploy remain human-gated |
| O5 | Self-management hardening | ✅ done — failed/stale agent tasks surface in `needs-attention` (#298; `services/slack-operator/src/monitor-v2.ts`, tests in `test/unit/monitor-v2.test.ts`), board liveness truth fix landed in #307, and bounded retry / stale escalation / restart reconciliation hardening landed in #336 (`services/slack-operator/src/task-health.ts`, queue retry fields in `services/slack-operator/src/codex-task-queue.ts`, O5 env wiring in `ops/compose.yml`) |
| A1 | Agent scorecard | ✅ done (#285) — read-only `/monitor/agents` + `averray_agent_scorecard` scorecard slice |
| A2 | Learned routing (data-driven, non-high-risk) | ✅ done (#287) — scorecard-backed default routing, high-risk rule-bound |
| A3 | Cost visibility / cost-aware routing | ✅ done — A3a cost visibility (#295) + A3b cost-aware routing (#301; `packages/averray-mcp/src/learned-routing.ts`, `test/unit/learned-routing.test.ts`) + dispatch USD budget gate (`packages/averray-mcp/src/dispatch-policy.ts`) |
| A4 | Agent model & effort policy — riskTier→effort/model + operator override (tester LLM; Hermes model = open) | ✅ done (#292) — riskTier→effort/model + operator override |
| D1 | "While you were away" digest (board + Slack/push) | ✅ done (#294) — autopilot/session digest + operator report surface |
| D2 | Explainability / decision records | ✅ done (#296) — dispatch decision records and replay surface |
| D3 | Anomaly auto-pause (tiered soft→hard) — owns the autopilot-suspended flag | ✅ done (#286) — anomaly auto-pause owns autopilot-suspended flag |
| D4 | Off-device alert bridge (Slack now → push later; action-needed 0→≥1; quiet-hours/mute) — **O4 prerequisite** | ✅ done (#279) |
| B1 | Backlog generation (roadmap auto-flow; net-new escalates) | ✅ first slices done — read-only board suggestions (#303; `services/slack-operator/src/backlog-suggestions.ts`) + roadmap-backed `averray_hermes_backlog_plan` (#306; `packages/averray-mcp/src/hermes-backlog.ts`). Idle-triggered auto-flow remains follow-up; no open PR as of 2026-06-01 |
| B2 | Self-healing (auto-fix non-high-risk; rollback human) | ✅ shipped/live-capable — proposes-only self-healing core (#309; `services/slack-operator/src/self-healing.ts`), stable testbed target dedupe + open-fix cap (#313), duplicate/cap hardening (#314 + #317; `services/slack-operator/src/self-healing.ts`, `test/unit/self-healing.test.ts`), D3/HALT interlock and `b2_self_healing_acted` logging (`services/slack-operator/src/index.ts`), and `B2_SELF_HEALING_*` ops wiring (`services/slack-operator/src/routines.ts`, `ops/compose.yml`). Prod observation: B2 emitted `b2_self_healing_acted`; rollback/high-risk still escalates |
| C1 | Cross-agent review (default) | ✅ first slice done — review request primitives + card/drawer attachment (#302; `services/slack-operator/src/monitor-collab.ts`, `services/slack-operator/src/monitor-v2.ts`, `packages/monitor-ui/src/components/cards/Card.tsx`). Automatic default reviewer dispatch remains follow-up; no open PR as of 2026-06-01 |
| C2 | Reviewer panel (high-risk) | ✅ done (#308 + #315; `services/slack-operator/src/reviewer-panel.ts`, panel request/response wiring in `services/slack-operator/src/monitor-collab.ts`, action-needed escalation in `services/slack-operator/src/monitor-v2.ts`, tests in `test/unit/reviewer-panel.test.ts` and `test/unit/monitor-v2.test.ts`) |
| C3 | Specialist agents (test-writer/security/docs) | ✅ done — `test-writer` specialist template (#310) + off-by-default runner wiring (#311; `ops/compose.yml`, `test/unit/test-writer-runner.test.ts`) + **security & docs specialists (#339; `services/slack-operator/src/specialist-agents.ts`)**. All three specialists off by default, modular, proposes-only (security high-risk findings escalate); further specialists slot into the same template |
| C4 | Inter-agent chat | ✅ done (#291) — Claude author/target + card-scoped agent messages v1 |
| T1 | Surface sweep + truth-boundary honesty | ✅ done — executor #273; deploy-wire (platform #604) + runner #277; runs per-deploy (report-only) |
| T2 | Pre-seeded session (authed sweep) | ✅ done (#293) |
| T3 | Signer sidecar + SIWE mission (multi-role) | ✅ done — signer sidecar foundation (#283) + SIWE role-gating mission (#290) |
| T4 | Tier-2 agent (Agent SDK + Playwright-MCP) | ✅ done — scaffold + fake driver (#318) + **live Claude Agent SDK + Playwright-MCP gold-path driver (#337; `services/slack-operator/src/gold-path-live-driver.ts`, `gold-path-mission.ts`, `claude-worker-auth.ts`)**, opt-in behind `TESTBED_GOLDPATH_LIVE`, fake/default path retained for CI. First hosted/live run proof is an operational follow-up (run + observe), not a build |
| T5 | Env→mutation binding + enhancements (trace/video, baselines) | ✅ done (#297) — env-bound mutation profile + Playwright trace/video + baseline comparison slice |
| T6 | Agent-requested tester runs — board-gated (request → approve → read-only run) | ✅ first slice done (#304; `POST /monitor/testbed-missions/request`, `/approve`, board approve UI, and runner ignores `requested` until approval) |
| T7 | Tester capabilities manifest (+ platform-repo request helper) | ✅ reference-agent manifest done (#284; `GET /monitor/tester/capabilities`, `services/slack-operator/src/tester-capabilities.ts`). Platform-repo request helper remains follow-up outside this repo |

*(Status as of 2026-06-01 (rev 2) — **shipped/code-backed:** O0–O5, A1–A4, D1–D4, B1 first slices, B2 proposes-only self-healing, C1 first slice, C2, **C3 (test-writer + security + docs specialists)**, C4 v1, T1–T3, **T4 (live gold-path driver)**, T5, T6 first slice, and the T7 reference-agent manifest. The **v2 monitor redesign also landed in full** — degraded card states (#331), mission-drawer polish (#333), operator checklist + private note (#338), co-pilot turn anatomy (#335), and the banner/filter/footer/composer wiring (#320–#332, #334). **No open PRs.** **Design / follow-up (no open PR):** B1 idle-triggered auto-flow and C1 automatic/default reviewer dispatch (both intended build-now-flag-off, enable only post-burn-in), T4's first hosted/live run proof, and the T7 platform-repo helper (lives in `averray-agent/agent`). Merge/deploy remain human-gated; autopilot approves dispatch only inside O4 guardrails.)*

## Recommended build order (the smooth, low-effort ramp)

1. **The self-feeding loop:** **O1 → O2 → O3.** Once this exists you stop hand-writing prompts; work is enqueued from the board and you just approve. Highest-leverage effort.
   - **T1** runs in parallel with O1 (independent, both runner/board TS).
2. **The safety net:** **D4** (off-device alert bridge), **T1**, **T2 + T3** (tester reaches authed product), **D1 + D3** (digest + anomaly auto-pause), and **T5** (env-bound mutation profile). This foundation has shipped; **T6** has its first request/approve gate slice, and **T7** has the reference-agent manifest. The platform helper remains follow-up.
3. **Autonomy:** **O4** (enqueue + guardrail + autonomy mode) has shipped; supervised burn-in and monitoring decide when to rely on it more heavily.
4. **Depth — now code-backed:** **A1–A4**, **O5** hardening, **B2**, **C2**, **C3** (test-writer + security + docs), and **T4** (live gold-path driver) are all shipped. **Remaining (no open PR):** **B1 idle auto-flow** and **C1 automatic/default reviewer dispatch** — both intended to ship behind default-off flags and enable only after the supervised burn-in; **T4's first hosted/live run proof**; and the **T7 platform-repo helper** (in `averray-agent/agent`). At this point the O/A/B/C/D/T roadmap is effectively complete — what remains is operator-gated enablement, not new build.

**Dependencies to respect:** B2 needs D3 (loop fail-safe); A2 needs A1 (baselines); O4 is the authority change and needs D4 (escalations must reach the operator off-device); T6 needs the proposed-mission approval gate; T-missions that mutate stay on testnet (env→mutation binding before any mainnet).

## Old → new mapping (so prior references resolve)

| Old | New |
|-----|-----|
| P1 / P2 / P3 / P4 / P5 | O1 / O2 / O3 / O4 / O5 |
| Phase 0 (discovery) | O0 |
| "Phase 2" (A+D) | streams **A** + **D** |
| "Phase 3" (B) | stream **B** |
| "Phase 4" (C) | stream **C** |
| tester "step 1…5" | T1 … T5 |

---

*Canonical naming index. Use O / A / B / C / D / T everywhere going forward.*
