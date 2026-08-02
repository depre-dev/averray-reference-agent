# Work order — prove the budget fix against a real run

> Small packet. #653 is unit-tested and the tests are real — all four D4 rows
> fail against pre-fix `main`. But **nothing has exercised the fix through the
> actual dispatcher, a real Harness run, and a real container.**

## Why this exists

The first real-model handoff landed on 2026-08-02
(`ceremony-paid-glm-20260802-004`), and it proves less about #653 than it looks:

```
toolCalls    13 / 30        no breach
modelTokens  72,422 / 200,000  no breach
elapsed      86s / 180      no breach
```

That run stayed inside **all three** limits, so the pre-fix code would have
produced the same handoff. What differed from `-003` was model behaviour — 13
calls in 86s versus 18 in 185s — not the fix.

So the fix's live behaviour is still unobserved. Every over-budget run this
system has ever seen was under the old code, and every run under the new code
has been within budget. The one case that matters — **terminal, verified, over
budget → `handoff_ready`** — has never happened for real.

## 1. Deliverable D1 — an eleventh suite case

A scripted case that **completes its work successfully and overruns its budget**,
asserting the outcome is preserved.

- Reuse the existing `runScriptedTerminalCase` machinery — this is the same
  real dispatcher, real Postgres, pinned Harness, Docker-isolated shape as the
  other ten.
- The scripted model does the same append the green case does, so the criterion
  genuinely returns `exit_0`.
- The fixture carries a budget small enough that a successful run necessarily
  exceeds it. `modelTokens` is the easiest dial: the green case's own recorded
  usage is the measurement, so set the cap below it deliberately.

Assert: lifecycle **`handoff_ready`**, exactly one `handoff` decision,
`budget_status=exhausted` with the dimension named, the run **not** cancelled,
and a `warn` alert rather than `critical`.

## 2. Deliverable D2 — the count moves in all four places, together

Adding a case moves `EXPECTED_CASE_COUNT` and three shell/YAML literals:

| file | site |
|---|---|
| `test/integration/int2-automated-suite.test.ts:78` | `EXPECTED_CASE_COUNT = 10` |
| `scripts/ceremony/run-int2-automated-suite.sh:289` | `INT2_CASES_STARTED expected=10` |
| `scripts/ceremony/run-int2-automated-suite.sh:298` | `test "$_int2_executed" = "10"` |
| `.github/workflows/ci.yml:131` | `executed-count.txt') = "10"` |

All four become 11. Miss one and either CI fails on a correct suite or — worse —
the skip-detector asserts the wrong number and stops detecting. The existing
unit invariant already guards this; it will need its literals moved too.

## 3. Deliverable D3 — amend the bundle, do not rewrite it

`HARNESS_INT2_EVIDENCE_BUNDLE.md` says the suite has **10 cases**. That was true
when the operator accepted it and must stay legible as such.

Add a short dated note recording that the suite grew to 11 and why — not an edit
that makes the original claim disappear. A bundle that silently updates its own
numbers is worth less than one that shows what changed after acceptance.

## 4. Deliverable D4 — prove it can fail

Per the suite's `assertD3Mutation` pattern: mutate the recorded lifecycle from
`handoff_ready` to `failed` and require `verifyInt2Evidence` to reject with a
named reason. A case that has never been seen red is indistinguishable from one
that cannot go red.

Additionally, and this is the point of the packet: **the new case must fail
against pre-fix `reconcile-run.ts`.** Verify it the way the #653 gate did —
revert only that file, keep the new test, confirm the case goes red. If it
passes both ways it is not testing the fix.

## 5. Out of scope

Changing any budget value in `lint-format.json`, `lint-format-green.json`,
`lint-format-red.json`, or `lint-format-paid.json` · another paid real-model run ·
making the caps live limits (kernel work) · INT-3b actuation · anything touching
the money rail, wallet, signer, claim or submission paths.

## 6. Decisions

1. **A scripted case, not a paid one.** The behaviour under test is the
   dispatcher's, not the model's. Spending money to observe it would be waste.
2. **It lives in the INT-2 suite, not a new one.** This is INT-2 dispatcher
   behaviour and belongs with the other ten, re-proving itself on every PR.
3. **The bundle is amended, never rewritten.** Acceptance happened at ten; the
   record should keep saying so.

---

# Addendum — the packet is unsatisfiable with the pinned kernel, and why that is itself a finding

**Status: not implemented. Superseded by the finding below.**

Codex attempted this and stopped rather than weaken the handoff invariant. That
was the correct call, and the reason is worth more than the case would have been.

## What was tried

The green script measures exactly **7 model tokens**. With the cap set to 6:

- normal reconciliation correctly cancelled the still-live run;
- deferring reconciliation until terminal produced a completed, verified run and
  the correct warning — `model_tokens used=7 limit=6 over_by=1`;
- **but** Harness omitted `change_summary`, so the dispatcher correctly refused
  the handoff as `verified_handoff_invalid` and set lifecycle `blocked`.

So with this kernel:

```
cap <= 7  ->  token exhaustion, no change summary, no valid handoff
cap >  7  ->  valid handoff, no budget exhaustion
```

There is no value that produces both.

## Why: the kernel discards completed work on budget termination

`control/executor.py` computes `budget_status(state)` after each model turn and
returns immediately when `terminated_by` is set — **before** the response becomes
`final_text`. The work is done and then thrown away.

**That is the same defect this repository just fixed one layer up.** #653 stopped
the *dispatcher* discarding a verified run because its budget was exceeded; the
*kernel* discards a completed model response for the same reason. Same shape,
different layer.

That reframes what "fix the kernel" means here. It is not a change made so a test
can pass. It is a real defect on its own merits, and the live proof becoming
available is a side effect of fixing it.

## Why the elapsed path was not taken instead

`terminated_by` covers `model_tokens | tool_calls | elapsed | max_turns`, so
elapsed short-circuits the same way — *during* execution. But the real defect ran
`-003`, and its recorded timings show the overrun happened **after** the executor
finished:

```
run start              0s
last ModelResponded  181s   <- executor loop finished, final_text produced
VerificationCompleted 184s
last event           185s   <- what the dispatcher measures
```

Verification pushed the run past its limit. That is the only shape where a valid
handoff and a budget overrun coexist, and reproducing it deliberately means
threading a window: the executor must finish *under* the limit while verification
pushes *over* it. On a scripted local run that is roughly 2s of executor against
3s of verification; on a loaded runner it inverts and the executor is truncated
instead.

This repository spent 2026-08-01 removing a fixture that raced a kernel constant
by ~10ms. Deliberately reintroducing that class to obtain a green check would be
a bad trade.

## Where that leaves #653

Unit-proven, not live-proven, and the record should say so rather than imply
otherwise. The tests are real — all four D4 rows fail against pre-fix `main`,
verified by reverting only `reconcile-run.ts` and keeping the new tests — but no
run has exercised the fixed path end to end, and none can until the kernel stops
discarding the work.

The gap is acknowledged rather than closed. That is a worse outcome than a live
proof and a better one than a flaky test.

## Next

A kernel packet in `averray-agent/agent-harness`: a budget-terminated run should
retain the response it had already produced. Once that lands and the pin moves,
this work order becomes satisfiable as originally written and should be revisited
rather than deleted.
