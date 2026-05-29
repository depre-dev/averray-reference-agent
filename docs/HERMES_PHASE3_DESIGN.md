# Hermes Orchestration — Phase 3 Design (Hermes as Planner)

- **Status:** Planning / handoff only. **Nothing here is implemented.** Design-level spec for the autonomy payoff layer.
- **Date:** 2026-05-29
- **Companions:** the core [`HERMES_ORCHESTRATION_DESIGN.md`](./HERMES_ORCHESTRATION_DESIGN.md) (P1–P5) and [`HERMES_PHASE2_DESIGN.md`](./HERMES_PHASE2_DESIGN.md) (themes A + D).
- **Position:** **Phase 3 (Theme B).** The leap from *Hermes routes work you define* → *Hermes decides what's next*. Builds on the core (P1–P4) **and** Phase 2 — it needs the scorecard (prioritization), D2 (explain why it proposed something), **D3 (the loop fail-safe)**, and D1 (report what it planned while you were away). Do not start before those exist.

> **The principle that makes it safe:** separate *deciding scope* from *executing sanctioned scope*. The roadmap (and you) sanction *what* gets built; autopilot may *execute* sanctioned work unattended, but *inventing new scope* always returns to you. This single line keeps an autonomous planner from becoming "agent builds whatever."

---

## B1 — Backlog generation  ·  **roadmap + discovery, net-new escalated** (decision #1)

Hermes reads the roadmap + board + issues + signals and proposes the next work items into the proposed/drafts lane — feeding the **same** dispatch pipeline as every other task (proposed → approved → routed → worker). It is a new *source* of proposals upstream of machinery that already exists.

- **Two sources, two trust levels:**
  - **Roadmap-sanctioned** — decompose/sequence items already on the roadmap. Scope is pre-blessed, so these may **auto-flow through autopilot** (subject to the risk-tier gate + guardrail).
  - **Discovery** — net-new items surfaced from code/issues/TODOs/test failures/testbed-mission findings. **Net-new scope ALWAYS escalates to the operator, even in autopilot.** Hermes can *suggest* new scope; only you (or the roadmap) sanction it.
- **Cadence (decision #2): idle-triggered + on-demand + daily brief.** When the board goes quiet under autopilot, Hermes proposes the next item (the self-feeding loop, so the pipeline never stalls); you can ask "what's next?" anytime; and a daily planning brief reuses the existing operator-report cron.
- **Volume:** a small **ranked shortlist** (top ~3) into the lane, never a flood. The dispatch guardrail's daily budget caps it.
- **Prioritization:** roadmap-priority × dependency-readiness (what's unblocked) × risk; the scorecard (A) informs "what can we ship fast / who's good at it."
- **Source roadmap:** the platform's `PROJECT_ROADMAP.md` (+ any reference-agent roadmap); each proposed task targets whichever repo it belongs to, bounded by the **dispatch allowlist** (which repos Hermes may propose for).

---

## B2 — Self-healing / incident response  ·  **auto-fix non-high-risk; rollback always human** (decision #3)

Failure signals already exist: post-deploy verification, ops-health, testbed missions, CI on main. On a trip, Hermes diagnoses and proposes a response.

- **Risk-tier gate (reused from the autonomy mode):**
  - **Non-high-risk failure** (e.g. a UI regression a testbed mission found) → Hermes may **auto-open + route a fix task** within the guardrail (and only once D3 is in place).
  - **High-risk failure** (deploy/settlement/contract/secrets/migration) → **escalate to the operator**.
  - **Rollback is always operator-confirmed**, in every mode — it's a production deploy mutation, and "deploy is always human" is a durable invariant.
- **Loop safety (hard dependency):** B2 ships **after D3 (anomaly auto-pause)**. Self-healing + autopilot without the loop fail-safe is exactly how you get a fix-fail-fix spiral; D3 catches repeated failures on the same surface and pauses.
- **Storm control:** dedup (one open fix task per failing surface) + a cooldown so a flapping check can't spawn a swarm; the guardrail budget is the backstop.

---

## Dependencies & sequencing

```
core P1–P4  ─┐
Phase 2 A    ─┤→  Phase 3 B
  scorecard  │     B1 backlog (roadmap auto-flow; discovery escalates)
Phase 2 D    ─┘     B2 self-healing  ← requires D3 (loop fail-safe)
  D1 digest, D2 explainability, D3 auto-pause
```

Build B1 before B2 (B1 is the core "what's next" loop; B2 adds incident response and has the D3 prerequisite). All of B sits after the core and Phase 2.

## Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| 1 | Backlog source | **Roadmap + discovery, net-new escalated** — roadmap-sanctioned work auto-flows; discovered net-new scope always needs operator approval |
| 2 | Planning cadence | **Idle-triggered + on-demand + daily brief** |
| 3 | Self-healing autonomy | **Auto-fix non-high-risk; high-risk + rollback always escalate to the operator** |

**Invariants carried through:** deciding new scope is never unattended; merge/deploy/rollback are always human; high-risk stays rule-bound; Hermes acts only within the dispatch guardrail + `HALT_FILE`; B2 ships only after D3.

---

*End of Phase 3 design. Planning/handoff only — not implemented.*
