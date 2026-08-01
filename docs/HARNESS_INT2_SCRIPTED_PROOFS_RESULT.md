# INT-2 — §2.5 and §2.6 scripted proofs, result

> **Both passed on 2026-07-29**, on Harness pin
> `0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2` (PKT-040), as a controlled pair.
> This is the evidence-bundle entry for the two scripted acceptance cases.

## Result

| Case | Work item | Run id | Lifecycle | Verdict | Criterion | Handoffs |
|---|---|---|---|---|---|---|
| §2.5 negative | `ceremony-lint-format-red-002` | `9b0d44b0-c135-57a9-be7b-b7c415f2fc47` | `failed` | failed | **exit_2** | **0** |
| §2.6 green | `ceremony-lint-format-green-002` | `3bb9ee6f-1fb7-5c3b-86cb-b7fef742e8fb` | `handoff_ready` | completed | **exit_0** | **1** |

Verification: 18/18 checks on §2.5, 31/31 on §2.6.

## Why this pair is a proof and the earlier attempts were not

Both cases run the **byte-identical** fence — repository, eight grants,
`network: deny`, `delegable: false`, `maxChildren: 0`, one `git diff --check`
criterion, identical budget, identical `verifierPlanHash`
(`198282cf…`) — and both append to the **same tracked file** by the same
mechanism. The appended line is the only variable.

The negative case rejected on its merits, quoting the offence:

```
format-command  passed=False  reason=exit_2  required=True
detail: docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md:704: trailing whitespace.
        +INT-2 negative-path proof line with trailing whitespace.
```

The green case accepted, on a real diff:

```
format-command  passed=True   reason=exit_0  required=True
patch: --- a/docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md
       +++ b/docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md
```

Both patches are `--- a/… +++ b/…` — modifications to a tracked file, so the
criterion had something to inspect in each direction.

## The four earlier attempts, and why each proved nothing

Recorded because a bundle that omits its failed attempts is less trustworthy
than one that explains them. All four are preserved in the evidence directory.

| Attempt | Apparent result | Why it proved nothing |
|---|---|---|
| First ceremony | task stuck at `running` | `learning_processed` fell through `lifecycleForProjection` — fixed by #554 |
| Replay `-003` | `verification_failed` | almost certainly `exit_128`; unrecoverable, §4 capture was skipped |
| `green-001` | `verification_failed` | **`exit_128`** — git could not start in the container (PKT-040) |
| `red-001` | **`handoff_ready`** | criterion examined an **empty diff**: the fixture created a *new* file, invisible to `git diff --check` |

Three of the four were failures that *looked* like verdicts. `red-001` is the
sharpest: it recorded `verdict: failed`-shaped success — a handoff for work
containing the intended violation — because the criterion could not see the
change at all.

**The lesson this bundle should carry:** a criterion that cannot fail and a
criterion that cannot run are indistinguishable from one that works, unless the
evidence shows it discriminating in **both** directions. That is why §2.5 and
§2.6 are only meaningful as a pair, and why the acceptance mapping below requires
both.

## Independently verified, not taken from the verification scripts

- **Approval binding.** Both `intendedRunId`s re-derived from
  `sha256(workItemId \0 taskVersion \0 approvedTaskHash)` shaped as UUIDv5 —
  exact match in both cases, and distinct from each other.
- **Containment.** The `green-002` and `red-002` task records were diffed and are
  byte-identical across repository, authority, acceptance and budget.
- **Worker identity.** The running worker's `HARNESS_TEST_MODEL_SCRIPT` was
  checked against the staged fixture hash before each approval
  (`6cfe12c7…` green, `bf0e12df…` red), so neither result is attributable to a
  stale worker.
- **Criterion substance.** The verifier's own `details` payload was read directly
  for both runs, not summarised.

## §21.1 acceptance mapping

| Gate statement | Evidence |
|---|---|
| Failed verification produces no submission | `red-002`: `exit_2` naming the offending line, `verdict: failed`, `required_failed: ["format-command"]`, lifecycle `failed`, **zero** handoff decisions, no PR |
| Verified work produces a correct unactuated handoff | `green-002`: lifecycle `handoff_ready`, one `dispatch_approval` + one `handoff`, eligibility value and reason recorded, 3 verification evidence refs, non-empty patch touching exactly one allowlisted path, manifest ref/hash consistent, `effects.mutates=false`, `mutations=[]`, **no PR** |
| Concurrent/replayed dispatch creates exactly one run | both: one claim, one outbox row, `attempt=1`, bound run id equal to the independently re-derived `intendedRunId` |

## Still outstanding for INT-2

**Nothing. This section is retained, corrected, because a bundle that quietly
edits its own history is worth less than one that shows the correction.**

As written on 2026-07-29 this said the §2 safety proofs (HALT stops a live run,
approval-hash mismatch refuses, attenuation refusal), restart/duplicate-delivery
idempotence, and the §3 budget-capped real-model task were not covered. All of
them now are:

| Then outstanding | Now proven by |
|---|---|
| HALT stops a live run | suite case *HALT cancels a bound live run and never creates a handoff* |
| approval-hash mismatch refuses | suite case *refuses an approval-hash mismatch before claim or submit* |
| attenuation refusal | suite cases *rejects `memory.propose` in the outer production profile loader* and *accepts a seven-capability profile with strictly narrower authority* |
| restart / duplicate-delivery idempotence | suite case *restarts between submit and reconcile without duplicating the run* |
| §3 budget-capped real-model task | executed 2026-08-01; token cap enforced at 8000, criterion returned `exit_1`, zero handoffs |

Left uncorrected, this section made the evidence look thinner than it is — the
opposite of the usual failure, and still a failure. See
`HARNESS_INT2_EVIDENCE_BUNDLE.md` for the full §21.1 mapping, including the one
clause that genuinely remains weak.
