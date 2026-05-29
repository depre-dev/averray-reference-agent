# Hermes Orchestration — Phase 2 Design (Intelligence + Trust)

- **Status:** Planning / handoff only. **Nothing here is implemented.** Design-level spec for the next layer after the core orchestration.
- **Date:** 2026-05-29
- **Companions:** [`HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md`](./HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md), [`HERMES_INTEGRATION_MAP.md`](./HERMES_INTEGRATION_MAP.md), [`HERMES_ORCHESTRATION_DESIGN.md`](./HERMES_ORCHESTRATION_DESIGN.md) (the core P1–P5).
- **Position:** **Phase 2.** Builds on the core — it consumes agent attribution (P1), dispatch + the autonomy mode (P3/P4), and the handoff-event log. Do not start until the core ships.
- **Themes:** **A — smarter routing & agent performance** (makes the "intelligent" real) and **D — operator trust & ergonomics** (makes autopilot safe to actually use). These are the *enablers* that make the deeper autonomy (Theme B) safe to attempt later.

> Decisions for Phase 2 are resolved (table at the end). Specs are design-level, not file:line — the code they sit on (P2–P4) isn't built yet. They anchor to data sources that **do** exist today: `handoff-events.jsonl`, the codex-task queue transitions, GitHub PR/check state, the operator-report mechanism, the Slack gateway, and `HALT_FILE`.

---

## The shared foundation: an observability spine

A and D read the same substrate, and the system already emits it. Build the aggregation **once**; both themes fan out from it.

- **Inputs (already logged):** `handoff-events.jsonl` (correlationId, phase, status), codex-task queue status transitions + timestamps + `attemptCount`, GitHub PR/check state (merged/closed, CI), and the Agent SDK's structured output (summary, files, **cost/tokens**).
- **The spine:** an aggregator that joins these by correlation id / task id into a queryable model: per-task lifecycle, per-agent rollups, per-autonomy-session windows, and a structured **decision record** per dispatch.
- **Surfaces:** a board data API (`/monitor/agents`, `/monitor/sessions/:id`) + an `averray_agent_scorecard` MCP tool so Hermes can read its own track record.

**Read vs. act — the safety axis.** A1, D1, D2 only *aggregate + display* (low-risk, high-trust-value). A2 and D3 *act* on the data (route, pause) and need care. So the order is **foundation → read/trust layer → acting layer.**

```
            ┌──────────────── observability spine ────────────────┐
            │  joins handoff-events + task queue + GitHub + SDK     │
            └───────────────┬───────────────────────┬──────────────┘
        read/trust layer    │                       │
          A1 scorecard      D1 away-digest      D2 explainability
                            │                       │
        acting layer        ▼                       ▼
          A2 learned routing                  D3 anomaly auto-pause
```

---

## Theme A — smarter routing & agent performance

### A1 — Agent scorecard  ·  read · risk: low
Per-agent, per-surface metrics from the spine:
- **Quality:** merge rate (merged/opened), rework rate, revert rate, CI-first-pass rate, Hermes-verdict mix (PASS/HUMAN REVIEW/BLOCK).
- **Routing signal:** operator-override rate (how often you flip Hermes's suggested agent or reject a dispatch).
- **Speed:** time-to-PR, time-to-merge, time-in-lane.
- **Cost:** $/task, tokens/task (from the SDK).
- **The trust metric:** autopilot auto-approvals that *later needed human rework* — the direct measure of whether autopilot's judgment holds up.

Surface: a board panel + `averray_agent_scorecard` MCP tool. **This is the first Phase-2 build** (decision #1) — the spine + its first visible payoff together.

### A2 — Learned routing  ·  acts · risk: medium · **data-driven within non-high-risk** (decision #2)
Stats fully drive routing for non-high-risk surfaces — with safeguards so "data-driven" doesn't become brittle or self-entrenching:
- **High-risk stays rule-bound.** Contracts, chain/settlement, secrets, migrations, deploy/ops → always Codex, regardless of stats. Stats never touch the dangerous surfaces.
- **Score** per (agent, surface) from merge rate − rework/revert − operator-override, **recency-decayed** (recent performance weighted; a past slump fades).
- **Cold start:** below a minimum sample count for a (agent, surface), fall back to the static taxonomy — never route on noise.
- **Anti-entrenchment:** decay + a small **exploration rate** (occasionally route to the non-top agent) so a recovering/new agent isn't permanently locked out and the data stays fresh.
- **Human override always wins** and feeds back as signal (a route you keep overriding loses score).
- **Always explained:** every routing decision carries its rationale ("Claude — 92% merge on UI vs Codex 70%"), recorded in D2 and shown in the rail.
- Coheres with autopilot: autopilot only auto-approves non-high-risk anyway, so data-driven routing of non-high-risk and autopilot auto-approval line up cleanly.

### A3 — Cost  ·  later
Visibility first (cost is on the scorecard from A1). Cost-as-a-routing-factor and a $-based dispatch budget come once throughput data is meaningful — don't optimize cost before you can measure value.

---

## Theme D — operator trust & ergonomics

### D1 — "While you were away" digest  ·  read · risk: low · **board + Slack/push** (decision #4)
When autopilot ends (timer/safety-cap expiry or you return), aggregate that session window into a report: tasks routed, **auto-approved** (with risk tier + why), **escalated** (waiting on you), PRs opened, merges parked at the human gate, anything that failed.
- **Delivery:** board panel **+ push to Slack/the messaging gateway** (`SLACK_WEBHOOK_URL` already wired) — you were away from the board by definition, so push is how you actually see it.
- **Reuse:** the existing operator-report shape (it already produces "daily operator brief"); the digest is the same machinery scoped to one autopilot session.

### D2 — Explainability / audit replay  ·  read · risk: low
Every dispatch logs a structured **decision record**: `{ taskId, routedTo, reason, riskTier, mode, guardrailCheck (allowlist + budget remaining), approvedBy }`. A board view reconstructs "why did Hermes route/approve/escalate X" by correlation id — reusing the existing correlation-id discipline. Governance + debugging + the backbone of trust.

### D3 — Anomaly auto-pause  ·  acts · risk: medium · **tiered: soft then hard** (decision #3)
Watch the task/event stream against configurable thresholds:
- **Signals:** task loop (same task failing+retrying ≥N), budget spike (tokens/$ above baseline), oversized diff for a "small" task, repeated CI failures, heartbeat gaps.
- **Soft trip (medium):** drop autopilot → supervised + alert. In-flight work finishes; **no new auto-approvals.**
- **Hard trip (severe — budget blowout, multi-task runaway, destructive diff):** touch `HALT_FILE` — everything mutating stops immediately.
- Every trip writes a decision/anomaly record (D2) and pushes an alert (D1 channel). Thresholds live in config alongside the dispatch guardrail.
This is the fail-safe that makes handing over the wheel sane: you hand off knowing it stops itself if something's wrong.

---

## Build order (Phase 2)

1. **Spine + A1 scorecard** — the foundation and its first visible payoff. *(decision #1)*
2. **D1 away-digest + D2 explainability** — the read/trust layer (low-risk, high trust value).
3. **A2 learned routing + D3 anomaly auto-pause** — the acting layer (needs the spine + scorecard baselines + decision records beneath it).
4. **A3 cost-routing**, and **D4 multi-repo / multi-operator / mobile** — optimizations and product-scope, a separate track from the trust mechanism.

All sits *after* the core P1–P4. Each ships as a narrow PR per [AGENTS.md](../AGENTS.md), typecheck + tests green, PR template completed.

## Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| 1 | First Phase-2 build | **Observability spine + the scorecard (A1)** |
| 2 | Learned-routing aggressiveness | **Data-driven within non-high-risk** (high-risk rule-bound; + cold-start, decay, anti-entrenchment, always-explain safeguards) |
| 3 | Anomaly auto-pause action | **Tiered** — soft (drop to supervised) for medium, hard (`HALT_FILE`) for severe |
| 4 | Digest delivery | **Board + Slack/push** |

**Invariants carried from the core:** high-risk surfaces stay rule-bound to Codex; merge/deploy is always human; Hermes acts only within the dispatch guardrail + `HALT_FILE`; nothing here makes the board look more autonomous/live than it is.

---

*End of Phase 2 design. Planning/handoff only — not implemented.*
