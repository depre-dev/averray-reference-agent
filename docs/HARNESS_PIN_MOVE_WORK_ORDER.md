# Work order — move the Harness pin, without falsifying the record

> Small, mechanical, and carrying one trap that a find-and-replace walks straight
> into.
>
> `0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2` → `f010c993b0adfe55899b84a60777b0a4331fd972`

## Why

Kernel PR #32 fixed the executor discarding a completed model response on a
budget stop. Until the consuming repository pins a kernel containing it, the fix
is unreachable here, and
`docs/HARNESS_BUDGET_LIVE_PROOF_WORK_ORDER.md` stays unsatisfiable — no token cap
produces both an overrun and a valid handoff.

The new pin is two commits ahead: the fix and its merge. Nothing else changed.

## The trap

The old pin appears in **twelve places across eight files**, and they are not
the same kind of thing.

**Live sites select which kernel actually runs. Change these:**

| file | line |
|---|---|
| `scripts/ceremony/int2-bringup.sh` | 30 |
| `scripts/ceremony/int2-evidence.mjs` | 19 |
| `scripts/ceremony/run-int2-automated-suite.sh` | 84, 88 |
| `test/unit/int2-ceremony-scripts.test.ts` | 450, 505 |
| `docs/HARNESS_INT2_CEREMONY_RUNBOOK.md` | 36 |
| `AGENTS.md` | 260 |

**Historical records state what was run on a given day. Do NOT change these:**

| file | why |
|---|---|
| `docs/HARNESS_INT2_SCRIPTED_PROOFS_RESULT.md:4` | "passed on 2026-07-29 **on Harness pin** `0890a1f0`" — a claim about a run that happened |
| `docs/HARNESS_INT2_AUTOMATED_SUITE_HANDBACK.md:11,115,293` | a handback recording an executed suite, including verbatim log lines |
| `docs/HARNESS_KERNEL_BUDGET_PRESERVATION_WORK_ORDER.md:6` | names the revision the defect was found at |

Editing any of those would make merged evidence claim it ran on a kernel that did
not exist when it ran. **A sed across the repository does exactly that**, silently,
and the result still passes every test.

If a site's classification looks wrong, say so rather than following the table.
The table is my judgement and it is the part of this packet most worth checking.

## 1. Deliverable D1 — move the live sites

All eight, to the full forty-character sha. `AGENTS.md:260` uses the short form;
keep it short and consistent with its surrounding prose.

## 2. Deliverable D2 — leave the historical sites alone, visibly

Do not touch them. In the handback, list them and confirm they were considered
and deliberately skipped, so the next reader can tell a decision from an
oversight.

## 3. Deliverable D3 — prove the suite runs on the new kernel

The INT-2 suite checks out the pinned revision and refuses on mismatch
(`INT2_HARNESS_PIN_MISMATCH`, exit 25). Run the real container-backed suite and
report **11/11** — ten existing cases plus the eleventh if the budget live-proof
has landed by then, otherwise 10/10 and say which.

This is the packet's real acceptance test. Everything else is text.

## 4. Deliverable D4 — do not add a "pin matches kernel main" check

Tempting and wrong. The pin exists precisely so the consuming repository does
**not** follow kernel `main`. A check asserting they are equal would convert a
deliberate pin into a floating dependency the first time the kernel moves.

## 5. Out of scope

The budget live-proof case itself · any change to the executor or the kernel ·
re-opening the recorded INT-2 proofs · anything touching the money rail, wallet,
signer, claim or submission paths.

## 6. After this lands

`HARNESS_BUDGET_LIVE_PROOF_WORK_ORDER.md` becomes satisfiable as originally
written: with the kernel preserving text on a budget stop, a scripted case can be
both over budget and produce a valid handoff. Its addendum should then be
amended — not deleted — to record that the blocker was removed and by what.
