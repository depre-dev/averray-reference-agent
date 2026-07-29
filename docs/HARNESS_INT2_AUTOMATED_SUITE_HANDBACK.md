# INT-2 handback — automated supervised-dispatch suite

**Status:** CI authentication, model-environment, and hosted Linux Git ownership
fixes implemented; fast gates and the real nine-case Docker/Postgres suite are
green locally and on the GitHub-hosted Linux runner

**Baseline:** `47de9f3bdb25eda7354297a951b9927368194791`

**Implementation commit:** `a4066b4446290e91ec9e2a60589f76d9c8825a03`

**Harness pin:** `0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2`

**Runtime authority change:** none; this adds evidence, operator scripts, tests,
and CI wiring without changing dispatcher or kernel runtime code

## Hosted Linux Git ownership amendment

**Fix baseline:** `e7c21806b6e2a7a2b2a46863a0f63f31f927c0bb`

**Source evidence:** GitHub Actions run `30476014572`, main
`0b0b1d7f0470f1215ca27fea059fcaf11f6a4c13`, artifact
`int2-supervised-dispatch-evidence` id `8733742749`, archive digest
`sha256:6921c1c6f9a4556e5fe037ec099dac1d26fa433f57a6e5a6ce9e03f61469ab4b`.

The deploy-key checkout, pin verification, databases, image build, dispatcher,
script selection, tool dispatch, and tool completion were correct. The four
failed cases all crossed the same remaining hosted-runner boundary:

- the green, restart, and narrowed-authority cases wrote the expected file with
  tool exit 0, then failed their required `git diff --check` with exit 129;
- the negative case wrote its intended whitespace violation with tool exit 0,
  but the in-run criterion returned exit 129 rather than the expected exit 2;
- the uploaded criterion stderr was identical in all four cases:
  `warning: Not a git repository. Use --no-index...`;
- the evidence collector subsequently reconstructed each patch from the same
  host workspace and ran the same criterion correctly, proving the repository
  and mutation survived. The mismatch was specifically inside the sandbox.

A controlled Linux-container reproduction established the cause. The pilot
image has no `USER`, so the sandbox runs as root. A Git repository owned by the
GitHub runner uid is bind-mounted at `/workspace`. With no trust entry,
`git diff --check` emits the artifact's generic warning and returns 129;
`git status` exposes the underlying
`fatal: detected dubious ownership in repository`. Adding the exact
system-level safe directory `/workspace` makes the same foreign-owned
repository return exit 0. This was not SIGHUP, a missing verdict, or dispatcher
failure.

The amendment:

- adds `safe.directory=/workspace` to the ceremony-only pilot image's system
  Git config. It does not use `*`, trust another path, add a credential, change
  the image user, or change the network-none runtime;
- corrects the image comment: the sandbox runs as the image's default root
  user, not as the host operator uid;
- adds a real pre-case ownership probe. The script creates a self-contained Git
  repository under `$HOME/.agent-runtime`, the same Docker-visible root the
  pinned Harness uses, mounts it at `/workspace` under `--network none`, and
  requires `git diff --check` to pass;
- exits 26 with
  `INT2_PILOT_GIT_OWNERSHIP_FAILED` before any case if that property fails, and
  records `INT2_PILOT_GIT_OWNERSHIP_VERIFIED` when it holds;
- prefix-validates cleanup of the disposable probe directory;
- pins the exact `/workspace` trust entry, forbids a wildcard entry, and pins
  both probe markers in the fast unit suite.

No acceptance criterion, expected verdict, evidence invariant, fixture,
capability, dispatcher path, kernel source, Harness pin, dependency, or lockfile
changed.

### Hosted Linux amendment gate output

```text
$ npm ci
added 312 packages in 3s
# exit 0

$ npm run typecheck
> tsc -b --pretty false packages/* services/*
# exit 0

$ npm test
Test Files  204 passed | 2 skipped (206)
Tests       2613 passed | 13 skipped (2626)
Duration    13.83s
# exit 0

$ npm run build
> tsc -b packages/* services/*
# exit 0

$ HARNESS_CHECKOUT=/Users/pascalkuriger/repo/agent-harness \
    INT2_SUITE_EVIDENCE_DIR=/private/tmp/int2-suite-evidence-docker-mount-fix-3 \
    scripts/ceremony/run-int2-automated-suite.sh
INT2_PILOT_GIT_OWNERSHIP_VERIFIED
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
Duration    142.00s
INT-2 automated suite: 9 cases executed in 150s
# exit 0
```

The evidence bootstrap terminates with:

```text
INT2_HARNESS_PIN_VERIFIED pin=0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2
INT2_HARNESS_RUNTIME_READY
INT2_PILOT_GIT_OWNERSHIP_VERIFIED
INT2_CASES_STARTED expected=9
INT2_CASES_COMPLETED executed=9 elapsed=150
INT2_SUITE_EXIT_CODE=0
```

### GitHub-hosted re-gate

Run `30478826796` at
`0f8b7373acea503d1e07b38531468fbbb88fa4b7` reproduced the Linux uid split
and passed:

```text
Typecheck and test                 success
Docker build                       success
INT-2 real dispatcher integration success
Prove the suite did not skip       success
Upload INT-2 evidence              success

Test Files  1 passed (1)
Tests       9 passed (9)
Duration    170.55s
INT-2 automated suite: 9 cases executed in 241s
```

The hosted evidence artifact is id `8734856204`, size `89,645` bytes, digest
`sha256:dbce3fa64e50b98f502f143eb87267c5f3bf242eb6fbbbbc1f0281be0766bb3d`.

### Hosted Linux amendment decisions

1. **Trust the fixed mount point, never every repository.** The container has
   one network-disabled workspace mount. `/workspace` is the minimum Git trust
   boundary that makes its checked-out metadata usable across host uid
   mappings; `safe.directory=*` would be needlessly broad.
2. **Keep the image's root user.** Selecting a fixed image uid would merely
   exchange the Git refusal for cross-host write failures. The exact safe path
   preserves the existing write behavior without adding authority.
3. **Probe the property before the cases.** A static Dockerfile assertion alone
   cannot prove the built image and bind mount work together. The runtime probe
   turns the prior four-case ambiguity into one named bootstrap failure.
4. **Use the Docker-visible home root for the probe.** A first local probe under
   the script's `mktemp` root correctly failed because Colima does not share
   that host path. Moving only the disposable probe under the same root used by
   Harness makes the probe portable without changing Harness workspace
   placement.

### Hosted Linux amendment open questions

None.

## Re-gate amendment — CI checkout and cross-machine determinism

**Fix baseline:** `734a520`

**Required GitHub Actions secret:** `INT2_HARNESS_DEPLOY_KEY`, containing the
private half of a read-only deploy key registered on the private pinned Harness
repository.

The main-branch failure and the independent-review run-completion split had
separate causes:

1. The runner cloned the private Harness over unauthenticated HTTPS. A developer
   checkout or credential helper hid that dependency locally, while a GitHub
   runner failed with Git exit 128 before creating the evidence directory.
2. The suite passed the staged script only through
   `HARNESS_TEST_MODEL_SCRIPT`, but the pinned Harness resolves executor-role
   and adapter-specific script variables first. The worker inherited the entire
   operator environment, so an existing higher-precedence script or live-model
   configuration could shadow the staged JSONL. This explains the review
   machine's apparently contradictory results: terminal cases followed
   uncontrolled model behavior, while the HALT case reached
   `learning_processed` without ever dispatching its intended `sleep 30`.

The amendment:

- creates `bootstrap.log` before attempting the private checkout and records the
  final suite exit code, so the always-uploaded artifact is non-empty even when
  checkout fails;
- runs the separate nine-case non-skip assertion under `if: always()`, so an
  absent credential cannot bypass the assertion merely by failing an earlier
  step;
- uses the read-only deploy key through strict SSH with GitHub's pinned
  published Ed25519 host key, `IdentitiesOnly`, `BatchMode`, and
  `StrictHostKeyChecking`; the secret is unset before Git or any later child
  process is started;
- exits 20 with the named
  `INT2_HARNESS_DEPLOY_KEY_MISSING` error when CI has neither an existing
  checkout nor the key, and exits with a separate named checkout error when
  authenticated cloning fails;
- preserves developer behavior: an explicitly supplied clean
  `HARNESS_CHECKOUT` is reused, otherwise local Git credentials may supply the
  HTTPS checkout outside CI;
- constructs a controlled worker environment that removes inherited model
  credentials, model selection, scripted-model precedence variables, and
  factory counters, then sets all four applicable executor/adapter script
  precedence levels to the one staged JSONL and pins the model identity to
  `openai-compatible/int2-scripted-model`;
- waits for the exact `CapabilityProposed` →
  matching-`args_hash` `CapabilityDispatched` chain for `sleep 30`, instead of
  treating the broad `executing` state as proof;
- verifies the exact command chain for every scripted run. Ordinary fixture
  commands must have a broker-successful completion and exit 0. HALT must record
  at least 29 seconds and the expected `command_timeout`;
- emits a diagnostic JSON bundle on either timeout or an unexpected terminal
  lifecycle, including Harness state/outcome, selected events, worker output,
  and dispatcher logs;
- installs `zsh` explicitly in the Ubuntu fast-test job and parses every
  operator script with both `bash -n` and `zsh -n`. The test is never skipped
  merely because the runner image omitted the operator shell.

No acceptance criterion, case count, evidence invariant, fixture mutation,
dispatcher production path, kernel source, Harness pin, dependency, or lockfile
was changed.

The definitive HALT record from the re-gate contains:

```json
{
  "command": "sleep 30",
  "duration_seconds": 30.058548083063215,
  "outcome": {
    "ok": false,
    "error": {
      "code": "command_timeout"
    }
  }
}
```

That is the expected bounded-shell result: the command ran for the full bound
and timed out. It is not reported as a successful command exit, and a
fast/no-op execution fails `scripted_tool_duration`.

### Re-gate output

```text
$ npm run typecheck
> tsc -b --pretty false packages/* services/*
# exit 0

$ npm test
Test Files  199 passed | 2 skipped (201)
Tests       2532 passed | 13 skipped (2545)
Duration    10.96s
# exit 0

$ npm run build
> tsc -b packages/* services/*
# exit 0

$ HARNESS_CHECKOUT=/Users/pascalkuriger/repo/agent-harness \
    INT2_SUITE_EVIDENCE_DIR=/private/tmp/int2-suite-evidence-ci-repro-fix-5 \
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
Duration    138.10s
INT-2 automated suite: 9 cases executed in 145s
# exit 0

$ env -u HARNESS_CHECKOUT -u INT2_HARNESS_DEPLOY_KEY \
    CI=true \
    INT2_SUITE_EVIDENCE_DIR=/private/tmp/int2-missing-key-evidence-fix \
    scripts/ceremony/run-int2-automated-suite.sh
INT2_HARNESS_DEPLOY_KEY_MISSING: CI requires the read-only private Harness deploy key
# exit 20

$ cat /private/tmp/int2-missing-key-evidence-fix/bootstrap.log
INT2_SUITE_BOOTSTRAP_STARTED pin=0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2
INT2_HARNESS_DEPLOY_KEY_MISSING: CI requires the read-only private Harness deploy key
INT2_SUITE_EXIT_CODE=20
```

The full suite output above is the implementation-worktree gate.

### Detached clean-checkout result

The second gate ran at commit `8d4df94` from
`/private/tmp/int2-ci-fix-clean.dHm8Mp/checkout`.

```text
$ git status --porcelain
# no output

$ npm ci
added 312 packages in 3s
# exit 0

$ npm run typecheck
> tsc -b --pretty false packages/* services/*
# exit 0

$ npm run build
> tsc -b packages/* services/*
# exit 0

$ npm test
Test Files  199 passed | 2 skipped (201)
Tests       2532 passed | 13 skipped (2545)
Duration    15.39s
# exit 0

$ HARNESS_CHECKOUT=/Users/pascalkuriger/repo/agent-harness \
    INT2_SUITE_EVIDENCE_DIR=/private/tmp/int2-suite-evidence-clean-8d4df94 \
    scripts/ceremony/run-int2-automated-suite.sh
✓ controlled pair
✓ unapproved
✓ approval-hash mismatch
× negative: expected exit_2, got exit_129
✓ green
× restart: terminal failed; VerificationCompleted exit_129
✓ HALT
✓ narrower profile
✓ unvetted profile
Test Files  1 failed (1)
Tests       2 failed | 7 passed (9)
Duration    145.21s
# exit 1
```

Both failures have the same natural Harness evidence:

```text
warning: Not a git repository. Use --no-index to compare two paths outside a working tree
```

The scripted commands were selected deterministically and ran; the later
unchanged `git diff --check` criterion could not see `.git`. This is the
intermittent mount observation below reproduced from a detached clean checkout,
so this handback does **not** label all gates green and does not tune around it.

### Diagnostic observation kept separate from the fix

During diagnosis, repeated runs on the local Colima host also exposed an
intermittent provider-mount symptom: a scripted file write completed, but a
later `git diff --check` sometimes saw no `.git` and exited 129. The pin is
already the PKT-040 self-contained-workspace merge; no pin advance or acceptance
relaxation can honestly address it. An instrumented run observed the
self-contained `.git` directory from both host and live container during the
tool call and then completed green, while the finalized uninstrumented suite
also completed 9/9. The new failure diagnostics retain the natural event
evidence if this host-specific symptom recurs. It is not conflated with the
review machine's 180-second `running` timeouts, which the model-environment
precedence fix addresses.

### Re-gate decisions

1. **Raw read-only deploy key, not a token or job skip.** This grants the one
   private repository read needed by the mandatory job and leaves the
   fail-required semantics intact.
2. **Pin GitHub's published host key.** An unauthenticated `ssh-keyscan` during
   the gate would merely move the trust problem.
3. **Close only the worker's model environment.** Database, profile, artifact,
   Docker, and dispatcher settings remain inherited as before; only sources
   capable of changing which model/script executes are stripped.
4. **Treat shell exit separately from broker completion.** A `shell.run`
   capability can be broker-successful while its command exits nonzero. The
   evidence now asserts exit 0 for ordinary fixture commands and the exact
   bounded timeout for HALT.
5. **Preserve the 180-second lifecycle ceiling.** The review failure was not
   solved by making a structural misconfiguration wait longer.

### Re-gate open questions

- Resolved: `INT2_HARNESS_DEPLOY_KEY` is provisioned. Hosted run `30478826796`
  authenticated the pinned private checkout and completed all nine cases.
- The intermittent local Docker mount observation above is outside this
  repository's runtime surface. If it reproduces on an otherwise controlled
  clean gate, it should become a separate kernel/provider finding rather than a
  retry or weakened criterion here.

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
