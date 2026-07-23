# INT-0 handback — charter and versioned contracts

**Status:** implementation complete; pending review

**Branch:** `codex/harness-integration-plan`

**Baseline:** `5869af7bf2fc7e6168fbe070744f7d37fdf8c52a` (`origin/main`)

**Runtime authority change:** none

## Built

- Added the reviewed Harness integration charter at `docs/HARNESS_INTEGRATION_PLAN.md`.
- Added strict, versioned Zod contracts in `@avg/schemas`:
  - `AgentTask` V1;
  - `AgentRunProjection` V1;
  - `VerifiedHandoff` V1;
  - `HermesDecisionRecord` V2;
  - the current `HermesDecisionRecord` V1 reader;
  - the current legacy `codex_task` V1 reader.
- Added shared actor, artifact, capability, acceptance, model, mutation, pull-request, hash,
  timestamp, and exact Harness run-state primitives.
- Added deterministic canonical serialization and SHA-256 hashing through Web Crypto.
- Bound approval hashes to the immutable task content, including policy version/hash, while
  excluding lifecycle bookkeeping and post-approval bindings.
- Added pure cross-contract checks that:
  - require run identity and policy to match the approved task;
  - prove effective capabilities, network allowlists, and budgets do not exceed task authority;
  - require a verified handoff to match the approved task hash, TaskIntent, run manifest, verifier
    plan, verification decision, and all stable IDs.
- Kept child delegation disabled in V1: `delegable=false`, `maxChildren=0`, and
  `maxConcurrentChildren=0`.
- Added conservative read-only compatibility views. Historical `codex_task` records remain
  explicitly non-dispatchable because they lack TaskIntent, immutable acceptance, typed grants,
  budget, deadline, and policy hash.
- Added six cross-language JSON fixtures and 18 focused invariant tests.

## Safety pins

1. Unknown contract versions and undeclared fields fail closed for all new contracts.
2. Artifact refs and their declared hashes must agree.
3. An approved task requires an exact task hash, decision actor, decision timestamp, and approved
   timestamp.
4. Harness and verifier identities cannot request or approve an AgentTask.
5. Operator approvals can be decided only by an operator. Policy approvals can be decided only by
   policy or an operator.
6. Material edits change the approval hash and invalidate the approval match.
7. Legacy records are read but never rewritten or promoted into dispatchable `AgentTask` records.
8. Failed or quarantined run projections require structured failure details.
9. Non-healthy run sources require an explicit reason.
10. PR-open eligibility requires completed output, independent accepted verification, and every
    recorded check passing.

No board, queue, runner, policy, dispatcher, Harness CLI, GitHub write, Averray mutation, wallet,
settlement, deployment, or production configuration path changed. `AGENTS.md` remains accurate
because no role or operational behavior changed.

## Files

- `docs/HARNESS_INTEGRATION_PLAN.md`
- `docs/HARNESS_INT0_HANDBACK.md`
- `packages/schemas/src/agent-integration-common.ts`
- `packages/schemas/src/agent-contract-hash.ts`
- `packages/schemas/src/agent-task.ts`
- `packages/schemas/src/agent-run-projection.ts`
- `packages/schemas/src/verified-handoff.ts`
- `packages/schemas/src/hermes-decision-record.ts`
- `packages/schemas/src/legacy-agent-task.ts`
- `packages/schemas/src/index.ts`
- `test/fixtures/agent-integration/*.json`
- `test/unit/agent-integration-contracts.test.ts`

## Verification

```text
$ npm run typecheck
> tsc -b --pretty false packages/* services/*
# exit 0

$ npx vitest run test/unit/agent-integration-contracts.test.ts
Test Files  1 passed (1)
Tests       18 passed (18)

$ npm test
Test Files  176 passed (176)
Tests       2172 passed (2172)
```

One intermediate full-suite run observed the existing
`testbed-live-screencast.test.ts` timing test fail to find its manifest. The isolated test then
passed 3/3, and the final uninterrupted full suite passed 2,172/2,172. INT-0 does not touch that
test or its runtime path.

`npm install` changed no dependency manifest or lockfile. It reported the lockfile's existing audit
inventory; INT-0 adds no dependency.

## Affected surfaces

- Shared schema package: yes
- Documentation: yes
- Tests/fixtures: yes
- MCP runtime: no
- Monitor/board: no
- Slack operator: no
- Agent queue/runners: no
- Ops/compose/environment/secrets: no
- Averray platform: no
- Generic Agent Harness: no

## Rollback

Remove the new schema modules, fixtures, tests, handback, and their exports from
`packages/schemas/src/index.ts`. No stored data, migration, runtime flag, or external system needs
rollback.

## Decisions and rationale

1. **Legacy tasks remain non-dispatchable.** Inventing acceptance, grants, budgets, or policy hashes
   would manufacture authority.
2. **Approval hashes cover policy identity.** Reusing approval after a policy or material task
   change is unsafe.
3. **Lifecycle fields are excluded from the approval payload.** Status and timestamps can advance
   without changing what was authorized.
4. **Canonical hashing uses the Web Crypto API.** It works in Node 22 and browser consumers without
   importing Node-only crypto into the shared schema entrypoint.
5. **Authority attenuation is a cross-contract assertion.** A run can be structurally valid while
   still being invalid for a particular task; both checks are required.
6. **V1 disables children.** Child execution can be introduced only through a later version and
   explicit guardrail review.

## Open questions

No open question blocks review of INT-0. INT-1 still needs the generic read-interface version and
two immutable pilot run IDs selected before its read-only projection proof.
