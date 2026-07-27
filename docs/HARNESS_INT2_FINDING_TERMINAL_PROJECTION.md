# INT-2 finding — terminal Harness runs never advance the AgentTask projection

> **Status: product defect, proven by the local ceremony replay of 2026-07-27.** This supersedes
> the read-timeout explanation of the first ceremony's stuck projection. It is a work order for a
> fix, not a fix.

## What happened

The replay (`ceremony-local-lint-20260727-003`) dispatched cleanly and the Harness run reached a
terminal state:

```
run_id                               state               outcome  outcome_reason        attempt
e7a6dfb4-87dc-52c3-bc5a-0e9e2acf6710 learning_processed  failed   verification_failed   1
```

The AgentTask never advanced:

```
ceremony-local-lint-20260727-003  v1  running  ...  updated 2026-07-27 10:56:09+00
```

The dispatcher reported `reconciledCount: 1, unhealthyCount: 0` on every cycle — it believed it
was reconciling successfully — and the projection stayed `running` indefinitely.

**This is not the read timeout.** `HARNESS_DISPATCH_READ_TIMEOUT_MS` was 15000, reads completed,
reconciliation ran repeatedly and reported healthy. PR #550 fixed a real and separate concern; it
must **not** be reverted, but it did not address this, and this defect was mistaken for it.

## Root cause

`lifecycleForProjection` (`services/harness-dispatcher/src/reconcile-run.ts:718`) resolves the task
lifecycle **from `projection.run.state` alone**, matching against three hardcoded sets and four
literals, then falling through:

```ts
if (RUNNING_STATES.has(state)) return "running";
if (VERIFYING_STATES.has(state)) return "verifying";
if (state === "approval_required" || state === "suspended") return "blocked";
if (state === "completed") { /* consults verification */ }
if (state === "partial" || state === "failed" || state === "quarantined") return "failed";
if (CANCELLED_STATES.has(state)) return "cancelled";
return current;                     // ← every unlisted state lands here
```

**`learning_processed` and `learning_queued` appear in none of those sets or literals**, so both
fall through to `return current` and the task keeps whatever lifecycle it had.

This is not an edge case. In the Harness kernel (`contracts/run.py:67`):

```python
FINAL_STATES = frozenset({RunState.LEARNING_PROCESSED, RunState.CANCELLED})
RunState.LEARNING_PROCESSED: frozenset()      # no outgoing transitions
```

`learning_processed` is *the* terminal state for any run with `learning.episode_capture: true` —
which every ceremony fixture sets. A run that completes normally passes through `completed` and
then races on to `learning_processed`; whichever the dispatcher happens to observe decides whether
the task ever advances. **Any run observed after its learning tail sticks at `running` forever.**

This is the same trap the Harness CLI has, and it is already known kernel-side: terminal detection
must key off the run's **outcome**, not its state, precisely because runs race to
`learning_processed`.

## Why it survived

No test references `learning_processed` or `learning_queued` anywhere in
`services/harness-dispatcher/` or `packages/averray-mcp/`. The mapping's fallthrough branch is
untested for terminal states, so a state-name allowlist that silently omits the real terminal
state passes every existing check.

## The fix (shape, not implementation)

**Do not simply add the two names to a set.** That repeats the defect the next time the kernel adds
a state. The projection **already carries** the authoritative signal — `harness-run-projection.ts:134`
sets `terminal` from the outcome's presence:

```ts
run: {
  state: HarnessRunState,
  terminal: boolean,                 // = read.status.outcome !== undefined
  outcome?: "completed" | "partial" | "failed" | "cancelled",
  reason?: string,
}
```

Required behaviour:

1. **When `projection.run.terminal` is true, resolve the lifecycle from `run.outcome`**, not from
   `run.state`:
   - `completed` → `handoff_ready` if verification passed, else `failed` (preserving the existing
     verification consult);
   - `partial` / `failed` → `failed`;
   - `cancelled` → `cancelled`.
2. **State-name matching applies only to non-terminal runs** (progress reporting).
3. **A terminal run must never leave the task at its current lifecycle.** If a terminal projection
   cannot be resolved to a terminal lifecycle, that is an operator-visible alert and a refusal to
   silently continue — not a fallthrough.
4. `learning_queued` and `learning_processed` need no special-casing once (1) holds; verify that.

## Tests this needs

- A terminal projection at `learning_processed` for **each** outcome (`completed` + verification
  passed → `handoff_ready`; `completed` + verification failed → `failed`; `failed` → `failed`;
  `cancelled` → `cancelled`). This is the case the replay hit and nothing covers.
- The same at `learning_queued` with an outcome present.
- **A guard that bites:** assert that no terminal projection can return `current` — e.g. iterate
  every `HarnessRunState` with `terminal: true` and assert the resolved lifecycle is terminal.
  That is what stops the next added state from reintroducing this.
- Regression: the existing non-terminal mappings unchanged.

## Evidence

Retained at `~/int2-replay-20260727-full/evidence`: `harness-runs.txt`, `agent-tasks.txt`,
`dispatch-claims.txt`, `run-outbox.txt`, `decision-records.json`, `profile.yaml`,
`profile.sha256`, `harness-commit.txt`, `pilot-image-id.txt`, `pilot-base-image.txt`.

## What the replay also proved (keep these)

The defect above is the only failure. Everything else held:

- **Exactly-once end to end.** One Harness run, `attempt=1`, run id `e7a6dfb4-87dc-52c3-bc5a-0e9e2acf6710`
  — matching the `intendedRunId` printed at approval, which I re-derived independently as
  `sha256(workItemId \0 taskVersion \0 approvedTaskHash)` shaped as UUIDv5.
- **The approval binding is real.** `approvedTaskHash` recomputes from the canonical payload and
  `agentTaskApprovalHashMatches` returns true; containment (8 grants, `deny` network,
  `delegable: false`, `maxChildren: 0`, `docs/**`+`test/**` only, pinned base revision) was
  verified field-by-field and was byte-identical between `-002` and `-003`.
- **Refusals are fail-closed.** `-002` refused with `workspace_prep_failed` (from
  `dependency_cache_stale`) and created **zero** Harness runs, with one operator-visible alert.
- **The failed-verification path behaved.** The run failed verification as the `finish.jsonl`
  scripted fixture intends, and produced no handoff.

## Secondary finding — a runbook trap (docs only)

Runbook §1.4's export block sets `HARNESS_DISPATCH_DEP_CACHE_DIR` unconditionally, while line 206
states that `lint-format` "can run with `HARNESS_DISPATCH_DEP_CACHE_DIR` unset". Setting it to an
**empty** directory is worse than leaving it unset: `workspace-prep.ts:167` returns `"skipped"`
when the variable is absent, but demands an exact cache entry when it is present, so following
§1.4 literally and then running the lint fixture refuses with `dependency_cache_stale`. That cost
work item `-002`. The export block should either omit the variable or state the qualifier inline.
