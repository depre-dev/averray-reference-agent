# INT-2 green-path work order — exercise `handoff_ready` before acceptance

> Work order, not an implementation. It closes the last coverage gap standing between the INT-2
> evidence bundle and acceptance.

## Why this exists

Every run in the 2026-07-27 ceremony ended `verification_failed`, because the scripted fixture the
runbook prescribes writes nothing:

```json
{"thinking":"No workspace changes appear necessary.","text":"No workspace changes were required.",
 "usage":{"input_tokens":1,"output_tokens":1,"requests":1},"finish_reason":"stop"}
```

That is a **legitimate proof** — runbook §2.5, "intentional failed verification produces no
handoff" — and it should be kept. But it means the ceremony has proven only how the pipeline
handles *failure*. **`handoff_ready` has never been reached live.** No run has produced a
`VerifiedHandoff`, and `eligibleForPrOpen` has never been evaluated against real evidence.

For a supervised-dispatch gate, that is the wrong half to have proven. The failure path refusing
correctly is necessary; the success path producing a correct, attenuated, verified handoff is what
a pilot actually depends on.

**This is a gap in ceremony design, not in the product.** Nothing here implies a defect.

## The key constraint: do not touch the pinned kernel

`HARNESS_TEST_MODEL_SCRIPT` is an **environment path** (`control/executor.py:322-343`), so the
ceremony supplies its own script file. **The Harness pin stays at `be55b34` and no kernel fixture
is added or modified.** Author the new script under the ceremony root, alongside the profile.

## 1. Deliverable D1 — a scripted model that actually writes

A JSONL script, one `ScriptedTurn` per line (`cognition/_scripted.py:34`), shaped like the existing
`attenuation_abuse.jsonl` write pattern:

```json
{"tool_calls":[{"id":"...","name":"fs_write_file","arguments":{"path":"...","content":"..."}}],
 "usage":{"input_tokens":2,"output_tokens":1,"requests":1},"finish_reason":"tool_call"}
{"text":"...","usage":{"input_tokens":2,"output_tokens":2,"requests":1},"finish_reason":"stop"}
```

Requirements, each of which is load-bearing:

- **Write inside the allowlist only** — `docs/**` or `test/**`. A write outside it must not be
  attempted; the containment proof is a *separate* case (§2.4) and must not be entangled here.
- **The written content must pass `git diff --check`** — the `lint-format` acceptance criterion.
  That means no trailing whitespace, no space-before-tab, and a trailing newline. A green fixture
  that fails on whitespace would look like a product failure and waste a work item.
- **Stay inside the budget**: 30 tool calls, 8 000 model tokens, 60 s. Two turns is ample.
- **Deterministic**: the same script must produce the same patch on every run, so the ceremony can
  be repeated and the evidence compared.

Consider whether the existing `lint-format` fixture is the right vehicle or whether a sibling
(`lint-format-green`) is cleaner. **Recommendation: a sibling.** `lint-format` + `finish.jsonl` is
the §2.5 negative proof and should keep working exactly as it does; a second fixture avoids
overloading one work item with two contradictory expectations.

## 2. Deliverable D2 — verify what the green path actually produces

Reaching `handoff_ready` is necessary but not sufficient. The ceremony must show the handoff is
**correct**, not merely present:

- the AgentTask reaches **`handoff_ready`** (not `failed`, not stuck) and is bound to the intended
  run id;
- a **`VerifiedHandoff`** is constructed, and `eligibleForPrOpen` is evaluated — record its value
  and the reason;
- the `workspace_patch` deliverable is **non-empty** and touches **only** allowlisted paths;
- `runManifestRef`/`runManifestHash` are present and consistent (they are the post-hoc record of
  what actually ran);
- **no pull request is opened and no GitHub mutation occurs.** The pilot CLI never actuates, and
  this ceremony must not either. If the green path can open a PR, that is a finding — stop and
  report it rather than letting it happen.
- exactly one run, `attempt=1`, one decision record, one outbox entry — the same exactly-once
  invariants the failure path already demonstrated.

## 3. Deliverable D3 — runbook integration

Add the green case to `HARNESS_INT2_CEREMONY_RUNBOOK.md` §2 alongside the existing safety proofs,
with its own work-item id, and state plainly that **§2.5's negative proof and this positive proof
are both required** for acceptance. Note the script path convention and that it lives under the
ceremony root, not in the pinned kernel.

## 4. Out of scope

Any change to the Harness kernel or its pin · any change to `finish.jsonl` or the existing
`lint-format` fixture's behaviour · opening a real pull request · the `docs-fix`,
`add-unit-test`, and `small-refactor` fixtures (they need the offline dependency cache; this one
must not) · relaxing any acceptance criterion to make the run pass.

## 5. Definition of done

Gates green from a clean checkout; the new script is committed under the ceremony fixtures with its
own tests where the repo has them; the runbook documents the case. Handback records the exact
script contents, the resulting patch, the terminal lifecycle, the `eligibleForPrOpen` value and
reason, and confirmation that no GitHub mutation occurred.

**If the green path cannot reach `handoff_ready`, do not adjust the acceptance criterion to force
it.** Stop and report what blocked it — that would be a finding about the pipeline, which is
exactly what this exercise is for.

## 6. Decisions

1. **The ceremony supplies its own scripted model; the kernel pin does not move.**
   `HARNESS_TEST_MODEL_SCRIPT` is an env path, so this needs no kernel change and keeps the
   ceremony's Harness identity stable across the whole evidence bundle.
2. **A sibling fixture, not a modified one.** The negative proof is real evidence and must keep
   working; one work item should not have to mean two opposite things.
3. **`handoff_ready` alone is not the proof.** The handoff must be inspected — non-empty patch,
   allowlisted paths only, manifest present, `eligibleForPrOpen` recorded, and demonstrably no
   actuation. "It went green" without those is the kind of result that looks like success and
   proves little.
4. **No criterion is relaxed to achieve green.** If the pipeline cannot produce a verified handoff
   from a correct change, that is the finding.
