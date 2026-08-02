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
