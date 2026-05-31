# Hermes Orchestration — Roadmap & Naming Index (canonical)

- **Status:** Planning index. This is the **single source of truth for work-item IDs and order.** It supersedes the old `P#` / `Phase #` labels.
- **Date:** 2026-05-31

> **Naming:** one prefix per stream, numbered within it. **`P#` and `Phase #` are retired** — they collided (`P2` Claude worker vs `Phase 2` A+D). Use the IDs below in all handoff prompts and discussion.

> **Reconciliation note (2026-05-31):** This index was reconciled against landed PRs #285-#297. It marks only code-backed shipped slices as done; A3b cost-aware routing/budget remains in progress, and T4/T6/T7 plus the remaining B/O5/C follow-ups stay design/follow-up unless code evidence proves otherwise. Current `main` has an O5 first slice in build, but O5 is not marked complete.

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
| O0 | Discovery (integration map) | ✅ done |
| O1 | Agent attribution (branch-prefix → agentType) | ✅ done (#252) |
| O2 | Claude Code worker (greenfield, Agent SDK) | ✅ done (#256 queue · #259 auth · #260 runner · #262 worker · #263 ops) |
| O3 | Board-driven dispatch | ✅ done — create/approve form (agent picker) + `/task` verb live on the board (#271) |
| O4 | Hermes enqueue + dispatch guardrail + autonomy mode | ✅ done — PR1 enqueue+guardrail (#280) · PR2 routing taxonomy (#281) · PR3a autonomy mode (#288) · PR3b autopilot auto-approval (#289); merge/deploy remain human-gated |
| O5 | Self-management hardening | 🟡 in build — first slice surfaces failed/stale agent tasks in `needs-attention` |
| A1 | Agent scorecard | ✅ done (#285) — read-only `/monitor/agents` + `averray_agent_scorecard` scorecard slice |
| A2 | Learned routing (data-driven, non-high-risk) | ✅ done (#287) — scorecard-backed default routing, high-risk rule-bound |
| A3 | Cost visibility / cost-aware routing | 🟡 split — A3a cost visibility ✅ (#295); A3b cost-aware routing/budget in progress |
| A4 | Agent model & effort policy — riskTier→effort/model + operator override (tester LLM; Hermes model = open) | ✅ done (#292) — riskTier→effort/model + operator override |
| D1 | "While you were away" digest (board + Slack/push) | ✅ done (#294) — autopilot/session digest + operator report surface |
| D2 | Explainability / decision records | ✅ done (#296) — dispatch decision records and replay surface |
| D3 | Anomaly auto-pause (tiered soft→hard) — owns the autopilot-suspended flag | ✅ done (#286) — anomaly auto-pause owns autopilot-suspended flag |
| D4 | Off-device alert bridge (Slack now → push later; action-needed 0→≥1; quiet-hours/mute) — **O4 prerequisite** | ✅ done (#279) |
| B1 | Backlog generation (roadmap auto-flow; net-new escalates) | 🟡 in review — first planner-only/read-only backlog suggestions slice |
| B2 | Self-healing (auto-fix non-high-risk; rollback human) | design done |
| C1 | Cross-agent review (default) | design done |
| C2 | Reviewer panel (high-risk) | design done |
| C3 | Specialist agents (test-writer/security/docs) | design done |
| C4 | Inter-agent chat | ✅ done (#291) — Claude author/target + card-scoped agent messages v1 |
| T1 | Surface sweep + truth-boundary honesty | ✅ done — executor #273; deploy-wire (platform #604) + runner #277; runs per-deploy (report-only) |
| T2 | Pre-seeded session (authed sweep) | ✅ done (#293) |
| T3 | Signer sidecar + SIWE mission (multi-role) | ✅ done — signer sidecar foundation (#283) + SIWE role-gating mission (#290) |
| T4 | Tier-2 agent (Agent SDK + Playwright-MCP) | design done |
| T5 | Env→mutation binding + enhancements (trace/video, baselines) | ✅ done (#297) — env-bound mutation profile + Playwright trace/video + baseline comparison slice |
| T6 | Agent-requested tester runs — board-gated (request → approve → read-only run) | design done (#274) |
| T7 | Tester capabilities manifest (+ platform-repo request helper) | design/follow-up — do not mark shipped here without code evidence; platform helper remains follow-up |

*(Status as of 2026-05-31 — **shipped:** O0–O4, A1, A2, A3a, A4, D1–D4, C4 v1, T1–T3, and T5. **In progress:** A3b cost-aware routing/budget and the O5 first slice. **Design / follow-up:** remaining O5 hardening, B1–B2, C1–C3 and remaining C follow-ups, T4, T6, T7, plus any platform helper pieces not proven by code evidence. Merge/deploy remain human-gated; autopilot approves dispatch only inside O4 guardrails.)*

## Recommended build order (the smooth, low-effort ramp)

1. **The self-feeding loop:** **O1 → O2 → O3.** Once this exists you stop hand-writing prompts; work is enqueued from the board and you just approve. Highest-leverage effort.
   - **T1** runs in parallel with O1 (independent, both runner/board TS).
2. **The safety net:** **D4** (off-device alert bridge), **T1**, **T2 + T3** (tester reaches authed product), **D1 + D3** (digest + anomaly auto-pause), and **T5** (env-bound mutation profile). This foundation has shipped; **T6/T7** remain follow-up for agent-requested runs + capabilities.
3. **Autonomy:** **O4** (enqueue + guardrail + autonomy mode) has shipped; supervised burn-in and monitoring decide when to rely on it more heavily.
4. **Depth, anytime after:** **A1 → A2** shipped; **A3b** is in progress. Remaining depth is **B** (planner), **C1–C3** plus C follow-ups, **T4/T6/T7**, and **O5** hardening.

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
