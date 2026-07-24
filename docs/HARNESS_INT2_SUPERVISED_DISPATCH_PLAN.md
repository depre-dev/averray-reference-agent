# HARNESS INT-2 — Supervised Dispatch: Architecture & Packet Plan

**Status:** planning only (architect). Not implemented. Codex implements from this plan.
**Author role:** architecture, sequencing, packet specification, independent gating.
**Repo:** `depre-dev/averray-reference-agent` · **Base:** `origin/main` @ `d44d2f7` (PR #533 merged).
**Blocking predecessor:** INT-1 live-compat (PR #533) — **MERGED 2026-07-24T12:23:10Z**. INT-2 is unblocked.
**Do not begin implementation until the operator approves this plan and the first packet's Codex brief (§23).**

> **Authority spine (unchanged, non-negotiable):**
> **Hermes coordinates. The Harness executes. Independent verification gates. The human operator releases. Averray owns authentication, claims, settlement, and economic audit.**
> One Ops Board. One operator-facing Hermes voice. No second Harness dashboard or chat surface. The Harness emits structured state/events/artifacts/verification evidence and **never narrates to the operator**.

---

## 0. How to read this document

INT-2 is **not** a green-field build. INT-0 (#531) and INT-1 (#532, #533) already landed the entire **contract layer** (schemas, canonical hashing, approval binding, attenuation assertions, the read-only projection, the pilot registry). INT-2 is the **runtime** that *uses* those contracts: an AgentTask store, a dedicated dispatcher process, the approved-task→TaskIntent mapping + pre-dispatch attenuation proof, durable dispatch claim/lease/idempotency/outbox/run-binding, decision-record V2 emission, and the control-plane wiring to the generic Harness CLI — all behind `HARNESS_DISPATCH_ENABLED=false`, concurrency one, children off, deny-by-default network, global HALT overriding everything.

Provenance is tracked precisely. When this plan cites the **master integration plan** it means `docs/HARNESS_INTEGRATION_PLAN.md` (the source of the INT-* vocabulary). The four Hermes orchestration docs (`HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md`, `HERMES_ORCHESTRATION_DESIGN.md`, `HERMES_INTEGRATION_MAP.md`, `HERMES_ROADMAP.md`) describe the *legacy* O/A/B/C/D/T substrate (Codex/Claude runners, `dispatch-policy.ts`, supervised/autopilot autonomy) that INT-2 builds on but that does **not** contain INT-* vocabulary.

---

## 1. Verified current-state evidence and dependency versions

### 1.1 Repositories, branches, PR state (verified 2026-07-24)

| Repo | Path | Branch/HEAD | Notes |
|---|---|---|---|
| **Hermes / reference-agent** | `/Users/pascalkuriger/repo/Polkadot/averray-reference-agent` | primary checkout on `codex/o5-task-health-hardening` (stale, ~PR #297 era), **dirty** (untracked `.DS_Store`, `.codex/`) | Real current state is `origin/main` @ `d44d2f7`. **Primary checkout preserved untouched.** This plan authored in a fresh worktree off `origin/main`. |
| **Generic Agent Harness** | `/Users/pascalkuriger/repo/agent-harness` | `main` @ `2f60cab` | Clean except 4 eval-workspace fixtures (Phase-6 ceremony leftovers). `src/`, `docs/`, contracts clean at this SHA. |
| **Averray platform** | `/Users/pascalkuriger/repo/Polkadot` (worktrees under `.claude/worktrees`, `.agent-worktrees`) | this plan's worktree `claude/harness-integration-plan-5af0a8` | Owns `worker/` (the *demand-side bounty worker* — a separate Harness driver, see §16.3). |

**Reference-agent PR state (via `gh`):**
- `#531` feat(harness): add INT-0 charter and integration contracts — **MERGED 2026-07-23T18:46:40Z**
- `#532` feat(harness): add INT-1 read-only projection — **MERGED 2026-07-23T19:41:06Z**
- `#533` fix(harness): accept live INT-1 artifact events — **MERGED 2026-07-24T12:23:10Z** (head `codex/harness-int1-live-compat`)
- **Open PRs: none.** No INT-2 branch or dispatcher exists on `origin/main` (`git grep` for `run submit` / `HarnessDispatcher` / `createHarnessControlPort` returns nothing; only the INT-1 read port exists).

### 1.2 Landed contract & projection layer (INT-0/INT-1) — the substrate INT-2 reuses

All under `packages/schemas/src/` unless noted (verified on `origin/main`):

| File | What it already provides (INT-2 consumes, does not rebuild) |
|---|---|
| `agent-integration-common.ts` | `actorRefSchema` (operator/hermes/policy/dispatcher/harness/verifier/averray/github), `artifactRefSchema` (uri+sha256), `capabilityGrantSchema` (capabilityId/resource/constraints/expiresAt), `acceptanceCriterionSchema` (command/search/baseline_comparison/rubric — **identical set to the harness**), `mutationRefSchema` (with `idempotencyKey`), `harnessRunStateSchema` (21-state mirror), `githubPullRequestRefSchema`. |
| `agent-task.ts` | **`agentTaskV1Schema`** — full lifecycle enum, `harness\|direct` executor union, deny-by-default network, `requestedAuthority` (grants + network + `maxChildren`/`maxConcurrentChildren` + `delegable:false`), budget, deadline, approval (policyVersion/policyHash/approvedTaskHash), timestamps (incl. `dispatchClaimedAt`/`runBoundAt`), `bindings` (harnessRunId/runManifestRef/runManifestHash), and every dispatch invariant as `superRefine`. |
| `agent-contract-hash.ts` | `canonicalContractJson` (RFC-8785-style), `hashCanonicalContract` (SHA-256 via Web Crypto), **`agentTaskApprovalPayload`** (the immutable subset — excludes lifecycle/timestamps/bindings), `hashAgentTaskApprovalPayload`, `agentTaskApprovalHashMatches`. |
| `agent-run-projection.ts` | `agentRunProjectionV1Schema` (INT-1 read model), and **`assertAgentRunProjectionWithinTask`** — the *observation-time* containment primitive (`effectiveCapabilities ⊆ approved`, `assertNetworkAttenuated`, `assertBudgetWithinTask`). INT-2 mirrors this at *dispatch* time. |
| `verified-handoff.ts` | **`verifiedHandoffV1Schema`** with `eligibleForPrOpen` gated on `outcome==completed && verified && all-checks-passed`, plus `assertVerifiedHandoffMatchesTaskAndRun`. The INT-3 boundary, already defined as a contract. |
| `hermes-decision-record.ts` | **`hermesDecisionRecordV2Schema`** (`decisionType` incl. `dispatch_approval`/`dispatch_refusal`/`executor_selection`/`handoff`; `approval.policyHash`; `effects.authorityChanged/budgetChanged`; `next.owner`) + V1 reader + compatibility view. |
| `legacy-agent-task.ts` | `legacyCodexTaskV1Schema` + `toLegacyAgentTaskCompatibilityView` → **`nonDispatchable:true`** with `missingRequiredAgentTaskFields`. Legacy tasks coexist but can never dispatch to the Harness. |
| `packages/averray-mcp/src/dispatch-routing.ts` | `classifyTask` → `{agent, riskTier}` (direct agents only, today). |
| `packages/averray-mcp/src/dispatch-policy.ts` | O4 **proposal** guardrail (`HERMES_DISPATCH_ALLOWED_REPOS`, per-day budgets). **Distinct from execution dispatch** — see §13.2. |
| `packages/averray-mcp/src/decision-records.ts` | V1 decision-record builder + secret sanitizer. **No V2 builder exists yet** → INT-2 net-new. |
| `services/slack-operator/src/harness-read-port.ts` | INT-1 **read-only** fixed-argv CLI adapter (`run status\|events\|deliverables` only; `assertReadOnlyArgs` refuses anything else). |
| `services/slack-operator/src/harness-run-registry.ts` | INT-1 **static** pilot registry (`HARNESS_PROJECTION_BINDINGS_PATH`, ≤100 bindings, secret-scanned). |
| `services/slack-operator/src/harness-run-projection.ts` | INT-1 deterministic mapper CLI-reads → `AgentRunProjection` V1. |
| `services/slack-operator/src/codex-task-queue.ts` | Legacy **file-backed JSON** queue (`AVERRAY_CODEX_TASKS_PATH`, default `/tmp/averray-reference-agent/codex-tasks.json`): propose/approve/claim/complete/fail/retry/cancel + runner heartbeat. |

### 1.3 Generic Harness — pinned facts (SHA `2f60cab`)

- Package `agent-runtime` `v0.0.1`; console script **`harness`** = `agent_runtime.cli.main:main` (`pyproject.toml:20-21`).
- Runtime deps pinned: `dbos==2.26.0`, `psycopg[binary]==3.3.4`, `pydantic==2.13.4`, `pydantic-ai==2.10.0`, `pyyaml==6.0.3`; Python `>=3.12,<3.13`.
- Durability engine: **DBOS 2.26.0 on Postgres.** `harness worker` is the long-running executor; queues `agent-runtime-runs`, `agent-runtime-children` (concurrency 2), `agent-runtime-learning` (concurrency 1). DBOS app-version fence `DBOS_APPLICATION_VERSION="pkt-003"` (`control/runtime.py:9`).
- Contract version constants: TaskIntent `api_version="harness/v1alpha1"` (`contracts/task.py:176`); `RunManifest.manifest_version="1"`; `EventEnvelope.event_schema_version=1`; `VerifierPlan.plan_version="1"`; `EventType` cardinality **19** (pinned invariant).
- **PKT-033 is MERGED** (`8ca7a27`, PR #10). **Phase-6 closed** (`docs/PHASE-6-EXIT.md`, 2026-07-24 real-model ceremony). No git tags → **pin by SHA `2f60cab` from a clean checkout** (do not carry the 4 dirty eval fixtures).

### 1.4 Reference-agent durable persistence available to INT-2

`packages/mcp-common/src/db.ts` exposes a `pg` `Pool` keyed on `DATABASE_URL` (default `postgres://avg_agent:avg_agent@localhost:5432/avg_agent`). Postgres tables already in use (`services/slack-operator/src/persistence.ts` → `operator_command_events`; `packages/averray-mcp/src/mutation-policy.ts` → `submissions`). **This Postgres is the correct home for the AgentTask store, dispatch claims, and outbox** (§5, §10) — separate from the Harness's own Postgres.

---

## 2. Decisions that remain valid from the master integration plan

These are ratified by `HARNESS_INTEGRATION_PLAN.md` and carried forward unchanged. INT-2 must implement them, not re-decide them.

1. **INT sequence** (PLAN §10): INT-0 contracts → INT-1 read-only projection → **INT-2 supervised dispatch** → INT-3 verified PR handoff → INT-4 hardening/drills → INT-5 away-mode after burn-in → INT-6 measured routing → INT-7 Phase-7 evolution.
2. **INT-2 goal** (PLAN:893-895): *submit approved low/medium-risk tasks through a dedicated dispatcher with concurrency one.* Low-risk starts supervised; **medium requires explicit operator approval**; **high is never auto-dispatched** and many categories are categorically forbidden to the Harness.
3. **The canonical 12-step dispatch flow** (PLAN §7, 698-726) — see §6.4. The dispatcher *"accepts typed IDs and artifacts, never an unrestricted shell string."*
4. **Dispatcher definition** (PLAN:172-175): a narrow, **non-conversational** control component that validates exact approved task+policy hashes, maps to TaskIntent, submits once, records the run binding, reconciles events, and refuses authority expansion.
5. **Dedicated-dispatcher rationale** (PLAN decision 3, 1042-1044): *"Replaying an unrestricted shell prompt cannot prove approval, idempotency, attenuation, or the exact submitted artifact. Typed mapping can."*
6. **Attenuation rule** (PLAN:452): *"Approved effective grants are equal to or narrower than requested grants."* `delegable` is always `false` in the initial integration.
7. **Queue migration = dual-read / single-write** (PLAN:779-786): read legacy `codex_task` as compatibility view; write new proposals as `agent_task` V1; do not rewrite history; preserve `POST /monitor/codex-tasks`; new idempotency = `workItemId` + task hash.
8. **Autonomy A1 (supervised)** (PLAN:758): Hermes proposes; **an operator approves every dispatch**; dispatcher executes the exact approved task. This holds INT-2 through burn-in.
9. **Feature flag** (PLAN:741): `HARNESS_DISPATCH_ENABLED=false` until INT-2 acceptance; direct runners stay enabled as fallback behind a separate flag.
10. **Global HALT** (PLAN:741-743, 242-243): global and repository HALT override all autonomy and retry paths; the operator owns global HALT; the dispatcher enforces it.
11. **Concurrency one; child delegation disabled** (PLAN:744).
12. **Authority separation & the forbidden list** (PLAN:219-234) — reproduced in §14.1. *No single agent may request, execute, finally approve, and financially settle the same action* (PLAN:239-242); verifier and executor identities must be distinct for the same run (PLAN:236-237).
13. **INT-2 gate** (PLAN:913-916) and **burn-in exit** (PLAN §9.1, 794-801) — reproduced in §21.
14. **INT-2 must not implement the INT-3 PR-opening seam.** It may define/preserve the `VerifiedHandoff` boundary, but **failed/unverified work produces no submission and no PR mutation.**

---

## 3. Corrections required because INT-0/INT-1/PKT-033 and the live pilot have completed

The following documentation is now stale and must be corrected as part of INT-2 (or a trivial docs PR that precedes it). None is *wrong to act on*; each under-counts what is merged.

| Location | Stale claim | Correction |
|---|---|---|
| `HARNESS_INT0_HANDBACK.md:3` | "Status: implementation complete; pending review" | #531 **merged** 2026-07-23. |
| `HARNESS_INT1_HANDBACK.md:3,6,9` | "acceptance pending live-compatibility follow-up merge"; frames `codex/harness-int1-live-compat` as an unmerged follow-up | That work is **PR #533, merged** 2026-07-24. The metadata-only `ArtifactCreated{"kind":"episode"}` mapper fix is live. |
| `HARNESS_INTEGRATION_PLAN.md:49` | "PKT-033 is a specification only on main … not landed." | PKT-033 **merged** on harness `main` (`8ca7a27`); Phase-6 closed. The INT-2 PKT-033 dependency (PLAN:900) is **satisfied**. |
| `AGENTS.md` (reference-agent) "Agent roles" | "No Harness dispatcher exists until a later separately guarded packet." | Update **in the same PR** that lands the dispatcher (INT-2e), per AGENTS invariant 9 ("Keep this file true"). Until then it remains accurate. |

**Substantive consequences for INT-2 design (not just docs):**
- **The DecisionRecord V2 schema, the VerifiedHandoff schema, canonical hashing, and the attenuation assertion are already implemented.** INT-2 *wires and emits* them; it does not define them. This materially shrinks INT-2.
- **The metadata-only `ArtifactCreated` episode event** is now correctly ignored by the projection mapper (#533). INT-2's dispatched-run projection reuses that mapper unchanged.
- The INT-1 pilot proved: one immutable successful run, one intentional verification failure, and a **source-loss drill that produced no stale-healthy projection** (non-healthy sources require an explicit `reason`; `agent-run-projection.ts:121`). INT-2 must preserve this truth-boundary behavior for dispatched runs.

---

## 4. Dispatcher placement and process-boundary decision

**Decision: a dedicated `harness-dispatcher` process, separate from the conversational `slack-operator` process.** (Resolves master-plan Open Question 3, which already *recommended* "separate process for failure and credential isolation," PLAN:1072-1078.)

### 4.1 Why separate (evidence-backed)
- **Failure isolation.** `slack-operator/src/index.ts` (~5,000 lines) is a large in-process routine host running a dozen `setInterval` loops (autonomy maintenance, product health, task health, self-healing, hermes-router, failure-analysis, alert bridge, …). A Harness submit that hangs, a poll loop that stalls, or a CLI subprocess that misbehaves must **not** degrade the operator's conversational surface or the board.
- **Credential isolation.** The dispatcher needs the pilot Harness CLI + the pilot Harness `HARNESS_DATABASE_URL`; the conversational surface should not hold them. Conversely the dispatcher must **not** hold Slack tokens, GitHub write tokens, wallets, or signing keys (§14).
- **Precedent.** The legacy runners are already **separate per-agent compose-service processes** (`claude-task-runner` mirrors the Codex runner with its own heartbeat/env; `HERMES_ORCHESTRATION_DESIGN.md:68,174`). The dispatcher follows this established topology — it is a sibling runner, not a new pattern.
- **Concurrency-one is a process-level singleton.** A dedicated process with a single-writer lease is the simplest correct enforcement of "at most one active Harness run."

### 4.2 What it is
A new Node/TS service `services/harness-dispatcher/` (own `package.json`, own `ops/` compose service, own env namespace `HARNESS_DISPATCH_*`), structured like the existing runners. It:
- reads approved `AgentTask` records from the shared Postgres store (§5);
- runs a **single** claim→map→attenuate→submit→bind→poll→finalize loop (concurrency one);
- talks to the Harness **only** through the `harness` CLI subprocess (write-capable control port, §8), never the Harness Postgres directly;
- writes **decision records (V2)** and the **outbox run-binding** to the shared Postgres;
- emits **structured facts only** — it never posts to the collaboration channel. The board reads dispatched runs through the **existing INT-1 projection path** (§15). One Ops Board, one Hermes voice.

### 4.3 What stays in slack-operator
Proposal creation, operator approval UI/commands, board rendering, the INT-1 read-only projection, HALT authorship. The operator approves a dispatch in the *existing* proposal/decision experience (PLAN:78); the dispatcher only *acts on* an already-approved, hash-pinned task.

> **Rejected alternative:** dispatcher inside `slack-operator`. Simpler wiring, but couples Harness failure modes and pilot credentials to the conversational surface and the board, and makes concurrency-one and HALT harder to reason about. Rejected per PLAN OQ3.

---

## 5. AgentTask storage and legacy queue migration strategy

### 5.1 Storage decision
**A Postgres-backed AgentTask store in the reference-agent's existing Postgres** (`packages/mcp-common/src/db.ts`), not the legacy JSON file. Rationale: the dispatcher runs in a *separate process* and needs **atomic** claim/lease semantics and an **outbox** — file-locking a JSON blob across processes is not sound. Postgres gives row-level locking, `ON CONFLICT` upserts, and advisory locks (§10).

New tables (migration in INT-2a; see §17):
- `agent_tasks` — one row per `AgentTaskV1` (canonical JSON in a `jsonb` column + extracted columns `work_item_id`, `task_version`, `correlation_id`, `lifecycle`, `executor_kind`, `approved_task_hash`, `deadline`, timestamps). Unique `(work_item_id, task_version)`.
- `agent_task_dispatch_claims` — the dispatch lease/claim (§10): `work_item_id`, `task_version`, `approved_task_hash`, `intended_run_id`, `claim_state`, `claimed_at`, `lease_expires_at`. Unique `(work_item_id, task_version)`.
- `agent_task_run_outbox` — the outbox row binding `work_item_id` → `harness_run_id` + manifest ref/hash, `bound_at`, idempotent upsert keyed by `work_item_id`.
- `hermes_decision_records` — V2 (and V1) records (append-only), keyed by `decision_id`, indexed by `correlation_id`/`work_item_id`.

> These are **coordination-plane** tables. They never hold wallets, keys, or settlement state (§14). The Harness's own run/event/manifest data stays in the Harness Postgres; the coordination plane references it by `harnessRunId` + content hashes only.

### 5.2 Migration = dual-read / single-write (PLAN:779-786)
- **Read:** the board and APIs read **both** legacy `codex_task` (mapped through `toLegacyAgentTaskCompatibilityView` → `nonDispatchable:true`) **and** new `agent_task` rows. One correlated card per work item (reuse INT-1's dedupe).
- **Write:** new proposals are written as **`agent_task` V1**. Historical `codex_task` records are **never** rewritten or promoted.
- **Compat routes:** preserve `POST /monitor/codex-tasks` and the legacy runner claim path until clients move to a new `agent-tasks` endpoint (a later, separate packet). Legacy dedupe stays for legacy items; **new idempotency = `workItemId` + `approvedTaskHash`.**
- **Dispatchability:** only `agent_task` rows with `executor.kind=="harness"`, `lifecycle=="approved"`, and a matching `approvedTaskHash` are eligible for the dispatcher. Legacy `codex_task` and `executor.kind=="direct"` tasks continue through the **existing direct runners** unchanged (§16).

---

## 6. Exact state machine and allowed transitions

### 6.1 AgentTask lifecycle (already in `agent-task.ts:18-28`)
`proposed → approved → dispatching → running → verifying → handoff_ready → blocked → failed → cancelled`

### 6.2 Allowed transitions, actor, and guard (INT-2 runtime encodes this table)

| From | To | Actor | Guard / trigger |
|---|---|---|---|
| `proposed` | `approved` | operator (or policy in INT-5+) | approval decided **for the exact task hash**; `approvedTaskHash = hashAgentTaskApprovalPayload(task)`; `approvedAt` set. |
| `proposed` | `cancelled` | operator | withdrawn before approval. |
| `approved` | `dispatching` | dispatcher | `HARNESS_DISPATCH_ENABLED` on; HALT absent; lease acquired; `agentTaskApprovalHashMatches` true; policy version unchanged; attenuation proof passes; `dispatchClaimedAt` set. |
| `approved` | `blocked` | dispatcher | any pre-dispatch refusal (hash/policy/grant mismatch, expired deadline, exhausted budget, unknown contract version). Emits `dispatch_refusal` record. |
| `dispatching` | `running` | dispatcher | `harness run submit` returned a run id; **`bindings.harnessRunId` recorded**; `runBoundAt` set. (Schema requires a running harness task to carry `harnessRunId`, `agent-task.ts:274-281`.) |
| `dispatching` | `blocked` | dispatcher | submit failed / HALT tripped mid-dispatch / lease lost. |
| `running` | `verifying` | dispatcher (projection) | Harness run reached `VERIFYING`/produced a verification event. |
| `running` | `failed` | dispatcher (projection) | Harness terminal `FAILED`/`PARTIAL`/`QUARANTINED` with structured failure. |
| `verifying` | `handoff_ready` | dispatcher (projection) | Harness terminal `COMPLETED` **and** verification passed; a `VerifiedHandoff` can be *constructed* (not acted on in INT-2). |
| `verifying` | `failed` | dispatcher (projection) | verification failed/inconclusive. **No submission, no PR (§14.4).** |
| `running`/`verifying`/`dispatching` | `cancelled` | operator | operator cancel → `harness run cancel`; bounded (§13.4). |
| `running`/`verifying` | `blocked` | dispatcher | HALT, deadline exceeded, quarantine, or an unexpected `ApprovalPacket` (§14.3). |

Terminal AgentTask states: `handoff_ready` (success, awaiting the INT-3 seam), `failed`, `cancelled`. `blocked` is a recoverable hold requiring an operator decision (retry as a new `taskVersion`, or cancel).

### 6.3 Projection from Harness `RunState` → AgentTask lifecycle
The Harness owns the fine-grained 21-state machine (`contracts/run.py:15-38`, `TRANSITIONS` table). The dispatcher **projects** it (via `harness run status`/`events`, reusing the INT-1 mapper) onto the coarse AgentTask lifecycle:

| Harness `RunState` | AgentTask lifecycle |
|---|---|
| `accepted … strategy_selected`, `executing` | `running` |
| `verifying`, `repairing`, `replanning` | `verifying` |
| `approval_required`, `suspended` | `blocked` (unexpected in INT-2 pilot → escalate, §14.3) |
| `completed` (+ verification passed) | `handoff_ready` |
| `partial` / `failed` / `quarantined` | `failed` (quarantined → also alert) |
| `cancel_requested` / `compensating` / `cancelled` | `cancelled` |
| `learning_queued` / `learning_processed` | (post-terminal; no AgentTask change) |

### 6.4 The canonical 12-step dispatch flow (PLAN §7, encoded by the dispatcher)
1. Hermes creates an `AgentTask` proposal + a **V2 `task_proposal` decision record**.
2. Contract validation canonicalizes and hashes the task.
3. Versioned **risk / allowlist / budget / concurrency / repository / path / network / autonomy / HALT** checks run **fail-closed**.
4. The required approval actor approves **that exact task version and hash**.
5. The dispatcher **atomically claims** the task using the dispatch idempotency key.
6. It **maps** the approved fields into a generic `TaskIntent` and **proves the mapped authority ⊆ approved authority** (§8, §9).
7. It persists the content-addressed TaskIntent ref/hash and **submits once** through the Harness control interface.
8. It records the returned `harnessRunId` + manifest binding **exactly once using the outbox** (§10).
9. The Harness executes durably; events/artifacts are **projected read-only**.
10. The independent verifier evaluates the original acceptance plan → a `VerifiedHandoff` (INT-3 acts on it; INT-2 stops at construction).
11. *(INT-3)* a policy-gated PR opener or the operator creates the PR. **The executor cannot open an unverified PR or merge it.**
12. GitHub/CI, operator, and (when applicable) Averray continue authoritative flows.

Any **hash mismatch, unknown contract version, policy version change after approval, expanded grant, expired deadline, exhausted budget, stale approval, duplicate conflicting binding, unavailable authoritative source, or global HALT** → **refusal or suspension**, never a best-effort prompt (PLAN:723-726).

---

## 7. Task approval, canonical hashing, policy binding, and invalidation

### 7.1 The four hashes (all already computable; INT-2 emits + re-checks them)
The assignment's "immutable task, policy, acceptance, and authority hashes" are **all bound by the single `approvedTaskHash`** plus two run-time hashes:

| Named hash | Where it lives | Coverage |
|---|---|---|
| **task hash** | `approval.approvedTaskHash` = `hashAgentTaskApprovalPayload(task)` (`agent-contract-hash.ts:48-52`) | The immutable payload: `schemaVersion, kind, workItemId, taskVersion, correlationId, taskKind, proposal, repository, intent, acceptance, risk, requestedAuthority, budget, deadline, executor, policyVersion, policyHash`. **Excludes** `lifecycle`, `approval.status`, `timestamps`, `bindings` (the mutable runtime fields) — so mutating any of those does **not** invalidate approval, but mutating anything material **does**. |
| **policy hash** | `approval.policyHash` (+ `approval.policyVersion`) | Folded into the task hash. A policy change after approval → hash mismatch or explicit version check → refuse (§6.4 step 3). |
| **acceptance hash** | `acceptance.verifierPlanHash` (+ `criteria`) | Folded into the task hash; `templateRef.sha256 === verifierPlanHash` enforced (`agent-task.ts:198-204`). Pins the independent verifier plan the run will be judged against. |
| **authority hash** | `requestedAuthority` (grants/network/children/`delegable:false`) | Folded into the task hash; plus the TaskIntent identity `intent.templateHash` (`templateRef.sha256 === templateHash`, `agent-task.ts:191-197`). |

Run-time binding hashes (recorded at dispatch, §10): `bindings.runManifestHash` (with `runManifestRef.sha256 === runManifestHash`) and `bindings.harnessRunId`.

### 7.2 Approval mechanics (already enforced by schema; INT-2 wires the runtime)
- A **decided** approval requires `actor` + `decidedAt`; an **operator**-required approval must be decided by an **operator** actor (`agent-task.ts:86-108`).
- An **approved** task requires `approvedTaskHash`; a non-`proposed`/non-`cancelled` lifecycle requires `approval.status=="approved"` (`agent-task.ts:252-259`).
- At **approval time** the runtime computes `approvedTaskHash` over the current payload and stores it.
- At **dispatch time** the dispatcher re-computes and calls `agentTaskApprovalHashMatches(task)`; **mismatch → refuse** (`dispatch_refusal`, task→`blocked`).

### 7.3 Invalidation rules
- Any material edit (objective, repository/paths, intent template, acceptance, risk, authority, budget, deadline, executor, policy identity) → new `approvedTaskHash` → prior approval no longer matches → **must be re-approved**.
- Policy version/hash change after approval → mismatch → refuse until re-approved under the new policy.
- Expired deadline (`deadline <= now`) or exhausted budget at dispatch → refuse.
- A re-proposal is a **new `taskVersion`** (new hash, new approval, new deterministic run id) — never an in-place mutation of an approved task.

---

## 8. Exact AgentTask → TaskIntent field mapping

**Key structural fact:** `AgentTask.intent` is a **reference+hash to a `harness/v1alpha1` TaskIntent YAML** (`{apiVersion, profile, templateRef, templateHash}`), *not* the intent inline. The TaskIntent is authored once **at proposal time** from the AgentTask fields, stored as a content-addressed artifact, and **frozen by hash** (pinned into `approvedTaskHash`). The dispatcher **resolves + verifies + attenuation-checks + submits** it; it never reconstructs or edits it.

### 8.1 Authoring-time construction (proposal builder — reference-agent side)

| TaskIntent field (`contracts/task.py`) | Source AgentTask field / derivation |
|---|---|
| `apiVersion` | literal `harness/v1alpha1` (must equal `intent.apiVersion`). |
| `kind` | literal `TaskIntent`. |
| `metadata.id` | slug of `workItemId` (lowercased/hyphenated; pattern `^[a-z0-9-]+$`). |
| `metadata.labels` | `{ averray_work_item_id: workItemId, correlation_id: correlationId, task_version: str(taskVersion) }` (traceability; the harness treats labels opaquely). |
| `spec.profile` | `intent.profile` — **must be the pilot allowlisted profile** (§9.4, §22). |
| `spec.objective` | rendered from `proposal.objective` (+ `title`/`whyNow` as context). |
| `spec.deliverables` | fixed for code tasks: `[{type: workspace_patch}, {type: verification_report}, {type: change_summary}]` (mirrors the worker). |
| `spec.context.workspace` | `{ path: <prepared checkout>, revision: repository.baseRevision }`. The checkout of `repository.nameWithOwner@baseRevision` is a **host-side, pre-run** step (the sandbox is offline). |
| `spec.constraints.allowed_paths` | `repository.allowedPaths`. |
| `spec.constraints.forbidden_paths` | `repository.forbiddenPaths`. |
| `spec.constraints.network` | `requestedAuthority.network` (`"deny"` or `{allow:[…]}` — pilot is `"deny"`). |
| `spec.acceptance` | `acceptance.criteria` — **identical discriminated union** (command/search/baseline_comparison/rubric). Field names map 1:1 (`working_directory`, `expected_matches`, `judged_deliverables`, etc.). |
| `spec.approvals` | `[]` for the pilot (no in-run approval rules; see §14.3). |
| `spec.budgets.elapsed` | ISO-8601 duration from `budget.elapsedSeconds`. |
| `spec.budgets.model_tokens` | `budget.modelTokens`. |
| `spec.budgets.tool_calls` | `budget.toolCalls`. |
| `spec.budgets.max_children` / `max_concurrent_children` | **`1` / `1`** — see §8.3 (impedance mismatch). |
| `spec.learning` | `{ episode_capture: true, memory_write: "none", skill_generation: "ineligible" }` for the pilot (no learning writes from supervised dispatch). |

After construction, the builder computes `templateHash = sha256(canonical TaskIntent YAML bytes)`, stores the artifact (`templateRef`), and sets `AgentTask.intent.{templateRef, templateHash}`. The AgentTask's `superRefine` enforces `templateRef.sha256 === templateHash`.

### 8.2 Dispatch-time resolution + verification (dispatcher side)
1. Resolve `intent.templateRef` → TaskIntent YAML bytes; **verify `sha256(bytes) === intent.templateHash`** (else refuse — tamper).
2. `harness validate <intent.yaml>` (offline) — structural sanity before submit.
3. Run the **attenuation proof** (§9) between the resolved TaskIntent and the approved `requestedAuthority`/`repository`/`budget`.
4. Only then submit (§10).

### 8.3 Impedance mismatch: `max_children` (must be documented for Codex)
The harness `TaskBudgets.max_children` / `max_concurrent_children` are **`PositiveInt` (≥1)** (`contracts/budgets.py`), but `AgentTask.requestedAuthority.maxChildren`/`maxConcurrentChildren` are **required `0`** (`agent-task.ts:244-251`). Therefore:
- The TaskIntent sets the harness **minimum `1`/`1`** (it cannot be 0), **but** child spawning is prevented **structurally** by binding a **`direct_execution`-only profile with zero delegable capabilities** (§9.4). "Zero children authority" is enforced by the profile + post-run projection (no child runs), **not** by the budget integer.
- The attenuation proof (§9) asserts `requestedAuthority.maxChildren==0 && delegable==false` and that the pilot profile is direct-execution-only. Post-run, the projection asserts no child run appeared.

---

## 9. Capability attenuation algorithm and fail-closed behavior

INT-2 needs a **pre-dispatch** proof (mirror of the landed *post-observation* `assertAgentRunProjectionWithinTask`) that the TaskIntent's declared authority is **equal to or narrower than** the approved AgentTask authority. New pure function (INT-2c), `assertTaskIntentWithinApprovedAuthority(task, resolvedIntent, profileManifest)`.

### 9.1 Algorithm (all checks fail-closed → refuse)
1. **Identity/hash:** `sha256(resolvedIntentBytes) === task.intent.templateHash`; `resolvedIntent.spec.profile === task.intent.profile`.
2. **Network:** `assertNetworkAttenuated(task.requestedAuthority.network, resolvedIntent.spec.constraints.network)` — `deny` stays `deny`; an allowlist must be `⊆` the approved allowlist (reuse the exact logic from `agent-run-projection.ts:214-229`).
3. **Paths:** `resolvedIntent.allowed_paths ⊆ task.repository.allowedPaths`; `resolvedIntent.forbidden_paths ⊇ task.repository.forbiddenPaths`; and `allowed ∩ forbidden == ∅`.
4. **Budgets:** each of `elapsed`, `model_tokens`, `tool_calls` `≤` the approved `budget.*`; no monetary budget introduced where `estimatedUsdMicros == null` (reuse `assertBudgetWithinTask` shape).
5. **Capabilities:** the pilot **profile's capability catalog** must resolve to an effective capability set `⊆ {grant.capabilityId | grant ∈ requestedAuthority.grants}`. Because the Harness resolves grants from the profile at *compile* time (`compiler.py`), INT-2 verifies the **profile manifest's declared capabilities** against the approved grant ids pre-dispatch, and the **INT-1 projection re-verifies** `manifest.effectiveCapabilities ⊆ approved` post-submit (fail-closed → the run is quarantined/failed and the card shows the expansion).
6. **Children/delegation:** assert `requestedAuthority.maxChildren==0 && maxConcurrentChildren==0 && delegable==false`, and that the profile is **direct-execution-only with no delegable capabilities** (§8.3).
7. **Effects class:** every capability in the pilot profile must have `EffectClass ∈ {none, local}` (no `external_read`/`external_write`) — pilot capabilities are `fs.*`, `git.status/diff`, `shell.run`, `artifact.*` (the worker's proven `averray-worker` set). This guarantees no external side effect can arise and **no `ApprovalPacket` should ever be raised** (§14.3).

### 9.2 Fail-closed behavior
Any failed check → **no submit**. The dispatcher: records a `dispatch_refusal` V2 decision record (with the failing reason code), transitions the task to `blocked`, and emits an alert. It **never** narrows-then-proceeds and **never** expands. An empty/malformed profile manifest, an unresolvable `templateRef`, or an unknown contract version all deny.

### 9.3 Defense-in-depth (three independent layers)
- **Pre-dispatch (INT-2, new):** `assertTaskIntentWithinApprovedAuthority`.
- **In-Harness (already exists):** the compiler mints grants from the profile; `policy/grants.attenuate*()` proves effective ⊆ original; the broker enforces `EgressPolicy deny_all`; the sandbox runs `--network none`.
- **Post-observation (INT-1, already exists):** `assertAgentRunProjectionWithinTask` rejects any run whose `effectiveCapabilities`/network/budget exceed the approved task → card shows the violation, not a healthy state.

### 9.4 Pilot profile requirement
The first supervised pilot **must** pin a profile equivalent to the worker's `averray-worker` profile: `environment: docker` + `--network none`, `egress: deny_all`, capabilities limited to `fs.read_file/write_file/list_files`, `shell.run`, `git.status/diff`, `artifact.put/get`; **`strategies: [direct_execution]` only**; **no capability marked `delegable`**. (Exact profile identity is an operator decision, §22.)

---

## 10. Dispatch claim, lease, idempotency, outbox, and run-binding design

### 10.1 The idempotency key and the run id
- The **dispatch idempotency key** = `(workItemId, taskVersion, approvedTaskHash)`.
- The **intended Harness run id** is derived deterministically and **persisted in the claim before submit** (e.g. a UUIDv5 over the idempotency key, or a minted UUID stored atomically in `agent_task_dispatch_claims.intended_run_id`).
- **Because `submit_run` sets the DBOS `workflow_id = run_id` and the domain insert is `ON CONFLICT (run_id) DO NOTHING`, submitting the same run id twice creates exactly one run.** Idempotent submission therefore requires the dispatcher to **supply** the run id.

> **Critical dependency (see §18 INT-2b, §22 OQ1):** the shipped `harness run submit` CLI **mints its own `uuid4`** (`cli/main.py:564`) and exposes no `--run-id`. Exactly-once dispatch requires either **(a)** a tiny generic harness change adding `harness run submit --run-id <uuid>` (thread the caller id into `submit_run`; ~5 lines; DBOS-idiomatic; recommended), or **(b)** accepting a narrow crash window (§11) with a reconciliation fallback. This plan recommends **(a)**.

### 10.2 Single-writer lease (concurrency one)
Before any dispatch the dispatcher acquires a **global advisory lease** (a Postgres advisory lock or a single lease row `SELECT … FOR UPDATE`) — only one dispatch may be in-flight at a time. HALT is checked under the lease. The lease has a TTL and is renewed by the active poll loop; a crashed dispatcher's lease expires so a restarted instance can take over (reconciling via §11).

### 10.3 The atomic claim
Under the lease, in one transaction:
1. Re-read the AgentTask; assert `lifecycle=="approved"`, `agentTaskApprovalHashMatches`, policy unchanged, deadline/budget valid, HALT absent.
2. Insert the claim row `agent_task_dispatch_claims(work_item_id, task_version, approved_task_hash, intended_run_id, claim_state='claimed')` with `UNIQUE(work_item_id, task_version)` — a duplicate claim attempt hits the constraint and is a no-op (idempotent).
3. Transition the task `approved → dispatching`; set `dispatchClaimedAt`.

### 10.4 Submit + outbox run-binding
1. `harness run submit --run-id <intended_run_id> <intent.yaml>` (or fallback §11). DBOS dedupes on the run id.
2. On success, **upsert** `agent_task_run_outbox(work_item_id, harness_run_id, run_manifest_ref, run_manifest_hash, bound_at)` (idempotent, keyed by `work_item_id`), and set `AgentTask.bindings.{harnessRunId, runManifestRef, runManifestHash}` + `runBoundAt`; transition `dispatching → running`. The schema enforces `runManifestRef.sha256 === runManifestHash` and `harnessRunId` present for a running harness task.
3. The manifest ref/hash may not be available at submit; the binding is completed as soon as the projection reads the manifest (`harness run status` exposes egress; the full manifest hash is read via the INT-1 registry/projection path). The **run id binding is written first and immutably**; the manifest hash binding follows and is asserted to match.

### 10.5 Why this is exactly-once
The run id lives in the claim **before** submit; submit is idempotent on that id; the outbox upsert is idempotent on `work_item_id`. Concurrent or replayed dispatch for the same `(workItemId, taskVersion)` collapses to one claim, one run, one binding.

---

## 11. Crash recovery — before submit, and after submit but before binding

DBOS makes the Harness side durable (the worker auto-recovers in-flight work; steps replay from history; deterministic event ids dedupe appends; zombie runs reconcile to `FAILED reason=control_plane_state_lost`, `run_workflow.py:372-413`). The dispatcher must be equally durable on its side.

### 11.1 Crash **before submit** (claim exists, no run)
On restart, the dispatcher finds a `claim_state='claimed'` row with an `intended_run_id` but no outbox binding. It calls `harness run status <intended_run_id>`:
- **"pending — no worker has started it"** / not found → the run was never submitted (or never started). **Re-submit with the same `--run-id`** (idempotent no-op if it *was* submitted; a fresh start if not). Then complete the binding.
- a record exists → it *was* submitted; proceed to §11.2.

*(Fallback (b), no `--run-id`:* the claim has no usable run id to reconcile against; the dispatcher cannot safely tell "not submitted" from "submitted, id lost," so it **must escalate to the operator** rather than risk a duplicate. This is the concrete cost of not landing INT-2b, and the reason (a) is recommended.)*

### 11.2 Crash **after submit, before binding** (run exists, outbox empty)
With the intended run id in the claim, the dispatcher re-queries `harness run status/events <intended_run_id>`, confirms the run exists, and **completes the outbox binding (idempotent upsert)**. No duplicate run is created; DBOS already owns the run's durability. Exactly-once binding is restored.

### 11.3 Harness-worker crash
Invisible to the dispatcher: DBOS resumes the run. The dispatcher keeps polling `run status`; a run that truly lost domain state surfaces as `FAILED reason=control_plane_state_lost` → task `failed` → alert. **No silent success.**

---

## 12. Duplicate delivery and conflicting-binding handling

- **Duplicate dispatch of the same `(workItemId, taskVersion)`** → same idempotency key → same `intended_run_id` → DBOS dedupes → one run; the claim `UNIQUE` constraint and outbox upsert make the second attempt a no-op.
- **Conflicting binding** — an AgentTask already bound to `harnessRunId = A` while a new dispatch would bind `B`:
  - Same `taskVersion` → **refuse** (a second run id for one approved task version is a conflict): record `dispatch_refusal`, task→`blocked`, alert. The pilot registry/store enforces `harnessRunId` uniqueness (INT-1 `harness-run-registry.ts:59-72`).
  - New `taskVersion` (a re-proposal) → a **distinct** idempotency key and run id; the prior binding stays attached to its own version. Never reuse a run id across versions.
- **Replayed projection reads** are pure and deterministic (INT-1 pin); reading the same run twice yields the same projection — no duplicate cards (one card per work item).

---

## 13. HALT, feature flag, concurrency, cancellation, timeout, and retry

### 13.1 Global HALT (overrides dispatch and retry)
Reuse the existing kill switch: `HALT_FILE` (env, default `/data/HALT`; `assertNoKillSwitch()` at `packages/averray-mcp/src/index.ts:409`; runners check `existsSync(haltFile)` before claiming — `claude-task-runner.ts:165`). The dispatcher checks HALT **before acquiring the lease, before the claim, before submit**, and **aborts the in-flight poll loop** if HALT appears mid-run (issuing `harness run cancel` for the active run). HALT wins over every autonomy and retry path (PLAN:741-743). Repository-scoped HALT is honored identically for tasks in that repo.

### 13.2 Feature flag (distinct from existing flags)
`HARNESS_DISPATCH_ENABLED` defaults **`false`**. Until set, the dispatcher process performs **no claim and starts no Harness submit**. This is a **new, separate** flag — do not conflate it with:
- `HARNESS_PROJECTION_ENABLED` (INT-1 read-only projection), or
- the O4 `HERMES_DISPATCH_*` **proposal** guardrail flags (`dispatch-policy.ts`, which gate Hermes *proposing*, not *executing*).

### 13.3 Concurrency one
Enforced by the single-writer lease (§10.2): at most one active Harness run. `max_concurrent_children` is moot (children disabled, §8.3).

### 13.4 Cancellation (bounded)
Operator cancel → `harness run cancel <run_id>` → the workflow observes it at every state boundary → `CANCEL_REQUESTED → COMPENSATING → CANCELLED` (`control/client.py:84-107`, `run_workflow.py:2652-2674`). Bounded and cooperative. AgentTask → `cancelled`. (The cancel fan-out to children is a no-op here — children disabled.)

### 13.5 Timeout (bounded; must actively cancel the two indefinite-wait traps)
- The dispatcher enforces a **wall-clock deadline** on its poll loop from `deadline` + `budget.elapsedSeconds`.
- **Trap:** a Harness run that reaches `APPROVAL_REQUIRED` or `QUARANTINED` **waits indefinitely** for operator control (`run_workflow.py:2677-2747`). The dispatcher must not hang: on deadline (or on seeing these states in the pilot, which should never occur — §14.3) it issues `harness run cancel` and marks the task `failed`/`blocked` with the reason. **No silent success on timeout.**

### 13.6 Retry (bounded, operator-gated, no silent fallback)
- The Harness performs **no automatic capability retry** (native caps `max_attempts=1`; `fs.write_file`/`shell.run` `safe=False`). Model-level fallback (provider_unavailable/rate_limited/repeated_schema_failure) is internal and bounded.
- A **failed Harness run does not auto-retry and does not silently fall back to a direct runner.** Retry is an **explicit operator action** that creates a **new `taskVersion`** (new hash → re-approval → new run id). The direct-runner path is an explicit operator choice, never an automatic switch after a Harness failure (PLAN:775; the `failed`-not-`completed` honesty rule, `HERMES_ROADMAP.md:67`).

---

## 14. Credential and sandbox boundaries

### 14.1 The Harness (and its models) must NEVER receive (PLAN:219-234)
wallets, private keys, seed phrases, JWT signing keys, settlement credentials, or economic signing authority; production secrets or unrestricted production access; claim/submission/settlement authority; policy-authoring or policy-approval authority; unrestricted deployment capability; the ability to impersonate a human approval; final review/merge/release authority; **authority to broaden its own grants, budget, deadline, network access, allowed paths, or child delegation**; authority to promote/activate/restore/merge its own learned skill changes.

### 14.2 What the dispatcher holds vs. must not hold
- **Holds:** the pilot `harness` CLI, the pilot `HARNESS_DATABASE_URL` (isolated pilot Postgres), the reference-agent coordination Postgres DSN, and read access to the AgentTask store.
- **Must NOT hold:** Slack tokens, GitHub write tokens, wallets/keys/signing, settlement credentials, production secrets, deploy access. (This is the credential-isolation half of §4.)
- Capability manifests carry **credential reference names only, never secret values** (`contracts/capabilities.py:125`). The pilot profile grants **no** credentialed capability.

### 14.3 In-run capability approvals — the dispatcher never mints permission
The Harness may raise an `ApprovalPacket` for an external-effect capability (`harness run approvals`). In the INT-2 pilot the profile has **no `external_*` capability**, so **no packet should ever be raised.** If one is (an anomaly): the dispatcher **must not** call `harness run approve` — it treats the packet as an anomaly, transitions the task to `blocked`, cancels or suspends the run, and escalates to the operator. Auto-approving would be the Harness minting its own permission — forbidden.

### 14.4 The VerifiedHandoff boundary — failed/unverified ⇒ no submission, no PR
INT-2 may **construct** a `VerifiedHandoff` for a completed+verified run (schema already enforces `eligibleForPrOpen` requires `outcome==completed && verified && all-checks-passed`). INT-2 **does not act on it**: no PR is opened, no submission is made. A `failed`/`inconclusive` verification yields **no** handoff and **no** mutation. (This mirrors the worker's proven discipline: `submission.js` throws unless `verificationReport.passed===true` and requires an externally supplied `prUrl` it never mints.) The INT-3 packet owns PR opening.

### 14.5 Sandbox
The pilot Harness worker runs the **docker provider with `--network none`** (the worker's Stage-2 proof: the harness rejects a run whose container `NetworkMode != "none"`). Deny-by-default holds at both the sandbox and broker layers (§9.3).

---

## 15. Audit records, metrics, alerts, and board projection changes

### 15.1 Decision records (V2) — the audit spine (INT-2 emits; schema landed)
A **new V2 builder** (`packages/averray-mcp/src/decision-records.ts`, extending the file that today builds V1) emits `hermes_decision` (schemaVersion 2) records at each decision point, persisted append-only to `hermes_decision_records`:

| `decisionType` | Emitted when | Key fields |
|---|---|---|
| `task_proposal` | Hermes proposes an AgentTask | proposal.what/why/whyNow, evidenceRefs, risk. |
| `risk_classification` | risk tier assigned | risk.tier/reasons/irreversible. |
| `executor_selection` | harness vs direct chosen | routing (executor + reason + scorecardRef). |
| `dispatch_approval` | operator approves the exact task | approval.{required, decision, actor, policyVersion, policyHash, decidedAt}. |
| `dispatch_refusal` | any pre/mid-dispatch refusal | reason in proposal.why; `next.owner`; `effects` (non-mutating). |
| `handoff` | verified handoff constructed | inputs (task/manifest/decision hashes); `next.owner=operator`. |

`effects.{mutates, mutations[], authorityChanged, budgetChanged}` records what actually changed (schema forbids declaring mutations on a non-mutating decision). Records are secret-sanitized (reuse the V1 sanitizer).

### 15.2 Metrics
Dispatch attempts / refusals-by-reason / submissions; runs by terminal outcome; verification pass/fail; run duration and budget-used vs limit; HALT trips; lease contention; orphan-run reconciliations; time-in-`blocked`.

### 15.3 Alerts (off-device, reuse the alert bridge)
`dispatch_refusal`; run `quarantined`; **an `ApprovalPacket` appeared** (anomaly); deadline exceeded / forced cancel; orphan-run detected on restart; HALT tripped with an active run; any projected capability/network/budget expansion.

### 15.4 Board projection (read-only; no new surface)
Dispatched runs surface through the **existing INT-1 projection** (`harness-run-projection.ts` + the "Work queue" lane). The AgentTask lifecycle drives the card; the Harness facts attach read-only. **No new dashboard, no new chat surface.** Non-healthy sources keep an explicit `reason` (no stale-healthy). The dispatcher writes structured facts only; Hermes narrates from them.

---

## 16. Compatibility plan for existing Codex/Claude runners and APIs

### 16.1 Direct runners retained as explicit fallback
`executor.kind=="direct"` (`codex|claude|test-writer|security|docs`) tasks continue through the existing branch-worker runners (`codex-branch-worker.ts`, `claude-task-runner.ts`, …) unchanged. The dispatcher only touches `executor.kind=="harness"` tasks. **No silent fallback**: a Harness failure never auto-routes to a direct runner (§13.6).

### 16.2 Legacy queue + APIs preserved
The file-backed `codex_task` queue and `POST /monitor/codex-tasks` stay (dual-read, §5.2). A new `agent-tasks` endpoint + store is added; clients migrate later (separate packet). `HALT_FILE`, autonomy mode, `dispatch-policy.ts` proposal guardrail, and `classifyTask` routing are unchanged.

### 16.3 Two distinct Harness drivers (do not merge)
- **Averray worker** (`Polkadot/worker/`, `@averray/worker`) — the **demand-side bounty worker**: `job → mapJobToTaskIntent → HarnessDriver.runToCompletion → assembleGithubPrSubmission`, money-rail seam owned by Codex/seam. Offline `averray-worker` profile.
- **Hermes dispatcher** (INT-2, `services/harness-dispatcher/`) — the **supervised ops dispatcher**: `AgentTask → TaskIntent → run → projection/handoff`, operator-approved, coordination-plane.

They share the **same Harness CLI contract** (`run submit/status/events/deliverables`, `artifacts get`, `run cancel`) and the same deny-by-default posture, but are separate code with different authority envelopes. INT-2 **mirrors** the worker's proven CLI-driver contract; it does not import or reuse the worker.

### 16.4 Executor selection
`classifyTask` (routing) stays; INT-2 adds a thin **harness-eligibility layer**: only allowlisted, **low-risk** task families in allowlisted repos with a pilot profile route to `executor.kind=="harness"`; everything else stays `direct`. Medium-risk harness dispatch requires explicit operator approval; high-risk never dispatches to the Harness.

### 16.5 AGENTS.md
Update the reference-agent `AGENTS.md` "Agent roles" (the "no dispatcher exists" line, §3) **in the INT-2e PR** that lands the dispatcher, per invariant 9.

---

## 17. Exact source files proposed per implementation packet

New files are **bold**; existing files are amended. Tests listed in §19.

**INT-2a — AgentTask store + dual-read migration (no dispatch)**
- **`packages/schemas/src/agent-task-store.ts`** (store types/queries interface) *(or colocate in averray-mcp)*
- **`packages/averray-mcp/src/agent-task-store.ts`** (Postgres CRUD over `agent_tasks`, using `mcp-common/src/db.ts`)
- **`ops/migrations/00xx_agent_tasks.sql`** (tables from §5.1)
- amend `services/slack-operator/src/index.ts` (dual-read wiring for the board/API)
- amend `packages/schemas/src/index.ts` (exports)

**INT-2b — (harness repo) caller-supplied run id on `run submit`**
- amend `agent-harness/src/agent_runtime/cli/main.py` (`run submit --run-id`, thread to `submit_run`)
- amend `agent-harness/tests/test_control_cli.py`

**INT-2c — TaskIntent mapping + attenuation proof (pure, no dispatch)**
- **`packages/averray-mcp/src/task-intent-mapping.ts`** (authoring-time builder, §8.1; emits YAML + templateHash)
- **`packages/averray-mcp/src/attenuation.ts`** (`assertTaskIntentWithinApprovedAuthority`, §9)
- **`packages/schemas/src/task-intent.ts`** (a TS TaskIntent schema/serializer mirroring `contracts/task.py` for round-trip + hashing)

**INT-2d — write-capable Harness control port (behind flag, no wiring)**
- **`services/harness-dispatcher/src/harness-control-port.ts`** (`submit(runId, intentPath)`, `cancel(runId)`, reuse INT-1 read parsing for status/events/deliverables). Fixed-argv, no shell interpolation, timeout + output cap, mirrors `harness-read-port.ts` hardening.

**INT-2e — the dispatcher process (flag default-off)**
- **`services/harness-dispatcher/package.json`**, **`tsconfig.json`**, **`src/index.ts`** (single-lease loop)
- **`src/dispatch-claim.ts`** (lease + claim + outbox, §10)
- **`src/dispatch-lifecycle.ts`** (state machine §6)
- **`packages/averray-mcp/src/decision-records.ts`** (amend: **V2 builder**, §15.1)
- **`packages/averray-mcp/src/decision-record-store.ts`** *(or reuse `services/slack-operator/src/decision-record-store.ts`)* (persist V2)
- **`ops/migrations/00xx_dispatch_claims_outbox_decisions.sql`**
- **`ops/compose`** service entry `harness-dispatcher` (env `HARNESS_DISPATCH_*`, default flag off)

**INT-2f — projection wiring of dispatched runs (read-only board)**
- amend `services/slack-operator/src/harness-run-projection.ts` / `harness-run-registry.ts` to accept dispatcher-written bindings (dynamic, alongside the static pilot registry)
- amend the board read path (Work queue lane) — no new surface

**INT-2g — cancellation/timeout/retry + explicit fallback + alerts**
- amend `services/harness-dispatcher/src/index.ts` (deadline, cancel-on-HALT, quarantine/approval-anomaly handling)
- amend the alert bridge wiring (§15.3)
- amend `AGENTS.md` (§16.5)

---

## 18. Ordered, narrow PR packets — dependencies and rollback

> Keep each PR narrow and independently reviewable. **Do not** combine store migration, mapping/attenuation, dispatcher execution, production enablement, verified PR opening, away mode, or routing in one PR. Production dispatch stays disabled until every implementation PR merges, all local + CI gates pass, and the operator approves the ceremony.

| # | Packet | Depends on | Changes production authority? | Rollback |
|---|---|---|---|---|
| **INT-2a** | AgentTask store + dual-read migration | INT-0/1 (merged) | **No** (adds tables + read path; no dispatch) | Revert PR; drop new tables (additive migration). Board dual-read falls back to legacy only. |
| **INT-2b** | *(harness)* `run submit --run-id` | harness `2f60cab` | **No** (adds an optional flag; default unchanged) | Revert; CLI reverts to `uuid4`. |
| **INT-2c** | TaskIntent mapping + attenuation proof (pure) | INT-2a | **No** (pure functions + tests) | Revert PR. |
| **INT-2d** | write-capable control port (flag-gated) | INT-2b, INT-2c | **No** (code only; not wired; flag off) | Revert PR. |
| **INT-2e** | dispatcher process + claim/lease/outbox + decision V2 (flag default-off) | INT-2a–d | **No while `HARNESS_DISPATCH_ENABLED=false`** | Set flag off (instant); revert PR; drop dispatch tables. |
| **INT-2f** | projection wiring of dispatched runs (read-only) | INT-2e | **No** (read-only projection) | `HARNESS_PROJECTION_ENABLED=false`; revert PR. |
| **INT-2g** | cancellation/timeout/retry + explicit fallback + alerts + AGENTS.md | INT-2e, INT-2f | **No while flag off** | Set flag off; revert PR. |
| **INT-2-ENABLE** | *(ops, not code)* operator enables `HARNESS_DISPATCH_ENABLED=true` for the ceremony | INT-2a–g green + operator sign-off | **Yes — first real dispatch authority** | Set flag off (instant, global) + `HALT_FILE`. |

**Enablement is separated from code (PLAN §9):** the last row is an operator-run ops action, not a PR, gated on the ceremony (§20).

---

## 19. Tests — unit, integration, restart, duplicate-delivery, failure-injection

**INT-2a (store):** round-trip persist/read `AgentTaskV1`; unique `(workItemId, taskVersion)`; dual-read merges legacy `codex_task` (as `nonDispatchable`) + `agent_task`; legacy never rewritten.

**INT-2b (harness):** `run submit --run-id X` twice → **one** DBOS workflow, one domain row (`ON CONFLICT DO NOTHING`); omitting `--run-id` preserves the `uuid4` behavior; DSN never echoed.

**INT-2c (mapping/attenuation):**
- mapping: AgentTask → TaskIntent YAML; `sha256(yaml)===templateHash`; acceptance union maps 1:1; `max_children` impedance handled (§8.3).
- attenuation **fail-closed**: network expansion (deny→allowlist, or superset allowlist) → refuse; path outside `allowedPaths` → refuse; budget over approved → refuse; capability outside approved grants → refuse; non-direct-execution profile → refuse; `delegable`/children≠0 → refuse; unresolvable/tampered `templateRef` → refuse.
- hash invalidation: material edit → `agentTaskApprovalHashMatches` false → refuse.

**INT-2e (dispatch/claim/outbox) — the core:**
- **idempotency:** concurrent + replayed dispatch of one `(workItemId, taskVersion)` → **exactly one** claim, one submit (one run id), one outbox binding.
- **restart before submit:** claim exists, no run → restart re-submits same run id → one run (or escalates in fallback mode).
- **restart after submit before binding:** run exists, outbox empty → restart completes binding idempotently → no duplicate.
- **duplicate delivery:** two dispatch triggers → one run.
- **conflicting binding:** existing `harnessRunId` ≠ intended for same version → refuse + `blocked`.
- **HALT wins:** HALT before claim → no claim; HALT mid-run → poll aborts + `run cancel`.
- **concurrency one:** two eligible tasks → only one active run (lease).
- **decision records:** each step emits the correct V2 `decisionType`; `dispatch_refusal` on every refusal path.

**INT-2g (failure injection):**
- **failed verification → no submission, no PR** (assert no mutation, no handoff acted on).
- **deadline exceeded → `run cancel` + `failed`** (no silent success).
- **quarantine / unexpected `ApprovalPacket` → `blocked` + escalate + never auto-approve/release.**
- **source loss** (kill pilot Postgres) → cards go non-healthy with `reason`, never stale-healthy (INT-1 parity).
- **no-silent-fallback:** a Harness failure never auto-starts a direct runner.

**CI:** reference-agent `npm run typecheck` + `npm test` (Node 22) + docker build/compose config (per AGENTS.md); harness `2f60cab` offline + PostgreSQL gates for INT-2b.

---

## 20. Supervised acceptance ceremony (several representative low-risk tasks)

Mirror the INT-1 ceremony discipline: isolated Postgres, docker `--network none`, deny-all egress, tight budgets, **operator approves every dispatch**, no production DB / repo write / wallet / settlement involved.

### 20.1 Representative low-risk task families (≥3, per burn-in)
1. **Docs/comment fix** in an allowlisted low-risk repo (e.g. fix a typo / update a README section) — command + search acceptance.
2. **Add a unit test** for existing behavior (test-writer-shaped) — command acceptance (`pytest`/`vitest`) + `no_new_failures` baseline.
3. **Small dependency-free refactor** confined to `allowedPaths` (rename, extract helper) — command acceptance + baseline.

All: `executor.kind=="harness"`, pilot profile (§9.4), `network:"deny"`, `maxChildren:0`, tight `elapsed`/`model_tokens`/`tool_calls`, near-term `deadline`.

### 20.2 What the ceremony must prove (the INT-2 gate, §21)
- concurrent/replayed dispatch → **exactly one** Harness run;
- approval/hash/policy/grant mismatch → **refuse**;
- **HALT wins**;
- **no wallet/settlement/deploy/GitHub-merge capability present** (assert the manifest grants);
- several representative low-risk tasks **complete through the supervised path**;
- **failed verification → no submission**;
- **restart and duplicate delivery remain idempotent**;
- **cancellation is bounded**;
- one intentional **verification failure** projects as failed (no handoff, no mutation);
- a **source-loss drill** produces no stale-healthy projection.

### 20.3 Evidence bundle
Immutable run ids; pinned manifest hashes (deny-all egress, low risk, the actual capability set, policy/verifier hashes); the V2 decision records per step; the outbox binding; refusal records for the negative cases; alert log; the "no stale-healthy" projection snapshots. (Same shape as the INT-1 handback.)

---

## 21. Gate criteria and evidence required before INT-3

### 21.1 INT-2 gate (PLAN:913-916) — must be green
Concurrent/replayed dispatch creates exactly one Harness run; approval/hash/policy/grant mismatches refuse; HALT wins; **no wallet/settlement/deploy/GitHub-merge capability is present**; several representative low-risk tasks complete through the supervised path; **failed verification produces no submission**; restart and duplicate delivery remain idempotent.

### 21.2 Burn-in exit before retiring any direct runner / before away mode (PLAN §9.1)
≥20 eligible low-risk Harness work items across ≥3 task families; ≥14 consecutive days with **no uncontained authority or duplicate-dispatch incident**; 100% correlation task→run→handoff (→PR when present); **zero unverified PR openings**; all INT-4 drills green; measured completion/verification/cost/latency within approved thresholds; explicit operator decision to retire each fallback independently.

### 21.3 INT-3 entry
INT-3 (verified PR handoff / the PR-opening seam) **does not begin** until the INT-2 gate is green, the ceremony evidence bundle is accepted, and the operator explicitly signs off. INT-2 leaves the `VerifiedHandoff` **constructed but unactuated**; a plan paragraph is not a packet (PLAN:980-982).

---

## 22. Open questions requiring operator decisions

| # | Question | Recommendation (architect) |
|---|---|---|
| **OQ1** | Land the harness `run submit --run-id` change (INT-2b) for true exactly-once, or accept the crash-window fallback (§11.1) that escalates to the operator? | **Land INT-2b.** ~5 lines, generic, DBOS-idiomatic; removes the only exactly-once gap. |
| **OQ2** | Pin the harness at SHA `2f60cab` (no tags) with contract `harness/v1alpha1`? | **Yes** — pin by SHA from a **clean** checkout; record `EventType==19`, DBOS app-version `pkt-003`, and the CLI text-output shapes as the pinned contract (the CLI run-commands emit line-oriented text, not JSON — this is the coupling surface). |
| **OQ3** | Dispatcher as a separate service (recommended) vs. inside `slack-operator`? | **Separate `harness-dispatcher` process** (§4; PLAN OQ3). |
| **OQ4** | First-pilot allowlist: which repo(s), profile, capability set, path scopes, budgets, and operator identities? | Repo: one low-risk, reversible allowlisted repo. Profile: the `averray-worker`-equivalent (direct-execution-only, `fs/git/shell/artifact`, deny-all, `--network none`). Budgets: INT-1-scale (≤ ~30–120s, ≤ ~10k–2M tokens, ≤ ~20–400 tool calls). Operators: the named pilot approver(s). **Operator to confirm exact values.** |
| **OQ5** | Store location: new Postgres tables in the reference-agent DB (recommended) vs. extend the JSON queue? | **Postgres** (§5.1) — required for atomic claim/lease/outbox across a separate process. |
| **OQ6** | Where do the pilot Harness Postgres + `harness worker` run (isolation)? | An **isolated** pilot Postgres + a dedicated `harness worker`, not shared with any production DB (INT-1 ceremony parity). |
| **OQ7** | Pilot model: scripted/deterministic vs. a real model? | Start **scripted/deterministic** for the idempotency/HALT/refusal proofs (cheap, reproducible); add **one real-model** low-risk task for realism, budget-capped. |
| **OQ8** | Which task families for the ceremony? | The three in §20.1 (docs fix / add unit test / small refactor). Operator confirms the specific repo + tasks. |
| **OQ9** | Which decisions genuinely require the operator (vs. policy)? | In INT-2: **every dispatch approval**, HALT, ceremony go/no-go, `HARNESS_DISPATCH_ENABLED` enablement, any `blocked`-state resolution (retry-as-new-version vs. cancel), and any capability-approval anomaly. Policy auto-approval is **out of scope until INT-5**. |

---

## 23. Implementation Brief for Codex — first packet (INT-2a)

> **Scope this PR to INT-2a only.** It adds the durable AgentTask store and the dual-read board path. It **enables no dispatch**, starts no Harness process, and changes **no production authority**. It is the foundation every later INT-2 packet builds on.

### 23.1 Objective
Add a Postgres-backed **AgentTask store** to the reference-agent and wire the board/API to **dual-read** legacy `codex_task` (as a non-dispatchable compatibility view) alongside new `agent_task` records. Write nothing to the Harness. Add no dispatcher.

### 23.2 Exact files
- **New** `packages/averray-mcp/src/agent-task-store.ts` — CRUD over `agent_tasks` using `packages/mcp-common/src/db.ts` (`getPool`/`query`). Functions: `putAgentTask(task: AgentTaskV1)`, `getAgentTask(workItemId, taskVersion)`, `listAgentTasks(filter)`, `listDispatchableAgentTasks()` (returns `executor.kind==="harness" && lifecycle==="approved" && approvedTaskHash present`). Validate every row through `agentTaskV1Schema` on read and write.
- **New** `ops/migrations/00xx_agent_tasks.sql` — table `agent_tasks` (`work_item_id text`, `task_version int`, `correlation_id text`, `lifecycle text`, `executor_kind text`, `approved_task_hash text`, `deadline timestamptz`, `updated_at timestamptz`, `task jsonb`, `PRIMARY KEY(work_item_id, task_version)`), plus indexes on `lifecycle`, `correlation_id`.
- **Amend** `services/slack-operator/src/index.ts` — the board/API read path merges `listAgentTasks()` with the existing legacy `codex_task` read (via `toLegacyAgentTaskCompatibilityView`), producing **one correlated card per work item** (reuse the INT-1 dedupe). Legacy `codex_task` is rendered `nonDispatchable`.
- **Amend** `packages/schemas/src/index.ts` — export any new store types (no schema changes to the landed contracts).
- **New tests** `test/unit/agent-task-store.test.ts` (+ a dual-read test alongside the existing `harness-integration-projection.test.ts` style).

### 23.3 Acceptance tests (must pass locally + CI)
- Persist an `AgentTaskV1`, read it back byte-identical (canonical), validate through `agentTaskV1Schema`.
- `PRIMARY KEY(work_item_id, task_version)` rejects a duplicate; a new `task_version` inserts a distinct row.
- `listDispatchableAgentTasks()` returns only `harness`+`approved`+hash-present rows; excludes `direct`, `proposed`, and legacy `codex_task`.
- Dual-read merges a legacy `codex_task` (→ `nonDispatchable:true` view) and an `agent_task` into **one** card per work item; legacy row is **never rewritten**.
- `npm run typecheck` exit 0; `npm test` green; docker build + compose config valid (per `AGENTS.md`).

### 23.4 Rollback
Revert the PR; the migration is additive (drop `agent_tasks` if needed). The board falls back to legacy-only read. No runtime authority was added, so there is nothing to disable.

### 23.5 Affected surfaces
Backend (MCP store) + slack-operator board read path + a DB migration + tests. **Not** touched: the Harness, the worker, dispatch, GitHub, Averray platform, wallets, settlement, deploy, policy, approval authority.

### 23.6 Confirmation: no production authority changes
This packet adds a **read/write coordination store and a read-only board merge**. It starts no Harness process, holds no credential, opens no PR, and gates behind nothing because it grants nothing. `HARNESS_DISPATCH_ENABLED` does not yet exist. AGENTS.md remains accurate (no dispatcher, no role change) — do **not** edit AGENTS.md in this PR.

### 23.7 Copy-paste prompt for Codex

```
Implement INT-2a: the AgentTask store + dual-read board path for the Harness integration,
in depre-dev/averray-reference-agent. Branch from fresh origin/main as codex/harness-int2a-agent-task-store
(use ./scripts/ops/start-agent-worktree.sh). Read docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md
sections 5, 17, and 23 first; follow AGENTS.md (narrow PR, no push to main, run typecheck+test+docker).

Scope — this PR adds durable AgentTask storage and a dual-read board path ONLY. It enables NO dispatch,
starts NO Harness process, opens NO PR, and changes NO production authority. Do NOT add a dispatcher,
do NOT add HARNESS_DISPATCH_ENABLED, do NOT edit AGENTS.md.

Do:
1) Add packages/averray-mcp/src/agent-task-store.ts — Postgres CRUD over a new agent_tasks table using
   packages/mcp-common/src/db.ts (getPool/query). Export putAgentTask, getAgentTask(workItemId,taskVersion),
   listAgentTasks(filter), listDispatchableAgentTasks() (executor.kind==="harness" && lifecycle==="approved"
   && approval.approvedTaskHash present). Validate every row through agentTaskV1Schema from @avg/schemas on
   read AND write. Store the full task as jsonb plus extracted columns.
2) Add ops/migrations/00xx_agent_tasks.sql — table agent_tasks(work_item_id text, task_version int,
   correlation_id text, lifecycle text, executor_kind text, approved_task_hash text, deadline timestamptz,
   updated_at timestamptz, task jsonb, PRIMARY KEY(work_item_id, task_version)) + indexes on lifecycle and
   correlation_id. Additive only.
3) Amend services/slack-operator/src/index.ts board/API read path to dual-read: merge listAgentTasks() with
   the existing legacy codex_task read mapped through toLegacyAgentTaskCompatibilityView (nonDispatchable:true),
   producing exactly one correlated card per work item (reuse the INT-1 projection dedupe). Never rewrite legacy
   codex_task records.
4) Export new store types from packages/schemas/src/index.ts if needed. Do NOT modify the landed INT-0/INT-1
   contract schemas.
5) Tests: test/unit/agent-task-store.test.ts covering round-trip + agentTaskV1Schema validation, the
   PRIMARY KEY uniqueness on (work_item_id, task_version), listDispatchableAgentTasks filtering (excludes
   direct/proposed/legacy), and a dual-read merge test (one card per work item; legacy stays nonDispatchable
   and unmodified).

Gates: npm run typecheck (exit 0), npm test (green), docker build of ops/Dockerfile.node + compose config check.
PR notes must state: what changed, checks run, affected surfaces (backend store + slack-operator read path +
migration + tests), and explicitly that this changes no production authority and enables no dispatch.
Hand back with the file list, the gate output, and any follow-ups. Do not proceed to INT-2b+.
```

---

### Appendix A — Evidence index (file:line, verified)
- AgentTask contract + invariants: `packages/schemas/src/agent-task.ts` (lifecycle 18-28; executor 39-49; network 32-37; bindings 51-76; approval 78-124; V1 126-282; children==0 244-251; running⇒harnessRunId 274-281).
- Canonical hashing + approval payload: `packages/schemas/src/agent-contract-hash.ts` (payload subset 25-46; hash 15-23; match 54-57).
- Attenuation primitive (post-observation): `packages/schemas/src/agent-run-projection.ts` (`assertAgentRunProjectionWithinTask` 172-204; network 214-229; budget 231-250; non-healthy reason 121-127).
- VerifiedHandoff + PR-open gate: `packages/schemas/src/verified-handoff.ts` (eligibility 109-131; cross-binding 136-176).
- DecisionRecord V2: `packages/schemas/src/hermes-decision-record.ts` (V2 43-166; decisionType 43-53; effects invariants 148-166).
- Legacy non-dispatchable: `packages/schemas/src/legacy-agent-task.ts` (`nonDispatchable` 52; missing fields 53-63).
- INT-1 read port (CLI parsing): `services/slack-operator/src/harness-read-port.ts` (read-only argv 178-184; status/events/deliverables parsers).
- INT-1 registry/projection default-off: `services/slack-operator/src/harness-run-registry.ts` (flag 94-99; secret scan 176-214).
- Legacy queue (file-backed): `services/slack-operator/src/codex-task-queue.ts` (path 814-818; claim 332-373).
- Dispatch proposal guardrail: `packages/averray-mcp/src/dispatch-policy.ts` (fail-closed 102-129). Routing: `dispatch-routing.ts` (`classifyTask` 123-191).
- Reference-agent Postgres: `packages/mcp-common/src/db.ts` (Pool 6-16); `services/slack-operator/src/persistence.ts`; `packages/averray-mcp/src/mutation-policy.ts` (`submissions` 220,236).
- HALT: `packages/averray-mcp/src/index.ts:409` (`assertNoKillSwitch`); `services/slack-operator/src/anomaly-pause.ts:170` (`HALT_FILE` default `/data/HALT`); `claude-task-runner.ts:165` (existsSync check).
- Harness CLI: `agent-harness/src/agent_runtime/cli/main.py` (parser 205-229; `_run_submit` 557-571 → **uuid4 at 564**; status 574-607; events 610-634; deliverables 637-667; cancel 225-226; approvals/approve 217-224; release 227-229; worker 192, 1432-1444).
- Harness idempotency: `agent-harness/src/agent_runtime/control/client.py` (`submit_run` `workflow_id=run_id` 47-53; `ON CONFLICT DO NOTHING` per registry). DBOS recovery/zombie: `control/run_workflow.py:372-413`.
- Harness TaskIntent/RunManifest/RunState: `contracts/task.py` (TaskIntent 171-179; budgets `PositiveInt`); `contracts/run.py` (RunManifest 250-282; RunState 15-38; TRANSITIONS 72-117). Grant/policy: `contracts/policy.py:10-23`. Capabilities/idempotency: `contracts/capabilities.py`. Events (19 types; ArtifactCreated metadata-only): `contracts/events.py:15-36`. Verification gate: `verification/acceptance.py`. Pin: `pyproject.toml`; SHA `2f60cab`.
- Averray worker (separate driver): `Polkadot/worker/src/{job-adapter,harness-driver,submission}.js`; `worker/profiles/averray-worker/profile.yaml`; `worker/HANDOFF.md`.
- Master plan: `docs/HARNESS_INTEGRATION_PLAN.md` (INT-2 893-916; 12-step flow 698-726; authority 219-242; migration 779-786; burn-in 794-801; OQ3 1072-1078).
