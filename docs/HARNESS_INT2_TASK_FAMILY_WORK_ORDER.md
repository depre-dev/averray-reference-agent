# Work order — the task families that never ran, and the checks that never fired

> This looks like "add three more ceremony cases." It is not.
>
> Two of the three acceptance-criterion types in our contract have **never
> executed** against a real dispatcher. The only family ever wired uses
> `command` and nothing else.

## What is actually true

The evidence bundle names its own weakest clause: all four `handoff_ready` runs
this system has ever produced are the same task family, a formatting-only append
under `docs/**`. *"Satisfied in count, not in variety."*

Three more fixtures exist — `docs-fix.json`, `add-unit-test.json`,
`small-refactor.json` — written after the 2026-07-25 decision to cover four
families. **Nothing references any of them.** Zero hits across the suite and every
ceremony script.

| criterion type | exercised by the wired family |
|---|---|
| `command` | 5 uses |
| `search` | **never** |
| `baseline_comparison` | **never** |

So this packet is not about breadth of tasks. It is about two verification
mechanisms that have never run, in a system whose entire value is that its checks
actually fire.

## The blocker each family has

None of the three has a scripted-model `.jsonl`. `lint-format` has three
(`green`, `red`, `idle`); the others have none, so they cannot run
deterministically at all. Writing those scripts is the work, and each is harder
than the append:

| family | criteria | why it is harder than a formatting append |
|---|---|---|
| `docs-fix` | `npm run typecheck` + `search` | the search must land on an exact match count |
| `add-unit-test` | `npm test` + `baseline_comparison` | must add a test that passes **and** break nothing |
| `small-refactor` | `npm run typecheck` + `baseline_comparison` | must change behaviour-preserving code that still compiles |

A formatting append is the easiest case that exists: no imports, no compilation,
no semantics. These three touch all of it.

## 1. Deliverable D1 — settle the `search` semantics empirically

`docs-fix` asks for `expectedMatches: 1`, pattern `supervised`, include
`docs/**`. The kernel's implementation
(`agent_runtime/verification/checks.py:150-176`) globs the include patterns over
the workspace, sums **every regex match in every matching file's full text**, and
passes only on exact equality.

The current tree has **59 occurrences across 20 files** under `docs/`.

So the criterion cannot pass as written, and there are two candidate reasons:

1. the count is over the whole workspace, so `1` is simply the wrong number; or
2. `Path.glob("docs/**")` yields directories rather than files, so the count is
   `0` and `1` is unreachable for a different reason.

**Determine which by running it, not by reading.** The check reports
`detail=expected=N actual=M files=K` — that string settles it. Then fix the
fixture to match the real semantics, and say in the handback which of the two it
was.

Do not change the kernel. If the semantics turn out to be wrong rather than the
fixture, stop and say so — that is a kernel packet and a different conversation.

## 2. Deliverable D2 — a scripted model per family

One `.jsonl` per family, in the shape `lint-format-green.jsonl` already
establishes: tool calls, then a terminating text turn.

Each must genuinely satisfy its own criteria. **Do not weaken a criterion to make
a script pass.** If `add-unit-test` cannot produce a test that both passes and
leaves the baseline clean within the profile's `docs/**` + `test/**` allowlist,
that is a finding worth more than a green case.

## 3. Deliverable D3 — wire them, and move every count site together

Three new suite cases. The case count is asserted in **four** places, and they
have drifted apart before:

- `EXPECTED_CASE_COUNT` in the integration test
- the `INT2_CASES_STARTED expected=` line
- `test "$_int2_executed" = "N"` in the suite script
- the `= "N"` guard in `ci.yml`

The existing unit guard covering the count must be updated in the same commit.

## 4. Deliverable D4 — the budget risk in `baseline_comparison`

`no_new_failures` runs `baselineCommand: npm test` and then the post-change run.
That is the full suite — currently 2,600+ tests — **twice, inside the container**.

Measure it before assuming a budget. If the elapsed limit in either fixture is
too small, report the measurement and propose a value; do not quietly raise a cap
to make a case pass. The budget caps are a runaway ceiling, and moving one to fit
an observation is how a ceiling stops meaning anything.

## 5. Deliverable D5 — report what breaks

**This packet does not succeed by being green.** It succeeds by telling us what
happens when the machine meets a task that is not a formatting append.

Report, per family: the terminal lifecycle reached, the verification verdict with
each criterion's own result, and — where it failed — whether the cause was the
script, the fixture, the profile allowlist, the budget, or the product.

A handback saying *"two of three work, the third fails on the baseline check for
this reason"* is a better outcome than three green cases that were made green by
softening what they check.

## 6. What must not change

- **The kernel.** Read `checks.py` to understand semantics; change nothing there.
- **`reconcile-run.ts`, `pr-payload-actuator.ts`, `pr-payload-sender.ts`.** All
  gated and merged.
- **The existing eleven cases**, their fixtures, and their budgets.
- **The fence.** Eight vetted capabilities, `network: deny`, non-delegating,
  `docs/**` + `test/**` only.
- **The evidence bundle's clause five.** If this packet lands green, that clause
  becomes amendable — but amend it in a separate PR, with the runs cited, not as
  a side effect of this one.

## 7. Out of scope

§21.2 burn-in (≥3 families × ≥20 work items) · real-model runs · the INT-3 send ·
anything touching the money rail, wallet, signer, claim or submission paths.

## 8. Decisions

1. **Empirical before editorial.** The `search` semantics get settled by a run
   that prints `expected/actual/files`, not by reading the kernel and inferring.
2. **A red case is a result, not a failure.** The families were chosen because
   they are harder. Discovering that one does not pass is the information we are
   buying.
3. **No criterion is weakened, and no budget is raised, to produce green.** Both
   are the observation, not the obstacle.

### Operator note

Nothing here runs against a real repository or touches a credential. This is the
deterministic suite only, and it is independent of the first send — which should
still be the boring family, precisely because it is the boring family.
