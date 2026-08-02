# Kernel work order — a budget stop must not erase what the model produced

> **Implemented in `averray-agent/agent-harness`, not here.** This document lives
> with the finding chain that produced it; the change belongs in the kernel.
>
> Pinned revision under discussion: `0890a1f04c2729cbd310e21f66dd9dc6fbc66dc2`.

## The defect

`control/executor.py` checks the budget after each model turn and returns
immediately when a limit is hit — **before** the response it just received is
preserved:

```python
post_model_budget = budget_status(state)            # ~1079
if post_model_budget.terminated_by is not None:
    return _budget_result(state, post_model_budget) # state.final_text is still None
...
if result.text:                                     # ~1179 — never reached
    state = state.model_copy(update={"final_text": result.text, ...})
    return ExecutorResult(status="succeeded", state=state)
```

The model produced text. The kernel has it in hand. It throws it away and returns
a state that never saw it.

That matters downstream because `change_summary` **is** `final_text`:

```python
# control/deliverables.py:239
elif deliverable_type == "change_summary" and executor.state.final_text is not None:
    rendered[deliverable_type] = executor.state.final_text.encode("utf-8")
```

No preserved text → no change summary → a consumer that requires one refuses the
handoff. That is what the Averray dispatcher does, correctly, as
`verified_handoff_invalid`.

## Why this is worth fixing on its own merits

The consuming repository fixed the same defect one layer up in its PR #653: its
dispatcher was failing tasks whose work had already been **verified**, because
the run exceeded its budget. The check fired during reconciliation — after the
resources were spent — so it prevented nothing and destroyed a correct result.

This is that defect's twin. A budget stop should be a **stop**, not an
**erasure**. Terminating is right; discarding work already completed and paid for
is not, and it is not what makes the limit effective — the resources are gone
either way.

## 1. Deliverable D1 — preserve the response at the post-model stop

At the post-model budget check, if the turn produced text, preserve it before
returning:

```python
post_model_budget = budget_status(state)
if post_model_budget.terminated_by is not None:
    if result.text:
        state = state.model_copy(update={"final_text": result.text})
    return _budget_result(state, post_model_budget)
```

**The status must not change.** It stays `budget_stopped`, `terminated_by` still
names the dimension, and nothing pretends the budget held. The only difference is
that what the model produced survives the stop.

## 2. Deliverable D2 — decide the other two sites deliberately

`_budget_result` is reached from three places. They are not equivalent and should
not be changed by reflex:

| site | context | proposal |
|---|---|---|
| ~974 loop start | before this turn's model call | **nothing to preserve** — leave unchanged |
| ~1079 post-model | the response is in hand | **D1 — preserve** |
| ~1087 per-tool-call | model returned tool calls, possibly with accompanying text | **decide and say which** |

The third is the interesting one. A model that emits a preamble alongside tool
calls, then exhausts its budget partway through executing them, has produced
text that is arguably a partial summary of work partly done. Preserving it may be
right, or may be misleading — a change summary describing edits that were never
applied is worse than none.

Whatever is chosen, the handback must state the reasoning. Silence here would
leave the next reader unable to tell a decision from an oversight.

## 3. Deliverable D3 — cancellation is out of scope, and that is deliberate

`cancel_requested` discards identically (~969, ~1020). It is **not** part of this
packet.

Cancellation is HALT's mechanism, and HALT means *stop now*. Whether a halted run
should surrender partial deliverables is a safety question, not a
work-preservation one, and it deserves its own analysis rather than being swept
along. Do not change it here.

## 4. Deliverable D4 — prove it, both directions

- A run that exhausts its budget **after** producing text yields a state whose
  `final_text` is that text, with `status == "budget_stopped"` and
  `terminated_by` naming the dimension.
- A run that exhausts its budget **before** producing any text yields
  `final_text is None`, unchanged from today.
- `change_summary` is rendered for the first and absent for the second.
- Break the preservation line and confirm the first test fails. A guard nobody
  has broken is a guard nobody has verified.

## 5. What must not change

Budget enforcement itself — the run still stops, at the same point, on the same
dimensions. `status` stays `budget_stopped`. Verification, the deliverable
contract, and the run lifecycle are untouched. This is not a licence to complete
a run that exceeded its budget; it is a refusal to pretend the model said nothing.

## 6. Downstream, once this lands

The consuming repository's `HARNESS_BUDGET_LIVE_PROOF_WORK_ORDER.md` is currently
**unsatisfiable** because of this defect: no token cap produces both an overrun
and a valid handoff, so the fix in its #653 remains unit-proven and not
live-proven. Repinning to a kernel with this change makes that work order
satisfiable as originally written.

That is a consequence, not the justification. The justification is that the
kernel loses work it has already done.
