# INT-2 work order — the scripted ceremony cases become an automated suite

> Work order, not an implementation. It changes how the supervised-dispatch gate
> is *evidenced*, not what it guarantees.

## Why this exists

The INT-2 ceremony is an afternoon of expert manual work across three terminals.
That has a cost the evidence does not show: **it runs rarely, so regressions land
between runs.**

The record so far:

- The first ceremony was defeated by a stuck projection (`learning_processed`
  fell through `lifecycleForProjection`) — a product defect, but one no test
  covered.
- The replay was defeated by a runbook trap (`HARNESS_DISPATCH_DEP_CACHE_DIR`
  set to an empty directory), costing work item `-002`.
- The §2.6 run was defeated by `exit_128` — git could not start inside the
  container.

Two of those three were environment or configuration faults, not product
defects. And the one real defect was ultimately *characterised* by a kernel unit
test running headless in CI, not by the ceremony.

The scripted cases are not really ceremonies. They use a scripted model, fixed
fixtures, deterministic assertions and zero model spend. **They are integration
tests wearing ceremony clothes.** Nothing about them requires a human.

## The split this work order establishes

| Proof | Runs where | Frequency |
|---|---|---|
| §2.5 negative, §2.6 green, HALT, approval-hash mismatch, attenuation refusal, restart idempotence | CI — headless, real dispatcher + real Postgres + real Harness | every PR |
| Approval-gate **practice** and §3 real-model budget case | human operator | once per release |

The distinction is deliberate and load-bearing. A test can prove the *mechanism*
— that an unapproved task cannot dispatch, that a mismatched hash refuses. Only a
human run proves the *practice*: that a person actually reviewed containment and
the record shows it. The first belongs in CI. The second does not, and must not
be automated away.

## 1. Deliverable D1 — the scripted cases as a committed suite

Extend the existing integration tier (`test/integration/`, the
`DISPATCH_TEST_DATABASE_URL` + `describe.skipIf` pattern already used by
`dispatch-store-postgres.test.ts`). Each scripted ceremony case becomes a test
that drives the **real** dispatcher against a **real** Postgres and a **real**
pinned Harness, end to end.

Each case must assert the same invariants the manual verification asserts —
these are not negotiable and are the reason the suite is worth building:

- **exactly-once**: one Harness run, `attempt=1`, one dispatch claim, one outbox
  row, and a bound run id equal to the independently-derived `intendedRunId`;
- **the decision-record pair**: exactly one `dispatch_approval` *and*, on the
  green path only, exactly one `handoff` — the invariant corrected in #556;
- **no actuation**: no `pullRequest` anywhere in the evidence, no mutating
  decision record, `effects.mutates=false`, `mutations=[]`;
- **the patch is correct**, not merely present: non-empty, applies at the pinned
  base revision, and touches exactly the expected allowlisted path;
- **the criterion actually ran**: no `exit_128`, and a required criterion
  evaluated and reported on its merits.

That last one deserves emphasis. The pre-fix §2.6 run recorded
`verdict: "failed"` *and* `required_failed: ["format-command"]` — so every naive
assertion ("did it fail?", "did a required criterion fail?", "was there no
handoff?") would have passed against a run whose acceptance command never
started. **Assert the absence of `exit_128` explicitly.**

## 2. Deliverable D2 — the ceremony scripts move into the repository

`int2-bringup.sh`, `int2-green-setup.sh`, `int2-negative-setup.sh`,
`int2-green-verify.sh`, `int2-negative-verify.sh` and `int2-teardown.sh`
currently live in an operator's home directory. They are unversioned, untested,
and have already needed two live patches (a bash-only `${!v}` that broke under
zsh; a bring-up that would have destroyed a running ceremony's databases on
re-source).

Move them under `scripts/ceremony/`, reviewed and tested like any other code.
The suite in D1 should reuse their logic rather than reimplement it — one
definition of "what the evidence must show", used by both the automated and the
human path.

## 3. Deliverable D3 — every case must be proven able to fail

For each automated case, prove the assertion discriminates: mutate the input so
the case *should* fail, and confirm it does. A green-path test that never sees a
red input is indistinguishable from one that cannot fail.

This is the same discipline PKT-040 applied at kernel level
(`test_docker_git_criterion_passes_clean_and_fails_real_violation`), and it is
what the ceremony lacked: a criterion that always errored looked exactly like a
criterion that worked.

## 4. Deliverable D4 — CI wiring that cannot silently skip

`describe.skipIf(!DATABASE_URL)` is the established pattern and is correct for
local runs. In CI it is a trap: **a suite that skips is green by absence.**

The CI job must therefore assert the suite actually *ran* — a non-zero executed
count, or an explicit "required" env gate that fails the job when the suite is
skipped. A ceremony suite reporting green because it never executed is worse than
no suite, because it reads as evidence.

The job is slow (Docker + Postgres + a pinned Harness checkout). Running it on
every PR is acceptable if it is a separate job from the fast tier; if it must be
gated, gate it on the paths that can break it (`services/harness-dispatcher/**`,
`packages/schemas/**`, `packages/averray-mcp/**`, `test/fixtures/agent-integration/**`)
and always on `main` — and say so, rather than letting coverage quietly narrow.

## 5. Deliverable D5 — document what stays manual, and why

The runbook must state plainly which proofs are now CI-covered and which remain
operator work, so a reader cannot mistake a green CI badge for a completed gate.
The §21.1 acceptance mapping should name, per gate statement, whether its
evidence comes from CI or from the human ceremony.

## 6. Out of scope — do NOT build

Automating the operator's inspect/approve/confirm decision · any helper that
fabricates an approval instead of computing it through the same code path as the
CLI · running against production, the money rail, or a real GitHub repository ·
opening pull requests · changing what any invariant asserts in order to make the
suite faster or greener · removing the human ceremony.

## 7. Definition of done

Gates green from a clean checkout; the suite runs the scripted cases end to end
and fails when its inputs are mutated (D3); CI runs it and fails if it did not
execute (D4); the ceremony scripts are in-repo and covered; the runbook states
the CI-vs-human split (D5). Handback records: the exact invariants asserted per
case, the D3 mutation used for each and the failure it produced, the CI wall
time, and any invariant the suite deliberately does **not** cover with a reason.

## 8. Decisions

1. **Automate the mechanism, never the practice.** An automated approval helper
   must compute the approval through the same path as the CLI, including the
   task hash. A shortcut that fabricates approval would leave every test green
   while deleting the supervision property the gate exists to prove — the most
   dangerous possible outcome of this work order, and the one to guard hardest.
   There must also be a case asserting that dispatch **refuses** an unapproved
   task.
2. **Assert the absence of `exit_128`, explicitly.** It is the one assertion that
   separates "the criterion rejected the work" from "the criterion never ran",
   and its absence is what made the previous negative proof worthless.
3. **Skipping is not passing.** The suite must prove it executed. This is the
   same failure mode as an un-fireable check, and it is easy to introduce by
   accident with `skipIf`.
4. **One definition of the evidence.** The automated suite and the operator
   scripts must share the invariant logic. Two drifting definitions of "what the
   ceremony proves" is how a bundle ends up green against the wrong criteria.
5. **The human ceremony survives.** Reduced in frequency, not eliminated. Its
   product is a record that a person reviewed containment — which no test can
   produce.
