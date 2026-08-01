# Real-model completion experiment

> **Written before the run.** That is the whole point: a hypothesis recorded in
> advance is an experiment, and the same run decided on afterwards is a retry.
>
> This is not a second attempt at the §3 ceremony. §3's result stands as
> recorded, and nothing here amends it.

## Why this exists

The INT-2 evidence bundle rests on four runs that reached `handoff_ready` —
`green-002`, and suite cases *green*, *narrow*, *restart*. **All four used a
scripted model.**

The one real model this system has run, `glm-5.2` on 2026-08-01, exhausted its
budget on reconnaissance and never wrote. So the machinery is proven to *refuse*
a real model's work correctly, and has never been observed to *accept* it.

That gap matters going into INT-3b, which actuates verified work. Every piece of
verified work this system has produced came from a script.

## Hypothesis

> The 8000-token budget, not the model, was the binding constraint. Given a
> budget adequate for the reconnaissance this fixture requires, a real model
> completes the task and produces a verified handoff.

## What the measurement says

From the §3 run's recorded events:

| call | input | output | finish_reason |
|---|---|---|---|
| 1 | 1953 | 91 | `tool_call` |
| 2 | 2096 | 118 | `tool_call` |
| 3 | 2247 | 40 | `tool_call` |
| 4 | 2373 | 131 | `tool_call` |
| | **8669** | **380** | **9049 vs an 8000 cap** |

Two things follow. Input grows ~140 tokens per turn because the conversation
replays in full, so cost is superlinear in turn count. And every turn ended
`tool_call` — the model intended to continue at the moment it was cut off, which
is what makes "it ran out" a better reading than "it gave up".

Four turns of reading consumed the budget. A write plus a verification read is
two to three more turns at ~2500 input each, so completion needs roughly
16,000–19,000 tokens.

## The single variable

`lint-format-paid.json` is byte-identical to `lint-format.json` — same
repository, same `baseRevision`, same `allowedPaths`, same objective, same
discriminating criterion, same eight grants — except the budget:

```
elapsedSeconds   60  ->  180
modelTokens    8000  ->  24000
toolCalls        30  ->  30      (unchanged; 4 were used)
```

24,000 gives headroom over the ~19,000 estimate without being unbounded.

**On raising `elapsedSeconds` too.** Tokens were demonstrably the binding
constraint — the run used 27 s of its 60 s. Elapsed is raised *precautionarily*,
because more turns necessarily take longer and leaving it at 60 s would risk
substituting one budget failure for another, which would not test the
hypothesis. It is a second changed value and is recorded as one rather than
hidden.

## What each outcome means

**Verified handoff.** The hypothesis holds. The bundle's weakest gap closes: a
real model has produced work this system accepted, through the same fence, with
zero handoffs on failure still proven separately. Record it as an addendum to
the bundle — not a rewrite of §3.

**`exit_1` again, budget not exhausted.** The hypothesis is refuted. The model
had room and still did not write, which points at the model or the objective's
phrasing rather than the budget. That is a more interesting finding than success
and must not be explained away.

**Budget exhausted again at 24,000.** The fixture, not the budget, is the
problem: a task that obliges a model to read a large document before appending
to it may simply be a poor shape for a bounded ceremony. That would argue for
changing the fixture, and would need saying out loud rather than raising the
number a third time.

**Anything else** — `exit_128`, a container fault, a stuck run — is an
infrastructure result and says nothing about the hypothesis.

## Rules

**One shot, again.** The one-shot rule is not about money; it is about not
selecting the result you liked. If this run fails, that is the finding, and a
third run needs a new hypothesis and a fresh decision — not a bigger number.

**§3's record is immutable.** Nothing here edits `HARNESS_INT2_EVIDENCE_BUNDLE.md`
or the §3 evidence. This is an addendum.

**The scripted proofs are untouched.** No change to `lint-format.json`,
`lint-format-green.json`, `lint-format-red.json`, `lint-format-idle.jsonl`, or
the INT-2 suite, whose case count is asserted in four places and which is cited
evidence.

## Out of scope

Changing the criterion or the objective · relaxing the fence · opening a PR ·
anything touching the money rail, wallet, signer, claim or submission paths ·
re-running to improve a result.

---

# Addendum — the second run, and an operator decision that supersedes the hypothesis

## What the second run showed

**The model completed the task and the verifier accepted it.**

```
call 8:     cat >> docs/HARNESS_INT2_SUPERVISED_DISPATCH_PLAN.md << 'PARA_EOF'
criterion:  passed=True   reason=exit_0   required_failed: []
run:        outcome=completed
```

The original hypothesis — that the budget, not the model, was the binding
constraint — is **confirmed on its substance**. Given room, `glm-5.2` reads the
file, writes the paragraph, and produces work this system verifies.

It still ended `lifecycle=failed` with **zero handoffs**, because it used 29,701
of 24,000 approved tokens.

## The result that mattered more than the hypothesis

| dimension | used | approved | breached |
|---|---|---|---|
| `elapsedSeconds` | **40s** | 180 | no |
| `toolCalls` | **8** | 30 | no |
| `modelTokens` | **29,701** | 24,000 | **yes** |

The run sat at roughly a quarter of both *predictable* limits and breached only
the one nobody can predict. My 24,000 estimate was derived from measured data
and was still 24% low, because context growth is driven by tool-output size
rather than turn count — input jumped from 2,450 to 6,145 in a single step when
a large read landed.

## The decision

**The token cap is not a per-task budget. It is an absolute runaway ceiling.**

Made by the operator on the evidence above. Three reasons it holds:

1. **Token cost per task is not knowable in advance.** Two attempts to size it
   from measurement were both wrong. `elapsedSeconds` and `toolCalls` are
   estimable — "under three minutes, under thirty actions" — and tokens are not.
2. **It is the wrong unit for cost.** Money is the unit, and on a capacity-tier
   provider there is no per-token money to cap at all.
3. **It does not bound harm.** An agent holding `fs.write_file` and `shell.run`
   can do everything it is capable of doing in very few tokens. Blast radius is
   contained by the capability fence — eight grants, `network: deny`, path
   allowlist, non-delegating — not by token accounting.

`modelTokens` moves to **200,000**: about 7× a completing run, and below the
~450,000 a pathological thirty-call run with large outputs could reach. It
should never bind on legitimate work, and it still stops an agent that has
genuinely lost control. `elapsedSeconds` and `toolCalls` remain the operative
limits, and both were already doing the containment work.

## Why this is not "raising the number because we did not like the result"

That distinction matters, and the record should carry the reasoning rather than
the assertion.

A retry raises the number so the same measurement passes. This changes what the
number *is for*, on evidence that the previous framing was measuring something
unknowable: the run breached **only** the unpredictable dimension while idling
inside both predictable ones. Had it breached `elapsedSeconds` or `toolCalls`,
the honest conclusion would have been that the task is too big for the fence —
and nothing here would have changed.

## Still open

No real model has yet produced a **handoff**. Verified work, yes; a handoff, no.
The operator has gated INT-3b's first real send on closing that gap.
