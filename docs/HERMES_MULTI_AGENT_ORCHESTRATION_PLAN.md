# Hermes Multi-Agent Orchestration — Feasibility Plan & Handoff

- **Status:** Feasibility / planning only. **Nothing here is approved implementation.** No code in this plan has been written or merged. It exists to be handed off to another agent for refinement and execution planning.
- **Date:** 2026-05-29
- **Author:** Claude (feasibility study session)

> ## Repo orientation (read first)
> **This is the implementation repo.** You are in `depre-dev/averray-reference-agent` — the Hermes deployment that runs on the VPS (the agent runtime, the MCP servers, the monitor backend, the worker runners). **Build the orchestration work here.**
>
> The **platform repo** is the *sibling* `averray-agent/agent` — the Averray product (operator app, contracts, indexer, SDK) plus the GitHub workflows that SSH into this deployment to invoke Hermes. Throughout this doc, files tagged `[platform]` live in that repo; unprefixed source paths are **local to this repo**. You generally do **not** edit the platform repo for this effort.

- **Scope of evidence:** Sections marked **[verified]** were read directly from source — `[platform]` items from `averray-agent/agent`, local items from this repo. Sections marked **[assumed]** were confirmed in **Phase 0 (now complete)** — see the companion [`docs/HERMES_INTEGRATION_MAP.md`](./HERMES_INTEGRATION_MAP.md), which supersedes the assumptions with source-cited findings.

---

## 0. One-paragraph summary

We already run a multi-agent system without calling it one: **Codex** and **Claude** build code in their own git worktrees and open PRs; **Hermes** (this deployment) reviews PRs and reports; a **human operator** approves merges and deploys; and a live **kanban monitor** ("Hermes Handoff Monitor") makes it all legible. The goal is to evolve this from *Hermes-reviews-after-the-fact* into *Hermes-orchestrates*: an intelligent, partly self-managing workflow where Hermes decides what work is needed, routes each task to the best worker agent (Codex or Claude), tracks it, reviews it, and escalates to the human only at the merge/deploy gate — all visible and controllable from the monitor board.

---

## 1. What we want to achieve (goals)

### North star
An **intelligent, self-managing multi-agent workflow** with:
- **Hermes as orchestrator** — plans/triages work, routes tasks to agents, narrates decisions, learns which agent is good at what.
- **Codex and Claude Code as worker agents** — headless builders that take a task, work in an isolated worktree, and open a PR.
- **The monitor board as the control plane** — every task and PR visible by agent, with the operator able to create/approve/redirect work and Hermes narrating live.
- **The human in the loop only where it matters** — merge and deploy stay human-gated; everything up to the gate can run autonomously.

### Three rungs (the path, not three separate products)
| Rung | What Hermes does | State |
|---|---|---|
| **A — Reviewer/Reporter** | Reviews PRs post-CI, verifies deploys, files scheduled reports. Recommendation-only. | **This is today.** |
| **B — Dispatcher** | Work is enqueued (by operator or Hermes); Codex/Claude runners claim and execute it; PRs flow back through review. | **Primary near-term target.** |
| **C — Self-managing planner** | Hermes reads the board + roadmap, decides what's needed, routes each task to the best agent, tracks heartbeats, narrates, escalates only at gates. Improves routing over time via skills + memory. | **End state.** |

---

## 2. Current state (verified topology)

```
        CODE AGENTS                  OPERATOR AGENT              HUMAN
   ┌──────────────────┐           ┌─────────────────┐      ┌──────────┐
   │ Codex   (codex/*) │  opens   │     Hermes      │      │ Operator │
   │ Claude  (claude/*)│  ──PR──▶  │  (this repo)    │      │  (you)   │
   └──────────────────┘           └─────────────────┘      └──────────┘
        build code                  reviews + reports        approves
     in git worktrees              (recommendation-only)    merge/deploy
            │                              ▲                      ▲
            └──── CI is the merge gate ────┘                      │
                          │                                       │
                  Hermes Monitor (kanban board) ──── you watch & command ───┘
```

**[verified] — read in the platform repo (`averray-agent/agent`):**
- **Two code agents are first-class.** `scripts/ops/start-agent-worktree.sh` routes `codex/<task>` → `.codex/worktrees/` and `claude/<task>` → `.claude/worktrees/`. `AGENTS.md` treats them as peers: one branch per task, narrow PRs, never push to `main`, CI is the merge gate.
- **Hermes is invoked over SSH:** the platform's `.github/workflows/hermes-pr-handoff.yml` runs `ssh … docker compose … exec -T hermes hermes chat --provider ollama-cloud -m deepseek-v4-pro:cloud -q "$PROMPT"`. The prompt always says *"Use Averray MCP tools only."*
- **Three Hermes routines, all recommendation/evidence-only (Hermes never merges or mutates GitHub):**
  1. **PR handoff** (post-CI) → `averray_invoke_agent_task(intent='pr_handoff', TBE2E-004)`.
  2. **Post-deploy verification** → `intent='testbed_suite'` (in the platform's `.github/workflows/deploy-production.yml`).
  3. **Scheduled operator self-reports** → daily 07:17 UTC → `averray_handle_operator_command('ops health' | 'daily operator brief')` (platform's `.github/workflows/hermes-operator-report.yml`).
- **The integration bus is MCP.** Two tool families: `averray_invoke_agent_task` and `averray_handle_operator_command` (both served by this repo's `packages/averray-mcp`).

**[verified from the live monitor screenshot]:**
- The monitor is **live and running** (not just a spec). 8-lane pipeline: `needs-attention → drafts → codex-needed → hermes-checking → operator-review → release-queue → deploying → done`. KPI strip, LIVE clock, calm/empty "Board Now" state, a persistent **Hermes co-pilot rail** with `/mission <url>` and `/mute 1h` slash commands.
- **Today, work enters at "Operator review"** (Hermes already ran its check; cards show `WAITING ON → OPERATOR`, 9/9 checks) and exits via **Deploying → Done**. The left half of the pipeline (drafts, codex-needed, hermes-checking) is **empty**.
- **Every card is `agentType: ext`** — generic external PR. The data model supports `claude | codex | hermes | ext`, but in production no card is attributed to a specific agent.
- The **Codex-needed lane** exists with the subtitle `CREATE / APPROVE TASK` but is **dormant** (no orchestrator enqueues work). The co-pilot exposes `/mission` and `/mute`, but no dispatch verb, and narrates nothing yet ("No board chatter yet").

### The two gaps that separate "today" from the goal
1. **Attribution gap** — the board can't see *which* agent did what; everything is `ext`.
2. **Dispatch gap** — the lanes/UI for assigning work to agents exist but nothing drives them.

---

## 3. What the Hermes framework already gives us (no build needed)

**[assumed — from `nousresearch/hermes-agent` README]** — versions/availability to confirm against the running image:
- **Agent loop + tool calling** (already wired to Averray MCP).
- **Subagent spawning** — Hermes can fan out its own isolated subagents.
- **Cron scheduler** — already used for the daily reports.
- **Skills framework** (agentskills.io) — Hermes can create/improve reusable procedures. This is the hook for a learnable routing playbook.
- **Memory layer** (SQLite FTS5 + summarization + user profile) — persistent routing decisions and per-agent performance history.
- **MCP client + multiple terminal backends** (local, Docker, SSH, Modal, Daytona) — the mechanism by which Hermes could launch worker runs.
- **Messaging gateways** (Slack, Telegram, …) — operator approvals from anywhere.

**Implication:** Hermes already has the *capability* to orchestrate. The work is wiring behaviors, not adding engine features.

---

## 4. Target architecture (Rung C)

```
   ┌──────────────────────────── Hermes (orchestrator) ───────────────────────────┐
   │  reads: board state + roadmap + memory                                        │
   │  decides: what work is needed                                                 │
   │  routes:  task → best agent (taxonomy + learned performance)                  │
   │  narrates: decision in the co-pilot rail                                      │
   └───────────────┬───────────────────────────────────────────┬──────────────────┘
                   │ enqueue task (policy-gated)                 │ review verdict
                   ▼                                             ▲
            ┌──────────────┐        claim & run        ┌──────────────────┐
            │  Task queue  │ ───────────────────────▶  │  PR handoff      │
            └──────────────┘                           │  (existing)      │
              │          │                             └──────────────────┘
     ┌────────▼───┐  ┌───▼─────────┐                            ▲
     │codex-runner│  │claude-runner│  headless build in worktree │
     │ codex/*    │  │ claude/*    │ ───────── opens PR ─────────┘
     └────────────┘  └─────────────┘
                   │
                   ▼
        Monitor board (control plane) — operator creates/approves/redirects;
        every card attributed to its agent; human owns merge/deploy gate.
```

---

## 5. Workstreams / phases

> **Repo legend:** `[ref-agent]` = work lands **here** (`depre-dev/averray-reference-agent`, this repo). `[platform]` = work lands in the sibling `averray-agent/agent`. **Almost everything is `[ref-agent]`;** the platform repo changes only if new MCP intents/tools or workflow hooks must surface there.

| Phase | Goal | Repo | Depends on | Rough effort | Acceptance |
|---|---|---|---|---|---|
| **P0 — Discovery** | Confirm the [assumed] internals so later phases are exact, not approximate. | both (read-only) | — | 0.5–1 day | **DONE** — see [`docs/HERMES_INTEGRATION_MAP.md`](./HERMES_INTEGRATION_MAP.md). |
| **P1 — Agent attribution** | Board derives `agentType` from PR head-branch prefix (`codex/*`→codex, `claude/*`→claude, else ext/human). Board stops showing everything as `ext`. | `[ref-agent]` | P0 | ~0.5 day | Live board shows correct per-agent attribution on existing PRs. |
| **P2 — Claude Code worker runner** | A `claude-branch-worker` mirroring the Codex one, riding the existing command-agnostic runner: claim task → worktree → run `claude -p "<prompt>"` (or Agent SDK) headless → open PR → heartbeat. | `[ref-agent]` | P0 | 2–4 days | A queued Claude task produces a PR that flows into Operator review via existing handoff, unchanged. |
| **P3 — Board-driven dispatch** | Light up the `codex-needed` lane (`CREATE / APPROVE TASK`) for both agents + a co-pilot `/task` verb. Operator (and later Hermes) enqueues; runners claim. | `[ref-agent]` | P1, P2 | 2–3 days | Operator creates a task from the board → it appears in `codex-needed` → runner picks it up → PR appears attributed to the agent. |
| **P4 — Hermes as router (Rung C core)** | A Hermes skill that reads board + roadmap, decides what's needed, routes by task taxonomy (Codex owns chain/settlement; Claude takes UI/docs), enqueues (policy-gated), and **narrates the decision** in the rail. | `[ref-agent]` / Hermes skills | P3 | 3–6 days | Given a backlog, Hermes proposes + routes ≥1 task end-to-end and narrates why; operator can veto from the board. |
| **P5 — Self-management hardening** | Heartbeats, stale-task detection, retries, escalation rules, **a dispatch guardrail** (see map Q4), per-agent performance memory, observability. | `[ref-agent]` | P4 | ongoing | Stuck/failed tasks surface in `needs-attention`; dispatch respects policy budgets; routing improves with logged performance. |

### Sequencing rationale
- **P1 first** because it's the smallest change, the highest signal, and a prerequisite for any routing intelligence (you can't route by agent if you can't attribute by agent).
- **P2 before P3** because dispatch needs at least one new runner to dispatch *to*; the Codex worker already exists, so Claude is the missing one.
- **P4/P5 are mostly prompt/skill/policy work**, not plumbing — they sit on top of P1–P3.

---

## 6. Phase 0 questions — now answered

These six were the load-bearing unknowns. They are **answered with source citations in [`docs/HERMES_INTEGRATION_MAP.md`](./HERMES_INTEGRATION_MAP.md)**:

1. Board aggregator — agentType logic (why all `ext`).
2. Codex task queue + runner — schema, storage, lifecycle, executor.
3. Claude agentType handling — recognized vs executed.
4. Policy / mutation guardrails — what they cover (and that they do **not** cover dispatch).
5. MCP tool surface + `invoke_agent_task` intents (no enqueue intent exists).
6. Monitor deployment (served by `slack-operator`; optional Hermes gateway API on `:8642`).

See the map's "Net effect on the plan" table for the refinements each answer implies for P1–P4.

---

## 7. Constraints & invariants (must not break)

- **Human owns the merge/deploy gate.** Platform `AGENTS.md`: no direct pushes to `main`, deploys serialized, CI is the merge gate. "Self-managing" means *self-managing up to the gate* — **no auto-merge**, at least until explicitly revisited.
- **Authority change is the real risk.** Today Hermes is recommendation-only and never mutates GitHub. Giving it a *dispatch* (enqueue) capability must go through a **new** dispatch guardrail (the existing marketplace mutation policy does not cover this — see map Q4) — never free-form prompt authority.
- **Two-repo split.** Worker/runner/monitor/orchestration work lands **here** (`averray-reference-agent`). The platform repo changes only for new MCP intents/tools or workflow hooks.
- **Codex owns chain/settlement.** Per existing coordination rules, routing logic (P4) must keep chain/settlement tasks with Codex; Claude takes UI/docs/etc.
- **Truth-boundary discipline.** The board must keep its honest real/degraded/empty signaling (KPIs show `?` not `0` when a source is down). Don't make orchestration look more autonomous/live than it is.
- **Narrow PRs, one branch per task** — every phase ships as small, independently reviewable PRs.

---

## 8. Immediate next steps (for the handoff agent)

Phase 0 is done. Next is execution-level design (still planning), or starting P1.

1. **Read [`docs/HERMES_INTEGRATION_MAP.md`](./HERMES_INTEGRATION_MAP.md)** — it has the confirmed source map and the refinements per phase.
2. **Write the P1 design** (thread `headBranch` into the slim board model → prefer branch prefix in `inferAgentType`), then either spike it or implement it as one narrow PR.
3. **Write the P2 runner design** (Claude headless: `claude -p` vs Agent SDK; auth; sandboxing; worktree lifecycle; generalize the queue with an `agent` field).
4. **Design the dispatch authority model + guardrail** for P3/P4 with the operator: what Hermes may enqueue autonomously vs. what needs operator approval in the `codex-needed` lane.
5. **Bring the result back to the operator** to choose how far to push toward Rung C and on what timeline.

---

## 9. Key references

**This repo (`depre-dev/averray-reference-agent`) — source:**
- `packages/averray-mcp/` — the MCP server Hermes calls (`index.ts`, `agent-invocation.ts`, `mutation-policy.ts`, `operator-commands.ts`).
- `services/slack-operator/` — the live `/monitor` board + Codex task queue/runner (`monitor-v2.ts`, `codex-task-queue.ts`, `codex-task-runner.ts`, `codex-branch-worker.ts`).
- `packages/monitor-ui/` — the board SPA (`card-types.ts`, `lane-rules.ts`, `MonitorPage.tsx`).
- `hermes/config/` — `hermes.yaml`, `policy.yaml`.
- `docs/HERMES_MONITOR_REDESIGN_SPEC.md` — the monitor board redesign spec.
- [`docs/HERMES_INTEGRATION_MAP.md`](./HERMES_INTEGRATION_MAP.md) — the Phase 0 confirmed map.

**Platform repo (`averray-agent/agent`) — [verified]:**
- `AGENTS.md` — multi-agent coordination rules.
- `scripts/ops/start-agent-worktree.sh` — `codex/*` / `claude/*` worktree convention.
- `.github/workflows/hermes-pr-handoff.yml`, `hermes-operator-report.yml`, `deploy-production.yml` — how Hermes is invoked.
- `docs/HERMES_OPERATOR_REPORTS.md` — the Hermes routines + evidence/correlation-id model.
- `docs/PROJECT_ROADMAP.md` — canonical roadmap (Hermes would read this in Rung C).

**External:**
- `github.com/nousresearch/hermes-agent` — the Hermes framework (agent loop, subagents, cron, skills, memory, MCP).

---

*End of plan. Feasibility/planning only — not approved implementation.*
