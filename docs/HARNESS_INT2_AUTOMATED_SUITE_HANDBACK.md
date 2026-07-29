# INT-2 handback — automated supervised-dispatch suite

**Status:** implementation and clean-checkout gates complete; independent review
pending

**Baseline:** `47de9f3bdb25eda7354297a951b9927368194791`

**Implementation commit:** `a4066b4446290e91ec9e2a60589f76d9c8825a03`

**Harness pin:** `0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2`

**Runtime authority change:** none; this adds evidence, operator scripts, tests,
and CI wiring without changing dispatcher or kernel runtime code

## Built

- Added a fail-required INT-2 integration suite that drives the real production
  dispatcher, two disposable Postgres databases, the pinned Harness worker, the
  Docker provider with `--network none`, and the committed scripted fixtures.
- Added one shared evidence collector/verifier,
  `scripts/ceremony/int2-evidence.mjs`, used by both the automated suite and the
  operator verification scripts. It captures the AgentTask, claims, outbox,
  decisions, Harness run/events/deliverables, reconstructed patch, criterion
  result, manifest identity, eligibility evidence, and absence of pull-request
  references.
- Moved the six operator scripts into `scripts/ceremony/` and covered their
  syntax and critical safety properties:
  - `int2-bringup.sh`
  - `int2-green-setup.sh`
  - `int2-negative-setup.sh`
  - `int2-green-verify.sh`
  - `int2-negative-verify.sh`
  - `int2-teardown.sh`
- Preserved the human approval path. Automated approvals call the same
  `runPilotCli(["approve", ..., "--confirm"])` implementation as the CLI,
  including approved-task hashing and independently derived run identity.
- Added an explicit unapproved-task case. Production dispatch sees no
  dispatchable task and creates no claim, run, outbox binding, or decision.
- Added the corrected §2.4 pair:
  - `memory.propose` is rejected by the outer production profile loader as
    `ProfileManifestError/unvetted_capability`, with no run, outbox, handoff, or
    attenuation-flavoured refusal record;
  - removing `fs.write_file` is accepted and the run manifest contains the
    exact seven-capability effective authority.
- Pinned the attenuation guards at their actual typed boundary:
  - seven approved task grants plus the eight-capability profile produces
    `capability_not_granted`;
  - an external-effect profile capability produces
    `capability_effect_external`;
  - `VETTED_CAPABILITIES` and `PILOT_CAPABILITY_IDS` are asserted equal as sets,
    documenting why neither inner error is reachable through production profile
    loading today.
- Added explicit replay to the restart case: after the first dispatcher submits,
  the suite submits the same intent with the same run id, restarts the
  dispatcher, and observes one run at attempt 1, one claim, and one outbox
  binding.
- Added a separate GitHub Actions job on every PR and `main`. It uses full Git
  history, runs the real tier, requires exactly nine executed cases, and uploads
  the evidence bundle even on failure. The fast job also uses full history
  because the controlled-pair unit preflight resolves the fixture's pinned base.
- Updated the runbook acceptance map to distinguish CI mechanism evidence from
  human operator-practice evidence.

No dispatcher production module, task schema, database migration, profile
allowlist, fixture fence, acceptance criterion, kernel file, dependency,
lockfile, wallet, settlement, deployment, or pull-request-opening path changed.

## Exact case invariants

All evidence cases reject any pull-request binding or URL. Every decision must
be non-mutating with `mutations=[]`, except the HALT case's exact
authority-reducing cancellation described below.

| Case | Exact asserted result |
|---|---|
| Controlled red/green pair | Fixture fences are byte-equivalent across repository, profile, acceptance, budget, deadline, and risk. Both append one line to the same already-tracked `docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md`; all scripted-turn fields except the appended content are identical. Both produce non-empty `git diff --numstat`. Green returns exit 0; red returns exit 2 and names trailing whitespace; neither returns exit 128. |
| Unapproved | Stored lifecycle remains `proposed`; production dispatcher returns idle; zero claims, outbox rows, runs, decisions, handoffs, and PR references. |
| Approval-hash mismatch | Stored lifecycle is `blocked`; exactly one non-mutating `dispatch_refusal` with `approval_hash_mismatch`; zero claims, outbox rows, runs, handoffs, and PR references. |
| Negative | Lifecycle `failed`; one run with the independently derived id, attempt 1, state `learning_processed`, outcome `failed`; one claim and one outbox binding; exactly one non-mutating `dispatch_approval` and no handoff/refusal. Manifest ref/hash are present and equal. The non-empty patch applies at the approved base and touches only the tracked expected path. The required criterion reports `exit_2`, names trailing whitespace, and has no exit 128. |
| Green | Lifecycle `handoff_ready`; one derived-id run at attempt 1, state `learning_processed`, outcome `completed`; one claim and one outbox binding; exactly two non-mutating records, one `dispatch_approval` and one `handoff`. Manifest ref/hash match. The non-empty patch applies at the approved base, touches only the expected tracked path, and reconstructs to exit 0. Handoff evidence refs are non-empty and record both `eligible_for_pr_open=true` and the exact eligibility reason. No PR is opened. |
| Replay/restart | First dispatcher submits, the identical intent is re-submitted under the same run id, and a new dispatcher reconciles it. Final invariants equal green: one run at attempt 1, one claim, one outbox binding, the same immutable run id, the exact decision pair, verified patch, and no PR. |
| HALT | A real worker reaches `executing` on a bounded `sleep 30` tool call. Creating the configured HALT file yields task/run lifecycle `cancelled`; one run at attempt 1, one claim, one outbox, one `dispatch_approval`, no handoff, and one `escalation` decision carrying exactly `agent-task/cancelled` plus `agent-harness/cancel`. No other mutation and no PR is allowed. |
| Narrower profile | The approved AgentTask retains its eight grants while the profile removes `fs.write_file`. The run completes and hands off as green, but its effective manifest contains exactly the other seven capabilities and never `fs.write_file`. |
| Unvetted profile | Adding `memory.propose` produces the actual outer `ProfileManifestError/unvetted_capability`; dispatcher tick is operator-visible as an error. The task remains `approved`. The production dispatcher has already acquired one dispatch claim before loading the profile, but creates zero runs, outbox rows, decisions, handoffs, or PR references. This is explicitly not reported as `capability_not_granted`. |

The final clean evidence rows were:

```text
case              lifecycle       claims  outbox  runs  attempt  run state           outcome    decisions
green             handoff_ready   1       1       1     1        learning_processed  completed  dispatch_approval,handoff
halt              cancelled       1       1       1     1        cancelled           cancelled  dispatch_approval,escalation
hash-mismatch     blocked         0       0       0     -        -                   -          dispatch_refusal
narrow            handoff_ready   1       1       1     1        learning_processed  completed  dispatch_approval,handoff
negative          failed          1       1       1     1        learning_processed  failed     dispatch_approval
profile-unvetted  approved        1       0       0     -        -                   -          -
restart           handoff_ready   1       1       1     1        learning_processed  completed  dispatch_approval,handoff
unapproved        proposed        0       0       0     -        -                   -          -
```

## D3 — every case can fail

The shared verifier is the gate for both operator and CI evidence. Each case
mutates an input to that verifier and asserts the named invariant failure; the
controlled pair additionally runs both real criterion outcomes.

| Case | D3 mutation | Observed failure |
|---|---|---|
| Controlled pair | Use the red fixture's trailing-whitespace append against the same tracked target and fence. | Real `git diff --check` exit 2. A separate unit mutation replaces red with green and is rejected because the pair no longer differs. |
| Unapproved | Change stored lifecycle evidence from `proposed` to `approved`. | `terminal_lifecycle` |
| Approval-hash mismatch | Replace the recorded refusal reason. | `decision_reason` |
| Negative | Inject an exit-128 marker into the verifier evidence. | `events_have_no_exit_128` |
| Green | Erase the reconstructed non-empty `git diff --numstat`. | `criterion_inspected_non_empty_diff` |
| Replay/restart | Duplicate the Harness run projection. | `one_harness_run` |
| HALT | Remove the escalation decision. | `decision_escalation_count` |
| Narrower profile | Restore `fs.write_file` to the effective manifest. | `effective_authority_narrowed` |
| Unvetted profile | Relabel the outer loader error as the unreachable inner guard. | `outer_profile_loader_refusal` |

## Production and typed attenuation boundary

The evidence bundle records:

```json
{
  "production": [
    "profile_loader_unvetted_capability",
    "narrower_profile_accepted"
  ],
  "typedOnly": [
    "capability_not_granted",
    "capability_effect_external"
  ],
  "typedChecksReachableThroughProductionProfileLoading": false
}
```

This is not presented as a production-path attenuation refusal. The production
loader is the stronger outer boundary and runs first. `VETTED_CAPABILITIES` was
not widened.

## CI and operator split

CI now covers the deterministic mechanism on every PR and `main`: controlled
red/green verification, unapproved refusal, approval-hash refusal, explicit
duplicate delivery plus restart, HALT, the production profile pair, and typed
attenuation guards.

The following deliberately remain manual:

- a human's containment inspection and approval-gate practice, because a test
  cannot prove that a person reviewed the task;
- the §3 real-model budget case and representative docs/test/refactor breadth,
  because this suite is deterministic and has zero model spend;
- the two-live-dispatcher concurrency drill. CI proves duplicate-delivery and
  restart idempotence directly; the operator ceremony retains the separate
  process-concurrency practice;
- any production, wallet, settlement, deployment, real target-repository, or
  GitHub mutation. CI redirects the task repository to a local bare remote,
  gives the Docker run no network, and asserts no PR evidence, but does not
  pretend to perform a production non-mutation ceremony.

## Affected surfaces

- CI workflow: yes, one separate required integration job
- Test and evidence infrastructure: yes
- Versioned ceremony/operator scripts: yes
- INT-2 runbook and contributor gate documentation: yes
- Dispatcher or MCP production source: unchanged
- Schemas and migrations: unchanged
- Kernel source: unchanged; exact external pin only
- Dependencies and lockfile: unchanged
- Runtime secrets/config: unchanged
- Wallet, settlement, deploy, PR opening, and GitHub mutation: unchanged

## Rollout and rollback

Rollout is the normal CI workflow update after human merge. It requires GitHub
hosted runners with Docker and outbound access to fetch the exact Harness pin;
the target repository used by runs remains a local bare clone.

Rollback reverts implementation commit `a4066b4`. That removes the workflow job,
suite, shared verifier, and versioned scripts. There is no schema, data,
configuration, secret, deployment, or external-state rollback.

## Definitive clean-checkout verification

The definitive gates ran from detached clean checkout
`/private/tmp/averray-reference-agent-int2-auto-clean-a4066b4` at implementation
commit `a4066b4`.

```text
$ git status --porcelain
# no output

$ node --version
v25.5.0

$ npm --version
11.8.0

$ npm ci
added 312 packages, and audited 325 packages in 3s
# exit 0

$ npm run typecheck
> tsc -b --pretty false packages/* services/*
# exit 0

$ npm test
Test Files  199 passed | 2 skipped (201)
Tests       2526 passed | 13 skipped (2539)
Duration    12.76s
# exit 0

$ npm run build
> tsc -b packages/* services/*
# exit 0

$ INT2_SUITE_EVIDENCE_DIR=/private/tmp/int2-suite-evidence-clean-a4066b4 \
    scripts/ceremony/run-int2-automated-suite.sh
✓ preflights the controlled red/green pair against a real tracked diff
✓ keeps an unapproved task outside the production dispatchable set
✓ refuses an approval-hash mismatch before claim or submit
✓ rejects the negative fixture on its merits with no handoff
✓ produces one verified, unactuated green handoff
✓ restarts between submit and reconcile without duplicating the run
✓ HALT cancels a bound live run and never creates a handoff
✓ accepts a seven-capability profile with strictly narrower authority
✓ rejects memory.propose in the outer production profile loader
Test Files  1 passed (1)
Tests       9 passed (9)
Duration    147.70s
INT-2 automated suite: 9 cases executed in 166s
# exit 0

$ cat /private/tmp/int2-suite-evidence-clean-a4066b4/executed-count.txt
9

$ git status --porcelain
# no output
```

The two fast-suite skips are the prerequisite-gated Postgres integration files.
The dedicated INT-2 invocation supplied both databases, Docker, Harness, and
the fail-required environment; all nine tests executed. The measured
CI-equivalent wall time was **166 seconds**. The first actual GitHub-hosted wall
time will be visible on the draft PR.

`npm ci` reported the repository's existing audit inventory (17 findings).
This PR changes neither dependency metadata nor the lockfile.

## Decisions and rationale

1. **Share the complete evidence verifier.** CI imports it and the operator
   scripts invoke it, preventing separate definitions of green.
2. **Use the CLI implementation for approval.** Calling `runPilotCli` keeps
   task hashing, confirmation, identity derivation, and persistence identical
   to the actual command without fabricating approval rows.
3. **Use a local bare target remote.** Git URL rewriting lets workspace
   preparation execute unchanged while preventing a test from reading or
   mutating the real target repository.
4. **Use a dedicated artifact root, not an isolated `HOME`.** Harness CLI reads
   and its worker share `HARNESS_ARTIFACT_ROOT`; preserving `HOME` keeps the
   operator's Docker context resolvable on desktop Docker.
5. **Treat HALT cancellation as the sole mutation exception.** The work order's
   blanket non-mutating-decision wording conflicts with proving a live run was
   cancelled. The verifier permits only the exact two authority-reducing
   cancel mutations and rejects every other mutation.
6. **Record the corrected §2.4 layers honestly.** The outer loader result and
   the accepted narrower profile are production-path tests; the two
   attenuation errors remain direct typed tests.
7. **Require both an environment gate and an executed-count marker.** Missing
   prerequisites throw before test registration, and CI separately asserts
   exactly nine executions.
8. **Run on every PR with full history.** This avoids a silently narrowed path
   gate and keeps the older fixture base resolvable in both the fast preflight
   and real tier.
9. **Refuse partial database attach state.** Re-sourcing bring-up attaches only
   when both named databases are healthy; if either exists without a healthy
   pair, it leaves both untouched and asks the operator to intervene.

## Open questions

None. The first GitHub-hosted execution will supply the hosted-runner wall time;
the local clean-checkout mechanism and all required evidence are complete.
