# INT-2 §3 work order — the budget-capped real-model task

> Work order, not an implementation. §3 is the only ceremony case that spends
> real money, and **as written it cannot produce a meaningful result with either
> fixture it offers.** Three blockers, all found by pre-flight, none requiring a
> single token to discover.

## Why this exists

§3 says: *"Propose exactly one `lint-format` or `docs-fix` task."* Both options
are currently unusable, for reasons this effort has already met twice.

### Blocker 1 — `docs-fix` can never pass

Its search criterion is `include: ["docs/**"]`, `expectedMatches: 1`.
`evaluate_search` selects files with `root.glob(include)`, and under pathlib
`**` matches **directories**, which the subsequent `is_file()` filter discards.
Zero files are scanned, the count is always 0, and an exact comparison against 1
always fails — regardless of what the model does. Already recorded in
`HARNESS_INT2_FINDING_GIT_ACCEPTANCE.md`. **Do not use `docs-fix` for §3.**

### Blocker 2 — `lint-format` has no work in it, so success would be vacuous

Its objective is *"Correct a small formatting-only defect within the pilot path
allowlist."* Verified against the pinned base `8b94278`:

```
git diff --check on the untouched tree -> exit 0
```

**There is no defect to repair.** A competent model correctly finds nothing to
fix, writes nothing, and `git diff --check` passes on an empty diff. The run goes
green having proven nothing — and unlike the scripted cases, this one costs money
to learn.

This is the same vacuity that produced a **verified handoff for work containing
the intended violation** in `ceremony-lint-format-red-001`. It is the eighth
instance in this effort of a check that could not fail, and the first that would
have been paid for.

### Blocker 3 — there is no cost cap

Every ceremony fixture carries `estimatedUsdMicros: null`, and the field appears
nowhere outside schema type definitions — no enforcement path exists. For the one
case that spends real money, the **token cap is the only actual limiter**.

§3 step 5 says to verify the task is *"within its fixed elapsed, token, tool-call,
and cost budget."* Three of those four are enforced. The fourth is not, and the
runbook implies otherwise.

## 1. Deliverable D1 — a criterion that cannot pass without work

The acceptance criterion must fail when the model does nothing. Verified working,
with no kernel change:

```sh
test -n "$(git diff --numstat)" && git diff --check
```

| Situation | Exit | Meaning |
|---|---|---|
| no work done, empty diff | **1** | refused — nothing to inspect |
| work done, clean | **0** | accepted on a real diff |
| work done, trailing whitespace | **2** | refused, naming the offence |

It discriminates in **all three** directions, where `git diff --check` alone
discriminates in two and silently passes the third. That third case is exactly
what a real-model run is most likely to produce.

## 2. Deliverable D2 — a task with genuine work in it

The fixture must give the model something real to do, and the criterion must
verify it was done. `baseRevision` is immutable and part of the approved task
hash, so the work cannot be seeded by mutating history.

State the objective as a **construction** the model must perform, not a repair of
a defect that does not exist — and make the acceptance criterion verify the
construction. The green/red scripted pair already demonstrates the shape: append
to a tracked allowlisted file, and check the result.

**Do not seed a defect by hand and call it a real-model proof.** If the operator
creates the defect and the model fixes it, the run proves the model can undo a
known edit, which is not what §3 is for.

## 3. Deliverable D3 — pre-flight before spending

Before any credential is exported, prove the criterion discriminates against the
**real** task, exactly as `int2-negative-setup.sh` and `int2-green-setup.sh` now
do for the scripted pair:

- clone at the fixture's `baseRevision`;
- apply a representative **correct** change → assert the criterion **accepts**;
- apply a representative **incorrect** change → assert it **refuses**, naming the
  substantive reason;
- apply **no** change → assert it **refuses**;
- assert `exit_128` and `exit_129` appear in none of the above (git failing to
  start is not a verdict — see `HARNESS_INT2_FINDING_GIT_ACCEPTANCE.md`).

A §3 run that begins without this is a paid experiment whose result cannot be
interpreted.

## 4. Deliverable D4 — an enforced spend ceiling

Either enforce `estimatedUsdMicros`, or state plainly in the runbook that the
token cap is the operative limit and remove "cost budget" from step 5. **Do not
leave a budget field that reads as a control and enforces nothing** — that is the
same class of defect as the checks this effort has been removing all week, and
here it is pointed at spend.

The cheapest honest option is the second: record the token cap as the ceiling,
compute the worst-case cost from the model's published rate, and write that
number down before approving.

## 5. Deliverable D5 — the credential boundary, unchanged

`HARNESS_MODEL_API_KEY` stays in the operator's terminal. It is never pasted into
chat, never committed, never printed, never passed as a CLI argument, and never
appears in evidence. Evidence records the **model identity and endpoint host**,
never the key. §3's existing wording on this is correct and must survive any
rewrite.

## 6. Deliverable D6 — one shot, and a failure is evidence

§3 already says: *"Do not run a second real-model task to improve the result. A
failure is evidence."* Keep it verbatim and honour it. If the model fails the
task, that is the finding — the ceremony records what a real model did with a
real budget under supervision, not the best of several attempts.

Capture per step 7 **before** judging, and specifically record: actual tokens
consumed against the cap, wall time against the elapsed cap, tool calls against
the cap, the resolved model identity, and the verifier's own `details` payload.

## 7. Out of scope

Changing `baseRevision` · seeding a defect for the model to find · relaxing any
acceptance criterion to make a paid run pass · re-running to get a better result ·
any change to the money rail, wallet, signer, claim or submission paths · opening
a pull request from the ceremony.

## 8. Decisions

1. **Neither offered fixture is usable.** `docs-fix` cannot pass; `lint-format`
   cannot fail. §3 needs a fixture built for it, or an explicit statement of
   which existing one it uses and why that one discriminates.
2. **The criterion must refuse an empty diff.** Anything less means the most
   likely real-model outcome — a model that does nothing useful — reads as
   success.
3. **Prove discrimination before spending, not after.** Every prior instance of
   this class was found by breaking the check and confirming it screams. Doing
   that first costs nothing here and costs a paid run if skipped.
4. **A budget field that enforces nothing must not read as a control.** Enforce
   it or delete the claim.
