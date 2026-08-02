# Work order — a budget overrun must not discard verified work

> Found by running the thing. Three real-model ceremony runs, three failures,
> **twice on work this system had already verified and accepted.**
>
> This is the only defect standing between the machine and its first real-model
> handoff, which the operator has set as the gate for INT-3b's first real send.

## The evidence

| run | verified | tools | tokens | elapsed | lifecycle | handoffs |
|---|---|---|---|---|---|---|
| `…section3-glm-…-001` | no (`exit_1`) | 4/30 | **9,049/8,000** | 27s/60 | failed | 0 |
| `…paid-glm-…-002` | **yes (`exit_0`)** | 8/30 | **29,701/24,000** | 40s/180 | failed | 0 |
| `…paid-glm-…-003` | **yes (`exit_0`)** | 18/30 | 136,404/200,000 | **185s/180** | failed | 0 |

Runs `-002` and `-003` each recorded `verdict: completed`, `passed: true`,
`required_failed: []`, and a run `outcome: completed`. Both were then failed.

`-003` breached by **five seconds** — 2.8% over — after the model had finished,
the verifier had accepted, and `RunCompleted` had fired.

## The defect

`services/harness-dispatcher/src/reconcile-run.ts:473`:

```ts
if (projection.budget.exhausted) {
  return forceCancelTask(deps, task, harnessRunId, {
    lifecycle: "failed",
    decisionType: "dispatch_refusal",
    reason: "budget_exhausted",
    …
  });
}

const nextLifecycle = lifecycleForProjection(task.lifecycle, projection);
```

**The budget check runs before the terminal projection and pre-empts it.** It
never asks whether the run already finished. A run that completed, verified, and
went terminal is force-cancelled and failed on the same path as a live runaway.

Two consequences, and the second is the one that matters:

1. It **does not prevent the spend.** The tokens and seconds were already
   consumed when the check runs — it fires during reconciliation, after the fact.
2. It **destroys a correct result.** A verified, accepted piece of work is thrown
   away over an overrun that has already happened.

That is the worst of both. A live limit that halted the run would protect
something. A post-hoc check protects nothing and only loses output.

## 1. Deliverable D1 — a terminal run projects on its outcome

Gate the force-cancel on the run **not already being terminal**. Everything
needed is already carried by the projection: `run.terminal` (set from
`outcome !== undefined`, `harness-run-projection.ts:134`), `run.outcome`, and
`verification`.

- **Run still live and over budget** → force-cancel and fail, exactly as today.
  This is the case the check exists for.
- **Run already terminal** → project from the outcome, as `lifecycleForProjection`
  already does. A run that completed and verified reaches `handoff_ready`. A run
  that failed on its merits still fails, on those merits, not on the overrun.

This mirrors the shape #554 established for terminal projection: **resolve
terminal runs from the outcome first**, and let state-derived logic apply only to
non-terminal runs. The same defect class, in a different branch.

## 2. Deliverable D2 — the overrun is recorded, never silent

An overrun that no longer fails the task must not therefore vanish. It is a real
signal about a real run.

- Record it on the decision record for the handoff — which dimension, used, and
  limit.
- Keep the alert. Downgrade it from `critical` to something proportionate when
  the run completed successfully, but **do not remove it**: an operator should
  still learn that an approved budget was exceeded.
- The evidence bundle must be able to show, for any handoff, whether its run
  stayed inside budget.

Accepting the work and hiding the overrun would be a truth-boundary violation of
exactly the kind this repository keeps removing.

## 3. Deliverable D3 — name the dimension

The current alert says only *"The approved Harness budget was exhausted"*. Across
three ceremony runs I had to query the events and total the tokens by hand to
learn which of the three limits had actually been breached — twice concluding
the wrong one before checking.

The projection already carries `elapsedSecondsUsed/Limit`,
`modelTokensUsed/Limit`, and `toolCallsUsed/Limit`
(`agent-run-projection.ts:79-85`). The alert and the decision record must name
which dimension breached and by how much.

## 4. Deliverable D4 — prove each branch, by mutation

Four cases, each shown failing when its guard is removed:

| case | must produce |
|---|---|
| live run, over budget | force-cancelled, task `failed`, alert raised |
| terminal run, `outcome: completed`, verification passed, over budget | **`handoff_ready`**, overrun recorded |
| terminal run, failed verification, over budget | `failed` — on the verification, not the budget |
| terminal run, inside budget | unchanged from today |

The second row is the defect. It must be a test that fails against `main`.

## 5. What must not change

- **The fence.** Eight vetted capabilities, `network: deny`, path allowlist,
  non-delegating. Budget accounting contains nothing; the fence contains harm.
- **HALT.** Still cancels a live run and still wins over everything.
- **The INT-2 automated suite** — ten cases, count asserted in four places, cited
  evidence in the merged bundle. If a case must change, say so in the handback
  and explain why rather than editing it quietly.
- **`estimatedUsdMicros`** stays `null` and stays unenforced. Recording it as a
  control it is not is the defect this repo already fixed once.

## 6. Out of scope

Changing the budget *values* in any fixture · making the caps live limits that
halt a run mid-flight (a bigger change, and it belongs in the kernel, not here) ·
INT-3b actuation · anything touching the money rail, wallet, signer, claim or
submission paths.

## 7. Decisions

1. **Terminal runs project from their outcome; only live runs are cancelled for
   budget.** A completed run has already demonstrated it was not a runaway.
2. **The overrun is recorded and alerted, never silently dropped.** Accepting the
   work is not the same as pretending the budget held.
3. **The alert names the dimension.** Three ceremony runs' worth of manual
   forensics is evidence enough that "budget exhausted" alone is not actionable.
4. **The caps are not made live limits here.** That is the right long-term
   answer and it is a kernel change; this packet fixes the dispatcher discarding
   work it already accepted.

### Operator note

This unblocks the first real-model handoff, which is the gate on INT-3b's first
send. It does not authorise that send.
