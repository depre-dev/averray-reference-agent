# Hermes Orchestration — Execution Design (per-phase build specs)

- **Status:** Planning / handoff only. **Nothing here is implemented.** This is the build spec a future agent follows; it does not apply changes.
- **Date:** 2026-05-29
- **Companions:** [`HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md`](./HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md) (the why + phases), [`HERMES_INTEGRATION_MAP.md`](./HERMES_INTEGRATION_MAP.md) (the confirmed source map).
- **Scope:** turns plan phases P1–P5 + the dispatch guardrail into concrete, file-level build specs. All `path:line` references are local to this repo. Code blocks are **illustrative sketches of the intended change**, not applied diffs.

> Build order: **P1 → P2 → P3 → P4 (+ guardrail) → P5.** P1 has no open decisions and is ready. P2/P3 have a few decisions flagged for operator sign-off. P4 is the authority change and must not ship without the guardrail. Every phase is one narrow PR per [AGENTS.md](../AGENTS.md), with `npm run typecheck` + `npm test` green and the PR template's invariant checks.

---

## P1 — Agent attribution  ·  ready to build · no open decisions · risk: low

**Goal:** the board stops labelling every card `ext`. Attribute each card to the agent that opened the PR via the branch convention (`codex/*`, `claude/*`).

**Why it's the first build:** smallest change, highest signal, and a prerequisite for routing (you can't route by agent if you can't attribute by agent). It's a pure read-path enrichment — no lane logic, no mutation.

**Confirmed data flow:**
```
raw monitor snapshot
  → boardCardFromItem()          services/slack-operator/src/monitor-hermes-board.ts:42
      builds the slim HermesBoardCardSnapshot (drops the branch today)
  → toBoardCard()                services/slack-operator/src/monitor-v2.ts:313
      → inferAgentType()         services/slack-operator/src/monitor-v2.ts:225  ← uses `owner`, defaults "ext"
  → BoardCard.agentType
```
The branch *is* available upstream (`packages/averray-mcp/src/operator-github.ts:1432` sets `headBranch` from `pull.head.ref`; `services/slack-operator/src/github-pr-state.ts:180,280` too) but the slim card drops it (`monitor-v2.ts:338` — `// branch not in slim model`).

**Change set (3 files):**

1. **`services/slack-operator/src/monitor-hermes-voice.ts`** — add a field to `HermesBoardCardSnapshot` (after `correlationId?`):
   ```ts
   /** PR head branch (e.g. "codex/foo"); forwarded so the v2 mapper can
       attribute the card by branch prefix instead of the owner string. */
   headBranch?: string;
   ```

2. **`services/slack-operator/src/monitor-hermes-board.ts`** — in `boardCardFromItem` (≈:57), resolve and forward the branch:
   ```ts
   const headBranch = headBranchForPr(prState, summary, item);
   return { ...,
     ...(correlationId ? { correlationId } : {}),
     ...(headBranch ? { headBranch } : {}),
   };
   ```
   Add a helper next to `pullRequestState` (≈:393) that tolerates a flat `headBranch` or a nested `head.ref` across `currentPullRequest` / `pullRequest` / `item.pullRequest`:
   ```ts
   function headBranchForPr(prState, summary, item): string {
     for (const src of [prState, recordProp(summary, "pullRequest"), recordProp(item, "pullRequest")]) {
       if (!src) continue;
       const flat = textProp(src, "headBranch"); if (flat) return flat;
       const head = recordProp(src, "head"); const ref = head ? textProp(head, "ref") : "";
       if (ref) return ref;
     }
     return "";
   }
   ```

3. **`services/slack-operator/src/monitor-v2.ts`** — `inferAgentType` (:225) prefers the branch prefix, then falls back to the existing owner-string logic; add an exported helper; and populate `card.branch` in `toBoardCard` (:338):
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
   // toBoardCard:  replace the `branch not in slim model` line with:
   if (item.headBranch) card.branch = item.headBranch;
   ```

**Tests** (`test/unit/monitor-v2.test.ts`, reuse the existing `slim()` helper; `test/unit/monitor-hermes-board.test.ts` for forwarding):
- branch prefix wins over a conflicting `owner` (`owner:"Codex"`, `headBranch:"claude/x"` → `claude`);
- `codex/*`→codex, `claude/*`→claude, case-insensitive;
- non-agent branch (`main`, `feature/x`) falls back to the owner string;
- `mission` type stays `hermes` regardless of branch;
- `toBoardCard` populates `branch` and `agentType` together;
- board forwarding: `headBranch` from `currentPullRequest.headBranch` and from nested `head.ref`.

**Acceptance:** live board attributes `codex/*` and `claude/*` PRs correctly; non-prefixed PRs remain `ext`; typecheck + tests green.

**Note (out of scope):** human-authored PRs on non-prefixed branches stay `ext`. A distinct `human` agent type can come later; not needed now.

---

## P2 — Claude Code worker  ·  concrete · 3 decisions · risk: medium

**Goal:** a Claude worker symmetric to the Codex one, so an approved Claude task runs headless and opens/updates a PR.

**Confirmed reuse surface:**
- `services/slack-operator/src/codex-task-queue.ts` — JSON queue, `proposed→approved→running→completed/failed/cancelled`.
- `services/slack-operator/src/codex-task-runner.ts` — **command-agnostic** poll/claim/execute/heartbeat (spawns `CODEX_TASK_RUNNER_COMMAND` with templated args; 10s poll; 30m timeout; secret-sanitized output).
- `services/slack-operator/src/codex-branch-worker.ts` — the Codex-specific part: refuses protected branches (:123), checks out the PR head branch (:192), runs the `codex` CLI, pushes (:213).

**Design:**
- **Generalize the queue:** add `agent: "codex" | "claude"` to `CodexTaskInput`/`CodexTask` (default `"codex"` for back-compat). Add an `agent` filter to `claimNextApprovedCodexTask` so each runner claims only its agent's tasks.
- **Worker:** `claude-branch-worker.ts` mirroring `codex-branch-worker.ts` — same protected-branch guard, checkout, push, and output sanitization, but the command is `claude -p "<prompt>"` (headless print mode) or the Claude Agent SDK.
- **Runner:** run a second `claude-task-runner` process (filters `agent==="claude"`, its own `CLAUDE_TASK_RUNNER_COMMAND` + heartbeat id), mirroring the Codex runner. Compose service added in `ops/`.

**Tests:** queue `agent` default + claim filter; `claude-branch-worker` refuses protected branches; runner claims only its agent's approved tasks.

**Acceptance:** an approved `claude` task → `claude-branch-worker` runs headless in the PR's worktree → pushes → the PR flows into Operator review via the existing Hermes handoff, unchanged.

**Open decisions (operator):**
1. **PR-centric vs greenfield.** Codex today iterates on an *existing* PR's branch (`pullRequestNumber` is required). Same for Claude (smallest delta, recommended to start), or extend the schema/worker to originate a branch + PR?
2. **Invocation:** `claude -p` headless (parity with the Codex CLI worker, recommended) vs the Agent SDK. Plus auth (API key env), sandbox, network, and whether the worker gets MCP access.
3. **Runner topology:** a per-agent runner (recommended — clean heartbeats/isolation) vs one generalized runner routing by `task.agent`.

**Risk:** medium — this worker executes code and pushes branches. It must reuse the protected-branch guard, secret sanitization, timeout, **and** the human approval gate (tasks run only at `status:"approved"`, `approvedBy:"operator"`).

---

## P3 — Board-driven dispatch  ·  concrete · 1 decision · risk: low–medium

**Goal:** make the dormant `codex-needed` lane (`CREATE / APPROVE TASK`) work for both agents, drivable from the board.

**Confirmed surface:** enqueue is `POST /monitor/codex-tasks` (`services/slack-operator/src/index.ts:389` → `proposeCodexTask` :1107); approval → `approveCodexTask(id, { approvedBy:"operator" })` (:1132). Co-pilot composer already parses `/mission`, `/mute`.

**Design:**
- Extend the create-task endpoint + UI form to accept `agent` (`codex|claude`), defaulting to `codex`.
- Add a co-pilot `/task <agent> <repo>#<pr> <prompt>` slash verb (mirror the `/mission` parser).
- Render the task card's agent (depends on P1 attribution).
- **Keep the human approve step** (`proposed → approved` by operator) — invariant.

**Tests:** endpoint validates/stores `agent`; task card renders the agent; slash-verb parsing.

**Acceptance:** operator creates a `claude` task from the board → it lands in `codex-needed` → the Claude runner claims it → the resulting PR is attributed to `claude`.

**Open decision:** dispatch surface — form, `/task` slash verb, or both (recommend both).

**Risk:** low–medium — no new authority beyond the existing operator-authed endpoint + human approve.

---

## P4 — Hermes as router + the dispatch guardrail  ·  the authority change · risk: HIGH

**Goal:** Hermes proposes and routes work itself; the human still approves.

**Confirmed gap:** `invoke_agent_task` has **no enqueue intent** (`packages/averray-mcp/src/agent-invocation.ts:24`), and `mutation-policy.ts` covers marketplace claim/submit **only** — there is no policy over code dispatch. A global `HALT_FILE` kill switch exists (`packages/averray-mcp/src/index.ts:409`).

**Design — three parts, all required together:**

1. **Enqueue capability (proposes-only).** Add an `enqueue_agent_task` intent to the `AgentInvocationIntent` union, wired to `proposeCodexTask`. It must write `status:"proposed"` **only — never `approved`.** (Alternative: Hermes calls `POST /monitor/codex-tasks` via the gateway. Recommend the MCP intent so it lands in the existing handoff-event audit trail.)

2. **A NEW dispatch guardrail** (do **not** reuse `mutation-policy.ts`):
   - **Allowlist** — which repos + task kinds Hermes may propose.
   - **Budget** — max proposed tasks per day (and per repo), in the style of `hermes/config/policy.yaml`'s budget block; counters persisted in the data dir.
   - **Human-approval invariant** — Hermes proposes; `approveCodexTask` stays operator-only.
   - **Honors `HALT_FILE`.**
   - Lives as a `dispatch:` block in `policy.yaml` + a `dispatch-policy.ts` mirroring `mutation-policy.ts`.

3. **Routing logic (a Hermes skill).** Reads the board (`averray_handoff_monitor`) + roadmap, decides what's needed, routes by **task taxonomy** (Codex owns chain/settlement; Claude takes UI/docs/general), proposes the (gated) task, and **narrates the decision** in the co-pilot rail (a collaboration message). Taxonomy + narration are skill/prompt work.

**Tests:** dispatch-policy unit (allowlist / budget / halt); enqueue intent proposes-only (never approves); routing taxonomy mapping.

**Acceptance:** given a backlog, Hermes proposes ≥1 correctly-routed task (gated), narrates why, and the operator approves it from the board.

**Open decisions (operator):** enqueue via MCP intent vs gateway HTTP; where the dispatch policy config lives; the exact Codex-vs-Claude taxonomy (needs operator input).

**Risk: HIGH — this is the authority change.** It must ship with the guardrail + proposes-only + human approve + `HALT_FILE`. This is the gate before any autonomy; treat it as security-reviewed work.

---

## P5 — Self-management hardening  ·  ongoing

- Heartbeat-staleness detection → surface stuck/stale tasks in `needs-attention`.
- Retries via `attemptCount`; escalation rules when a task fails repeatedly.
- Per-agent performance memory (Hermes memory) feeding the routing skill so attribution → routing improves over time.
- Observability: a handoff event per dispatch decision; no silent caps (log anything dropped by the budget).

---

## Cross-cutting rules (every phase)

- One narrow PR; branch `codex/<task>` or `claude/<task>`; `npm run typecheck` + `npm test` green; complete the PR template, including the durable-invariants checks.
- **Update [AGENTS.md](../AGENTS.md) in the same PR** when a phase changes how agents work (e.g. P2 adds a worker, P4 changes Hermes's powers). This is a durable invariant.
- Preserve the board's honest real/degraded/empty signaling — never make orchestration look more autonomous/live than it is.

## Open-decisions summary (for operator sign-off)

| # | Decision | Phase | Recommendation |
|---|---|---|---|
| 1 | Claude worker: iterate-on-PR vs greenfield branch+PR | P2 | Start PR-centric (smallest delta) |
| 2 | Claude invocation: `claude -p` vs Agent SDK (+ auth/sandbox/MCP) | P2 | `claude -p` headless first |
| 3 | Runner topology: per-agent vs one generalized | P2 | Per-agent runner |
| 4 | Dispatch surface: form vs `/task` slash vs both | P3 | Both |
| 5 | Hermes enqueue: new MCP intent vs gateway HTTP | P4 | MCP intent (auditable) |
| 6 | Where the dispatch policy config lives | P4 | `dispatch:` in `policy.yaml` + `dispatch-policy.ts` |
| 7 | Codex-vs-Claude task taxonomy | P4 | Needs operator input |

---

*End of execution design. Planning/handoff only — not implemented.*
