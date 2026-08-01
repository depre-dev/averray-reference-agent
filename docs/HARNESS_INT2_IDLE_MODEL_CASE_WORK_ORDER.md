# INT-2 work order — a tenth suite case: the idle model is refused

> Work order, not an implementation. It closes the last gap in the evidence that
> authorizes the **paid** §3 run.

## Why this exists

§3 will not proceed until the git-based criterion is proven green *through the
containerized ceremony path*. The runbook names four conditions. CI currently
proves three:

| Condition | Proven in-container? | Evidence |
|---|---|---|
| clean non-empty diff → `exit_0` | ✅ | green / narrow / restart, ×6 |
| trailing whitespace → `exit_2`, offence named | ✅ | negative, ×2, `…PLAN.md:704: trailing whitespace` |
| neither `exit_128` nor `exit_129` | ✅ | `exit128Present: false` on all nine cases; no `exit_129` anywhere |
| **empty diff → `exit_1`** | ❌ | **only the host pre-flight** |

**The missing one is the case that matters most.** A real model that does nothing
useful is the single most likely outcome of a paid run, and `exit_1` is the
branch that catches it. We have proven git works inside the container; we have
not proven the empty-diff branch behaves there.

It can be *argued* that it must — `test -n "$(git diff --numstat)"` is shell
semantics, and git demonstrably runs. That argument is probably right. It is also
exactly the form of reasoning that produced eight checks in this effort that
could not fail, and this is the one place where being wrong costs money rather
than an afternoon.

## 1. Deliverable D1 — the case

A tenth suite case that stages a **model which writes nothing** and asserts the
criterion **refuses** it.

- **Script:** a new scripted model that makes **no tool call** — one turn, text
  only, `finish_reason: "stop"`. The existing kernel `finish.jsonl` is exactly
  this shape; a committed sibling under
  `test/fixtures/agent-integration/ceremony/` keeps the suite self-contained and
  is preferable to reaching into the pinned kernel's test fixtures.
- **Fixture:** propose **`lint-format`** — the §3 fixture, carrying the
  discriminating criterion `test -n "$(git diff --numstat)" && git diff --check`.

That pairing is the point: it exercises the **exact fixture and criterion the
paid run will use**, with a scripted idle model standing in for a real one. It is
the §3 dress rehearsal, and it costs nothing.

## 2. Deliverable D2 — what it must assert

Through the container, not the host:

- the criterion reason is **`exit_1`** — not `exit_0`, and not `exit_128`/`exit_129`;
- the verifier verdict is **failed**, with `format-command` in `required_failed`;
- the AgentTask lifecycle is **`failed`**;
- **zero** `handoff` decision records, exactly one `dispatch_approval`;
- the workspace patch is **empty or absent** — an idle model produces no change;
- `exit128Present: false`.

The first assertion is the deliverable. The rest guard against the case passing
for an unrelated reason.

## 3. Deliverable D3 — prove it can fail

Per the suite's existing `assertD3Mutation` pattern: mutate the recorded
criterion reason from `exit_1` to `exit_0` and require `verifyInt2Evidence` to
reject with a named failure. A case that has never been seen red is
indistinguishable from one that cannot go red.

## 4. Deliverable D4 — move the case count in all three places

`EXPECTED_CASE_COUNT` is asserted in three separate files, and CI enforces the
literal:

| File | Site |
|---|---|
| `test/integration/int2-automated-suite.test.ts:76` | `const EXPECTED_CASE_COUNT = 9` |
| `scripts/ceremony/run-int2-automated-suite.sh:167` | `test "$_int2_executed" = "9"` |
| `.github/workflows/ci.yml:131` | `… executed-count.txt') = "9"` |

**All three must become 10.** Miss one and either CI fails on a correct suite, or
— worse — the count check passes while asserting the wrong number, which is a
skip-detector that has stopped detecting.

Consider deriving the two shell literals from a single committed source so this
cannot drift again. If that is more churn than it is worth, say so in the
handback rather than leaving three hand-synchronised constants unremarked.

## 5. Definition of done

`npm run typecheck`, `npm test`, `npm run build` green from a clean checkout; the
INT-2 suite green at **10/10** through the real container path; the D3 mutation
recorded in `suite-summary.json`.

Handback records the observed `exit_1` evidence for the new case, the D3 mutation
and the failure it produced, and confirmation that all three count sites moved.

## 6. Out of scope

Changing the §3 criterion or fixture · relaxing any existing case · running the
paid §3 task · touching `lint-format-red` / `lint-format-green` or the recorded
§2.5/§2.6 proofs · any change to the money rail, wallet, signer, claim or
submission paths.

## 7. Decisions

1. **Use `lint-format`, not a new fixture.** The value is in exercising the
   criterion §3 will actually run. A bespoke fixture would prove something
   adjacent to the thing being authorized.
2. **Commit the idle script rather than reusing the kernel's `finish.jsonl`.**
   The suite should not depend on a pinned kernel's test fixtures, and a
   committed sibling can be asserted byte-stable like the others.
3. **The count must move in all three places, together.** This is the
   skip-detector; a stale literal there is worse than no literal.
4. **This closes the §3 authorization, it does not grant it.** With the fourth
   condition proven in-container, the runbook's container gate can be recorded as
   lifted — a separate, deliberate step, with the operator's go/no-go unchanged.
