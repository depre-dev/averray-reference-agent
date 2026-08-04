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

## 1. Deliverable D1 — RESOLVED 2026-08-04

> Settled by running the pinned evaluator, as asked. **Cause 2 was correct**, and
> both of my numbers were wrong.

```
include docs/**        expected=1 actual=0  files=0    ← glob yields directories
include docs/**/*.md   expected=1 actual=40 files=37   ← at the immutable base
```

`Path.glob("docs/**")` yields directories, which `is_file()` discards, so the
count is `0` and no `expectedMatches` value could ever have passed with that
include.

My "59 across 20 files" was doubly wrong: measured on the current tree rather
than the pinned task base, and with a glob that matches files rather than the
one the fixture actually uses. The measurement that counts is the one taken at
the base revision through the real evaluator.

**Change `docs-fix.json` to `include: ["docs/**/*.md"]` and
`expectedMatches: 41`** — 40 at base, plus the one the script adds.

## 1a. Deliverable D4 SUPERSEDED — `baseline_comparison` cannot run here at all

> Found by probing the compiler before writing anything. This is the real result
> of the packet, and it is worth more than three green cases.

```
manifest=False
code=invalid_baseline_command criterion=behavior
message=baseline_command must invoke pytest
```

`agent_runtime/verification/checks.py:184-195` accepts only `pytest`,
`pytest-*`, or `python -m pytest`, then **injects `--junitxml` and parses JUnit
XML**. It is not pytest-only by convention; it is pytest-only by construction.

`add-unit-test.json` and `small-refactor.json` both specify
`baselineCommand: "npm test"`, so the pinned kernel refuses their contracts at
compile time — correctly, and before dispatch. The criterion never executes, its
elapsed time cannot be measured, and no model script could satisfy it.

**So `baseline_comparison` is unavailable to this repository, in this language,
with this kernel — while `packages/schemas` advertises it as a supported
criterion type.** That gap is now recorded as its own issue. Two of the four task
families chosen on 2026-07-25 were unbuildable from the day they were written,
and nothing noticed because nothing wired them.

### The decision, so this is not read as weakening

`add-unit-test` and `small-refactor` are **redesigned, not softened**:

- replace the `baseline_comparison` criterion with `type: command`,
  `command: npm test`, `required: true`; and
- add a `search` criterion that asserts the intended artefact exists — for
  `add-unit-test`, the new test file; for `small-refactor`, the changed helper.

`command: npm test` is **stricter** than `no_new_failures`, not weaker: it
demands the whole suite pass, where the baseline rule would tolerate a failure
that also failed at base. It is a fair substitute here only because the suite is
green at base, and the fixture must say so in a comment rather than leave a
reader to assume the baseline semantics survived.

Do not reintroduce `baseline_comparison` anywhere. Do not change the kernel.

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

## 4. Deliverable D4 — the budget risk in running the suite

*(Rewritten 2026-08-04. The original assumed `baseline_comparison` would run it
twice; see §1a — it cannot run at all. The budget question survives, halved.)*

Both redesigned fixtures now run `npm test` **once** inside the container, over a
2,600-test suite.

Measure it before assuming a budget. If the elapsed limit in either fixture is
too small, report the measurement and propose a value, but **leave the cap
unchanged in the diff** and let me decide. The budget caps are a runaway ceiling,
and moving one to fit an observation is how a ceiling stops meaning anything.

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
4. **`baseline_comparison` is replaced, not softened.** *(added 2026-08-04)* It
   cannot execute against a Node repository on the pinned kernel at all. Its
   substitute — `command: npm test` — is stricter, and the fixtures say so
   rather than letting a reader assume the baseline semantics survived.
5. **The packet was right to be unsatisfiable.** *(added 2026-08-04)* It was
   written to find out what happens when the machine meets something harder than
   a formatting append. It found two of the four chosen families unbuildable
   from the day they were written, before a line of code was changed. Stopping
   was the correct handback, and it is worth more than three green cases.

### What this changes about the burn-in

§21.2 wants ≥3 task families. With `baseline_comparison` unavailable, the three
that remain reachable are `lint-format`, `docs-fix`, and the redesigned pair —
all resting on `command` plus `search`. **No criterion type that compares against
a baseline is available to this repository at all.** That is a real narrowing of
what the burn-in can claim, and it should be stated when the burn-in is planned
rather than discovered again there.

### Operator note

Nothing here runs against a real repository or touches a credential. This is the
deterministic suite only, and it is independent of the first send — which should
still be the boring family, precisely because it is the boring family.
