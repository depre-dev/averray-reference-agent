# Hermes Orchestration — Roadmap & Naming Index (canonical)

- **Status:** Planning index. This is the **single source of truth for work-item IDs and order.** It supersedes the old `P#` / `Phase #` labels.
- **Date:** 2026-05-29

> **Naming:** one prefix per stream, numbered within it. **`P#` and `Phase #` are retired** — they collided (`P2` Claude worker vs `Phase 2` A+D). Use the IDs below in all handoff prompts and discussion.

## Streams

| ID | Stream | Design doc |
|----|--------|-----------|
| **O** | Orchestration core | `HERMES_ORCHESTRATION_DESIGN.md` (+ `HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md`, `HERMES_INTEGRATION_MAP.md`) |
| **A** | Agent performance | `HERMES_PHASE2_DESIGN.md` *(file name historical)* |
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
| O4 | Hermes enqueue + dispatch guardrail + autonomy mode | 🟡 in build — PR1 enqueue+guardrail ✅ (#280) · PR2 routing taxonomy ✅ (#281) · PR3 autopilot auto-approval **blocked on D3** |
| O5 | Self-management hardening | design done |
| A1 | Agent scorecard | design done |
| A2 | Learned routing (data-driven, non-high-risk) | design done |
| A3 | Cost visibility / cost-aware routing | design done |
| D1 | "While you were away" digest (board + Slack/push) | design done |
| D2 | Explainability / decision records | design done |
| D3 | Anomaly auto-pause (tiered soft→hard) — owns the autopilot-suspended flag | 🟡 in build (prompt out — unblocks O4-PR3) |
| D4 | Off-device alert bridge (Slack now → push later; action-needed 0→≥1; quiet-hours/mute) — **O4 prerequisite** | ✅ done (#279) |
| B1 | Backlog generation (roadmap auto-flow; net-new escalates) | design done |
| B2 | Self-healing (auto-fix non-high-risk; rollback human) | design done |
| C1 | Cross-agent review (default) | design done |
| C2 | Reviewer panel (high-risk) | design done |
| C3 | Specialist agents (test-writer/security/docs) | design done |
| C4 | Inter-agent chat | design done |
| T1 | Surface sweep + truth-boundary honesty | ✅ done — executor #273; deploy-wire (platform #604) + runner #277; runs per-deploy (report-only) |
| T2 | Pre-seeded session (authed sweep) | design done |
| T3 | Signer sidecar + SIWE mission (multi-role) | in review — signer sidecar implementation |
| T4 | Tier-2 agent (Agent SDK + Playwright-MCP) | design done |
| T5 | Env→mutation binding + enhancements (trace/video, baselines) | design done |
| T6 | Agent-requested tester runs — board-gated (request → approve → read-only run) | design done (#274) |
| T7 | Tester capabilities manifest (+ platform-repo request helper) | design done (#274) |

*(Status as of 2026-05-29 — **shipped:** O0–O3 (operator-driven loop), T1 (per-deploy surface sweep), D4 (alert bridge), O4-PR1+PR2 (Hermes proposes smart risk-tagged work; supervised). **In build:** D3 (anomaly auto-pause — unblocks O4-PR3). **Design-only / remaining:** O4-PR3 (autopilot, gated on D3), O5, A1–A3, B1–B2, C1–C4, D1–D2, T2–T7. **Critical path to autopilot:** D3 → O4-PR3 → supervised burn-in → flip on. Everything else is depth/enhancement.)*

## Recommended build order (the smooth, low-effort ramp)

1. **The self-feeding loop:** **O1 → O2 → O3.** Once this exists you stop hand-writing prompts; work is enqueued from the board and you just approve. Highest-leverage effort.
   - **T1** runs in parallel with O1 (independent, both runner/board TS).
2. **The safety net:** **D4** (off-device alert bridge — build first; delivers "step away" now + the O4 prerequisite), **T1** (+ **T6/T7** agent-requested runs + capabilities), **T2 + T3** (tester reaches authed product), **D1 + D3** (digest + anomaly auto-pause). This is what makes autonomy safe to trust.
3. **Autonomy:** **O4** (enqueue + guardrail + autonomy mode) → set "Hermes in charge," read the digest. Lowest-effort end state.
4. **Depth, anytime after:** **A1 → A2** (performance/learned routing), **B** (planner), **C** (collaboration), **T4/T5** (agentic missions + enhancements), **O5** (hardening), **A3**.

**Dependencies to respect:** B2 needs D3 (loop fail-safe); A2 needs A1 (baselines); O4 is the authority change (ships only with its guardrail) **and needs D4** (escalations must reach the operator off-device); T6 needs the proposed-mission approval gate; T-missions that mutate stay on testnet (env→mutation binding before any mainnet).

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
