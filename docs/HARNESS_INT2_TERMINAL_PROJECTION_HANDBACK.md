# INT-2 handback — terminal Harness projection lifecycle

**Status:** implementation and clean-checkout gates complete; independent review pending

**Baseline:** `86e58f7ab4c8b3965ec3b22bd15649cf85223dde`

**Implementation commit:** `65bd7b65b74b6638617c07badf7134959b3da61d`

**Runtime authority change:** none; reconciliation only

## Built

- Changed dispatcher lifecycle resolution to inspect `projection.run.terminal`
  before any state-name mapping.
- Terminal projections now resolve exclusively from `projection.run.outcome`:
  - `completed` plus passed verification → `handoff_ready`;
  - `completed` without passed verification → `failed`;
  - `partial` or `failed` → `failed`;
  - `cancelled` → `cancelled`.
- State-name progress mapping and the existing approval/suspension/quarantine
  safety handling now apply only while `run.terminal` is false. An observed
  `ApprovalRequested` event remains a refusal independently of the state name.
- Added an exhaustive outcome switch with a compile-time `never` guard. A
  malformed terminal projection without a recognized outcome is blocked,
  marked unhealthy, recorded as a dispatch refusal, and emits one critical
  `terminal_projection_unresolved` operator alert instead of retaining the
  current lifecycle silently.
- Added terminal `learning_processed` cases for completed/pass,
  completed/fail, partial, failed, and cancelled outcomes.
- Added a terminal `learning_queued` case with an outcome.
- Added the forward-compatibility guard: it iterates every value in
  `harnessRunStateSchema.options`, projects it with `terminal:true` and
  `outcome:"failed"`, and asserts that reconciliation returns the terminal
  `failed` lifecycle without cancellation or an alert. The state name therefore
  cannot control a terminal result.
- Preserved the existing non-terminal state mappings and their safety alerts.
- Corrected ceremony runbook §1.4: the common export block no longer sets or
  creates `HARNESS_DISPATCH_DEP_CACHE_DIR`. The `lint-format` instructions say
  to leave it unset; the cache-backed fixture section exports and creates it
  immediately before population.

No learning state name was added to a dispatcher lifecycle set or conditional.
No read timeout, Harness read port, workspace-preparation behavior, dispatcher
configuration, task schema, ops file, policy, budget, or authority path changed.
PR #550's read-timeout fix is untouched.

## Lifecycle proof

The terminal mapping is state-independent:

| `run.outcome` | Verification | AgentTask lifecycle |
|---|---|---|
| `completed` | `passed` | `handoff_ready` |
| `completed` | absent, failed, inconclusive, or pending | `failed` |
| `partial` | any | `failed` |
| `failed` | any | `failed` |
| `cancelled` | any | `cancelled` |

The live replay shape from the finding is directly covered:

```text
state=learning_processed
terminal=true
outcome=failed
verification=failed
=> lifecycle=failed
```

The same result is obtained for every other current `HarnessRunState` when the
terminal outcome is `failed`. `learning_queued` and `learning_processed` are not
named by production lifecycle code.

Malformed terminal input produces:

```text
result.outcome=refused
result.lifecycle=blocked
result.healthy=false
alert.severity=critical
alert.code=terminal_projection_unresolved
```

The task does not remain healthy or silently keep `running`, and the dispatcher
does not issue a redundant cancel against a projection that claims to be
terminal.

## Finding discrepancy

The work order states that no dispatcher test referenced `learning_queued` or
`learning_processed`. At baseline `86e58f7`, the original state table did
reference both, but only with a projection that had no outcome and therefore
`terminal:false`; because the source task already had lifecycle `running`, both
assertions merely confirmed the generic `return current` fallthrough.

Those two weak assertions were removed and replaced with outcome-bearing
terminal cases plus the all-state terminal guard. This is a test-fixture
discrepancy only; the reported production defect and required fix are unchanged.

## Affected surfaces

- Harness dispatcher reconciliation: yes
- Dispatcher unit tests: yes
- INT-2 ceremony runbook: yes
- Harness read timeout/read port: unchanged
- Workspace dependency-cache implementation: unchanged
- Slack operator, monitor UI, MCP servers, runners, ops/compose: unchanged
- Schemas, migrations, secrets/config, wallet, settlement: unchanged
- Dependencies and lockfile: unchanged

## Rollout and rollback

Rollout is the normal dispatcher image deployment after human merge and CI.
Existing active tasks need no migration; their next reconciliation read uses
the authoritative terminal outcome already present in the projection.

Rollback reverts commit `65bd7b6`. There is no schema, data, migration,
configuration, secret, or external-state rollback. Reverting would restore the
known stuck-task defect, so rollback is appropriate only if a separate
reconciliation regression is observed.

## Clean-checkout verification

The definitive gates ran from detached clean checkout
`/private/tmp/averray-reference-agent-int2-terminal-projection-clean-65bd7b6`
at implementation commit `65bd7b6`.

```text
$ node --version
v25.5.0

$ npm --version
11.8.0

$ npm ci
added 312 packages in 3s
# exit 0

$ npm run typecheck
> tsc -b --pretty false packages/* services/*
# exit 0

$ npm test
Test Files  194 passed | 1 skipped (195)
Tests       2414 passed | 4 skipped (2418)
Duration    11.67s
# exit 0

$ npm run build
> tsc -b packages/* services/*
# exit 0
```

Focused proof before the definitive clean gate:

```text
$ npm test -- test/unit/reconcile-run.test.ts
Test Files  1 passed (1)
Tests       63 passed (63)
# exit 0
```

During the pre-commit rehearsal, the first full-suite run had one unrelated
timing failure in `testbed-live-screencast.test.ts` because its manifest read
returned `undefined`. That existing suite passed immediately in isolation
(`3/3`), the full rehearsal rerun passed (`2414/2414` non-skipped), and the
definitive clean-checkout full run also passed (`2414/2414` non-skipped). No
out-of-scope screencast code was changed.

Docker/compose validation was not run because this PR changes no `ops/`,
Dockerfile, compose, environment, or image-build surface. CI remains the Docker
build and compose-config merge gate.

## Decisions and rationale

1. **Use the projection's existing terminal/outcome contract rather than a new
   state set.** This makes post-run learning states and future states irrelevant
   to terminal lifecycle resolution.
2. **Keep the completed-run verification consult exactly as before.** A
   completed outcome cannot become handoff-ready without passed verification.
3. **Gate state-based approval, suspension, and quarantine checks on
   `!run.terminal`.** This preserves their active-run safety behavior while
   preventing state names from overriding an authoritative terminal outcome.
4. **Keep observed approval events fail-closed even on a terminal read.** An
   approval packet is a security boundary independent of state-name progress
   mapping.
5. **Block malformed terminal projections without cancelling them.** The
   projection already claims terminality; an operator-visible refusal is safer
   than issuing a redundant control mutation.
6. **Move the dependency-cache export to the cache population block.** Absence
   retains the documented `lint-format` skip behavior, while cache-backed
   fixtures still receive the exact same directory when explicitly selected.

## Open questions

None. The change is limited to the proven projection defect and the runbook trap
identified in the work order.
