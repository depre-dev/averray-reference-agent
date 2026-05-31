# Hermes Orchestration — Execution Design (per-phase build specs)

- **Status:** Reconciled 2026-05-31. This is the historical execution spec for O1-O5; O1-O4 have shipped, including O4 autonomy mode (#288) and autopilot auto-approval (#289). O5 self-management hardening remains follow-up.
- **Date:** 2026-05-29
- **Companions:** [`HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md`](./HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md) (the why + phases), [`HERMES_INTEGRATION_MAP.md`](./HERMES_INTEGRATION_MAP.md) (the confirmed source map).
- **Decisions:** all nine open decisions are **resolved** (see the table at the end). They're baked into the specs below. `path:line` references are local to this repo; code blocks are illustrative sketches, not applied diffs.

> Build order: **P1 → P2 → P3 → P4 (enqueue + guardrail + autonomy mode) → P5.** P1 is unblocked. Every phase is one narrow PR per [AGENTS.md](../AGENTS.md), `npm run typecheck` + `npm test` green, PR template completed (incl. the durable-invariant checks).

---

## P1 — Agent attribution  ·  ready to build · risk: low

**Goal:** the board stops labelling every card `ext`. Attribute each card to the agent that opened the PR via the branch convention (`codex/*`, `claude/*`).

**Why first:** smallest change, highest signal, prerequisite for routing. Pure read-path enrichment — no lane logic, no mutation. (Bonus: greenfield Claude PRs from P2 land on `claude/*` branches, so they attribute automatically.)

**Confirmed data flow:**
```
raw monitor snapshot
  → boardCardFromItem()   services/slack-operator/src/monitor-hermes-board.ts:42  (builds slim card, drops branch today)
  → toBoardCard()         services/slack-operator/src/monitor-v2.ts:313
      → inferAgentType()   monitor-v2.ts:225  ← uses `owner`, defaults "ext"
```
The branch is available upstream (`packages/averray-mcp/src/operator-github.ts:1432`; `services/slack-operator/src/github-pr-state.ts:180,280`) but dropped from the slim card (`monitor-v2.ts:338` — `// branch not in slim model`).

**Change set (3 files):**
1. **`monitor-hermes-voice.ts`** — add `headBranch?: string` to `HermesBoardCardSnapshot` (after `correlationId?`).
2. **`monitor-hermes-board.ts`** — in `boardCardFromItem` (≈:57) resolve+forward the branch via a `headBranchForPr(prState, summary, item)` helper (tolerates flat `headBranch` or nested `head.ref` across `currentPullRequest`/`pullRequest`/`item.pullRequest`); add `...(headBranch ? { headBranch } : {})` to the returned card.
3. **`monitor-v2.ts`** — `inferAgentType` prefers the branch prefix, then falls back to the owner logic; add exported `agentTypeFromBranch(headBranch)`; set `card.branch = item.headBranch` in `toBoardCard`:
   ```ts
   export function inferAgentType(item, type): AgentType {
     if (type === "mission") return "hermes";
     const fromBranch = agentTypeFromBranch(item.headBranch);
     if (fromBranch) return fromBranch;
     const owner = (item.owner ?? "").toLowerCase();
     if (owner.includes("codex")) return "codex";
     if (owner.includes("hermes")) return "hermes";
     if (owner.includes("claude")) return "claude";
     return "ext";
   }
   export function agentTypeFromBranch(headBranch?: string): AgentType | undefined {
     const b = (headBranch ?? "").trim().toLowerCase();
     if (b.startsWith("codex/"))  return "codex";
     if (b.startsWith("claude/")) return "claude";
     return undefined;
   }
   ```

**Tests** (`test/unit/monitor-v2.test.ts` via the `slim()` helper; `monitor-hermes-board.test.ts` for forwarding): branch wins over conflicting owner; `codex/*`/`claude/*` (case-insensitive); non-agent branch falls back to owner; mission stays hermes; `toBoardCard` sets branch+agentType; board forwards `headBranch` from `currentPullRequest.headBranch` and from `head.ref`.

**Acceptance:** live board attributes `codex/*` and `claude/*` PRs; non-prefixed PRs stay `ext`; typecheck + tests green.

---

## P2 — Claude Code worker (greenfield, Agent SDK)  ·  risk: medium-high

**Decisions baked in:** greenfield from the start (#1); **Claude Agent SDK** (#2); per-agent runner (#3).

**Goal:** Hermes/operator can hand Claude a task with no pre-existing PR; Claude creates its own branch, does the work, and opens a PR — which then flows through the existing Hermes handoff.

**Reuse surface:** `codex-task-queue.ts` (JSON queue, `proposed→approved→running→completed/failed/cancelled`), `codex-task-runner.ts` (command-agnostic poll/claim/heartbeat; 10s poll, 30m timeout, secret-sanitized output), `codex-branch-worker.ts` (protected-branch guard, push).

**Design:**
- **Queue generalization:** add `agent: "codex" | "claude"` (default `"codex"`), and **make `pullRequestNumber` optional** so a task can be greenfield (no PR yet). Add an `agent` filter to `claimNextApprovedCodexTask`.
- **Greenfield Claude worker** (`claude-branch-worker.ts`): creates a `claude/<task-slug>` branch from fresh `origin/main`, runs the task, commits, **opens a PR** (title/body from the task), pushes. Reuses the protected-branch guard + secret sanitization. (PR-centric tasks — a `pullRequestNumber` present — check out that branch instead, so both modes coexist.)
- **Agent SDK invocation:** run Claude via the Agent SDK, not the bare CLI — set a restricted **permission mode + allowed-tools** (edit/git within the worktree, no destructive ops), capture **structured output** (summary, files touched, PR url) and **stream progress** to the monitor (`updateCodexTaskProgress` equivalent). `ANTHROPIC_API_KEY` is a managed secret (never logged).
- **Per-agent runner:** a `claude-task-runner` process mirroring the Codex runner (own heartbeat id, own `CLAUDE_TASK_RUNNER_*` env), added as an `ops/` compose service.

**Tests:** queue `agent` default + optional PR + claim filter; greenfield worker creates/pushes a `claude/*` branch and refuses protected branches; runner claims only `claude` tasks; structured-output parsing.

**Acceptance:** an approved greenfield `claude` task → worker opens a `claude/<task>` PR → it appears on the board attributed to `claude` (via P1) → flows into Operator review via the existing handoff, unchanged.

**Security (load-bearing):** this is an unattended coding agent with branch-create + push rights. It must run with the SDK permission mode scoped to its worktree, reuse the protected-branch guard + secret sanitization, hold `ANTHROPIC_API_KEY` as a managed secret, and — crucially — **only ever run tasks at `status:"approved"`** (who approves is the P4 autonomy-mode decision; the worker itself never self-approves).

---

## P3 — Board-driven dispatch  ·  risk: low–medium

**Decision baked in:** both surfaces (#4).

**Goal:** make the dormant `codex-needed` lane (`CREATE / APPROVE TASK`) work for both agents.

**Confirmed surface:** enqueue = `POST /monitor/codex-tasks` (`services/slack-operator/src/index.ts:389` → `proposeCodexTask` :1107); approve = `approveCodexTask(id, { approvedBy:"operator" })` (:1132).

**Design:**
- Extend the create-task endpoint + board form to accept `agent` (`codex|claude`) and optional `repo#pr` (omitted ⇒ greenfield).
- Add a co-pilot **`/task <agent> [<repo>#<pr>] <prompt>`** slash verb (mirror the `/mission` parser) — this is also where Hermes's *proposed* tasks surface.
- Render the agent on the task card (depends on P1).
- **Keep the human approve step** in supervised mode (`proposed → approved` by operator). Autopilot auto-approval is P4.

**Acceptance:** operator creates a `claude` task from the board (or `/task`) → lands in `codex-needed` → Claude runner claims after approval → PR attributed to `claude`.

---

## P4 — Hermes enqueue + dispatch guardrail + autonomy mode  ·  the authority change · risk: HIGH

**Decisions baked in:** `enqueue_agent_task` MCP intent (#5); guardrail config in `policy.yaml` + `dispatch-policy.ts` (#6); surface+risk routing taxonomy + autonomy mode (#7); autopilot ends on stated-time-else-safety-cap; high-risk surfaces always escalate.

This phase has four parts; **none of it ships without all of them.**

### (A) Enqueue capability — proposes-only
Add `enqueue_agent_task` to `AgentInvocationIntent` (`packages/averray-mcp/src/agent-invocation.ts:24`), wired to `proposeCodexTask`. It writes **`status:"proposed"` only — never `approved`** — and records a handoff event (reuses Hermes's existing audit trail). Approval is governed by the autonomy mode (D), never by this intent.

### (B) Dispatch guardrail — NEW, do not reuse `mutation-policy.ts`
A `dispatch:` block in `hermes/config/policy.yaml` + a `dispatch-policy.ts` mirroring `mutation-policy.ts`:
- **Allowlist** — repos + task kinds Hermes may propose.
- **Budget** — max proposed/auto-approved tasks per day (and per repo).
- **Honors `HALT_FILE`** (the global kill switch).
- **Human-approval invariant** — Hermes proposes; only the operator or autopilot-within-rules approves; **merge/deploy stays human, always.**

### (C) Routing taxonomy — surface + risk
The function Hermes uses to suggest (supervised) and route (autopilot):
- **Codex surfaces:** contracts, chain/settlement, indexer, XCM, treasury/policy, payments, DB migrations, deploy/ops, secrets/config. *(High-risk, correctness-critical, hard to reverse.)*
- **Claude surfaces:** UI/frontend, the monitor itself, docs/copy, tests, refactors, DX, non-financial backend, MCP tool ergonomics. *(Breadth + readability.)*
- **Ambiguous/general** (small bugfixes, cross-cutting): Hermes picks by recent success / load.
- **Risk tiers** (drive autopilot escalation in (D)): **high-risk** = contracts, chain/settlement, secrets, DB migrations, deploy/ops; **low/medium** = everything else. These mirror the surfaces the existing PR handoff already flags as risky.
- *Emergent property:* high-risk surfaces are mostly Codex's, so autopilot naturally auto-approves Claude's lower-risk work and escalates the dangerous work. Routing is a **default the operator can override** at approval; it sharpens via learned per-agent success in P5.

### (D) Autonomy mode — the master control
Server-side state (stored on the shared data volume, audited):
```ts
type AutonomyMode = "supervised" | "autopilot";
interface AutonomyState {
  mode: AutonomyMode;     // default "supervised"
  until?: string;         // ISO; autopilot reverts at/after this
  setBy: string; setAt: string; reason?: string;
}
```
- **Set autopilot** via a board switch *or* a co-pilot NL command ("Hermes, you're in charge until 5pm" / "for 2 hours" / open-ended). Parse → `mode:"autopilot"`, `until` = stated time, **else `now + 4h` safety cap** (default; tunable). A forgotten autopilot can't run forever.
- **Revert** via switch, an "I'm back" command, or `until` expiry (evaluated lazily on each dispatch decision + a periodic check).
- **Auto-approval logic** when a task `T` is proposed (after routing):
  ```
  record proposed (always)
  if mode == autopilot AND now < until
     AND dispatchPolicy.allows(T)         // allowlist + daily budget + !HALT_FILE
     AND riskTier(T) != "high":           // high-risk ALWAYS escalates to operator
        approve(T, approvedBy: "hermes-autopilot")
  else:
        leave proposed for the operator
  ```
- **Invariant unchanged:** autopilot only changes *who starts work*. Work still parks at `operator-review`/`release-queue`; **merge/deploy is always human.** Every mode change and every `hermes-autopilot` approval is a logged event.

**Tests:** dispatch-policy unit (allowlist/budget/halt); `enqueue_agent_task` proposes-only (never approves); routing taxonomy mapping; risk-tier classification; autonomy auto-approval matrix (supervised → never auto; autopilot + low-risk + within budget → auto; autopilot + high-risk → escalate; autopilot + expired `until` → escalate; HALT present → escalate); NL parse of "until 5pm" / "for 2h" / open-ended → 4h cap.

**Acceptance:** in supervised, Hermes proposes correctly-routed tasks and you approve. In autopilot ("you're in charge til 4pm"), Hermes auto-approves low/medium-risk dispatch within budget, escalates high-risk, narrates each decision in the rail, and reverts at 4pm (or your default cap). Merge/deploy never auto-fires.

**Risk: HIGH** — this is the authority change and the autonomy surface. Treat as security-reviewed work; ships only with (A)+(B)+(C)+(D) together.

Implementation note: O4 shipped across #280, #281, #288, and #289. Merge/deploy remain human-gated.

---

## P5 — Self-management hardening  ·  ongoing

- Heartbeat-staleness → surface stuck/stale tasks in `needs-attention`; retries via `attemptCount`; escalation when a task fails repeatedly.
- **Learned routing:** per-agent success memory (Hermes memory) feeds the taxonomy so routing improves over time (the "intelligent" half of Rung C).
- Observability: a handoff event per dispatch + per autonomy-mode change; autopilot session summaries ("Hermes was in charge 14:00–17:00: 3 tasks routed, 2 auto-approved, 1 escalated"). No silent caps — log anything the budget drops.

---

## Cross-cutting rules (every phase)

- One narrow PR; branch `codex/<task>` or `claude/<task>`; `npm run typecheck` + `npm test` green; complete the PR template incl. durable-invariant checks.
- **Update [AGENTS.md](../AGENTS.md) in the same PR** when a phase changes how agents work (P2 adds a worker; P4 changes Hermes's powers + adds autonomy mode). Durable invariant.
- Preserve the board's honest real/degraded/empty signaling.

## Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| 1 | Claude worker: PR-centric vs greenfield | **Greenfield from the start** (PR-centric tasks still supported when a PR is given) |
| 2 | Claude invocation | **Claude Agent SDK** (scoped permissions, structured output, streamed progress) |
| 3 | Runner topology | **Per-agent runner** |
| 4 | Dispatch surface | **Both** — board form + co-pilot `/task` verb |
| 5 | Hermes enqueue mechanism | **`enqueue_agent_task` MCP intent**, proposes-only |
| 6 | Dispatch guardrail config | **`dispatch:` block in `policy.yaml` + `dispatch-policy.ts`** |
| 7 | Codex-vs-Claude routing | **Surface + risk taxonomy** (§P4-C) used as an overridable default |
| 8 | Autopilot end condition | **Stated time, else a safety cap** (default 4h; tunable) |
| 9 | Autopilot risk line | **Always escalate high-risk** surfaces (contracts/chain/settlement/secrets/migrations/deploy) to the operator |

**Remaining implementation defaults (builder-tunable, not blockers):** the safety-cap duration (proposed 4h), the exact high-risk surface list, the daily dispatch budget number, and the dispatch allowlist contents — set sensible defaults and surface them in `policy.yaml`.

---

*End of execution design. Reconciled 2026-05-31: O1-O4 have shipped; O5 remains follow-up.*
