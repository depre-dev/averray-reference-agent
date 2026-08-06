# INT-4d drill run record — 2026-08-06

This file is append-only for the packet's disposable drill attempts. A failed
instrument run remains visible beside its corrected rerun.

## Run 1 — instrument failure before environment start

Command: `HARNESS_CHECKOUT=<detached exact-pin checkout> node
scripts/ceremony/run-int4d-drills.mjs`

Observed:

```text
Error: INT4D_HARNESS_PIN_UNAVAILABLE
```

No Postgres container or Harness worker started. Directly running the same
`git checkout --detach 3355f4906864b0f0e0fe5fd5eb5220172e174206` in the
supplied checkout exited 0. The instrument defect was that the runner always
issued a redundant checkout even when the supplied worktree was already clean
and exactly pinned, then discarded Git's error detail. The correction first
reads and accepts an exact HEAD; checkout is attempted only when HEAD differs,
and any checkout failure now retains bounded stderr. The correction is
committed before Run 2 under the protocol's instrument-defect rule.

## Run 2 — environment live, two instrument defects

The corrected runner verified the exact kernel pin and started both disposable
Postgres containers. Four records were green:

```text
INT4D_D0_POLICY_SILENCE recorded_hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc active_hash=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee heartbeat_cycle=3 loop_status=idle decisions=0 alerts=0 observation=nothing_read_active_policy
INT4D_DRILL_GREEN board-outage execution_continued=true replay_cards=1 control_writes=0 lifecycle=handoff_ready detection_ms=26
INT4D_DRILL_GREEN policy-drift pre_submit=refused approved_hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc active_hash=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee bound_lifecycle=running bound_cancelled=false warn_alerts=1 status_active=true detection_ms=36
INT4D_DRILL_GREEN malicious-oversized quarantine=poison_read cycles=3 sentinel_in_sink=false pilot_available=true watchdog_available=true detection_ms=24
```

Two probe assertions failed:

```text
AssertionError: expected [ { severity: 'warn', …(6) } ] to have a length of +0 but got 1
error: relation "runs" does not exist
```

The duplicate-event fixture used a one-hour status span and therefore triggered
the product's legitimate terminal budget warning. Its correction uses a
one-minute span, inside the unchanged fixture budget. The worker probe invoked
a pytest fixture whose session teardown intentionally removes `runs` and
`domain_events`; the outer counter therefore had no store left to inspect. Its
correction runs the same pinned kernel support directly, waits for a durable
`CapabilityCompleted` followed by an in-flight call, sends SIGKILL, starts the
replacement worker, and leaves the disposable store intact for the mandated
effect count. Neither correction changes production behavior or an acceptance
criterion.

## Run 3 — mutation reached the sink; assertion output was unbounded

The `disable-size-gate` mutation was applied and the malicious-output drill
failed on `INT4D_OVERSIZED_SENTINEL_REACHED_ADAPTER_SINK`, but Vitest rendered
the complete 300 KB synthetic payload in its assertion diff. The red therefore
proved the path but produced unusable evidence output. The assertion is changed
to compare the derived boolean `sentinelReachedAdapterSink`; it still fails only
when the sentinel reaches the adapter sink, while its diagnostic is bounded to
`true` versus `false`. This instrument-only correction is committed before the
mutation is rerun.

## Run 4 — corrected complete matrix

```text
INT4D_MATRIX_VALID executed=5 cited_ci=13 deferred=4 total=22
INT4D_D0_POLICY_SILENCE recorded_hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc active_hash=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee heartbeat_cycle=3 loop_status=idle decisions=0 alerts=0 observation=nothing_read_active_policy
INT4D_DRILL_GREEN duplicate-event lifecycle=handoff_ready bindings=1 handoff_decisions=1 alerts=0 duplicate_events=2 out_of_order=true detection_ms=35
INT4D_DRILL_GREEN worker-kill run_id=e77e6815-4c58-4426-bea4-c413d7d1aa27 terminal_state=learning_processed capability_completion_rows=2 duplicate_invocations=0 watchdog_gap_alert=true detection_ms=20835
INT4D_DRILL_GREEN board-outage execution_continued=true replay_cards=1 control_writes=0 lifecycle=handoff_ready detection_ms=29
INT4D_DRILL_GREEN policy-drift pre_submit=refused approved_hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc active_hash=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee bound_lifecycle=running bound_cancelled=false warn_alerts=1 status_active=true detection_ms=35
INT4D_DRILL_GREEN malicious-oversized quarantine=poison_read cycles=3 sentinel_in_sink=false pilot_available=true watchdog_available=true detection_ms=19
Test Files  1 passed (1)
Tests  6 passed (6)
```

The worker-kill effect count is defined by the Harness Postgres event store:
one protected effect is one `domain_events` row with
`event_type='CapabilityCompleted'`, grouped by `payload->>'invocation_id'`.
The green run recorded two distinct completed invocations and no group with a
count greater than one.

## Drill mutation proofs

Each mutation printed its applied marker before the assertion failed. Removing
the mutation restored the named green record.

```text
INT4D_MUTATION_APPLIED=non-idempotent-projection
INT4D_DUPLICATE_DECISION_COUNT: expected [ … ] to have a length of 1 but got 2
Expected: 1
Received: 2
INT4D_DRILL_GREEN duplicate-event lifecycle=handoff_ready bindings=1 handoff_decisions=1 alerts=0 duplicate_events=2 out_of_order=true detection_ms=57
```

```text
INT4D_MUTATION_APPLIED=duplicate-worker-effect
INT4D_PROTECTED_EFFECT_DUPLICATED: expected [ { …(2) } ] to deeply equal []
Received:
{ "count": 2, "invocation_id": "executing/turn-1/tool-1/fs.write_file/1" }
INT4D_DRILL_GREEN worker-kill run_id=42a91e72-a6c5-4453-bab6-ffe8fae9dcfa terminal_state=learning_processed capability_completion_rows=2 duplicate_invocations=0 watchdog_gap_alert=true detection_ms=20431
```

```text
INT4D_MUTATION_APPLIED=board-replay-write
INT4D_BOARD_READ_PATH_WROTE_CONTROL_STATE: expected 'b271851c1b17d5735d0be39ffc89df69a0d086fecd4336d0588dd14e8fe1b15e' to be '9687982d120709c7ec1c21fb17022b6280e554919dbeb7daab2ba7bf20ed0c7f'
INT4D_DRILL_GREEN board-outage execution_continued=true replay_cards=1 control_writes=0 lifecycle=handoff_ready detection_ms=52
```

```text
INT4D_MUTATION_APPLIED=skip-policy-recheck
expected { outcome: 'dispatched', … } to match object { outcome: 'refused', reason: 'policy_drift' }
Expected: refused / policy_drift
Received: dispatched
INT4D_DRILL_GREEN policy-drift pre_submit=refused approved_hash=sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc active_hash=sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee bound_lifecycle=running bound_cancelled=false warn_alerts=1 status_active=true detection_ms=49
```

```text
INT4D_MUTATION_APPLIED=disable-size-gate
INT4D_OVERSIZED_SENTINEL_REACHED_ADAPTER_SINK: expected true to be false
Expected: false
Received: true
INT4D_DRILL_GREEN malicious-oversized quarantine=poison_read cycles=3 sentinel_in_sink=false pilot_available=true watchdog_available=true detection_ms=43
```

## Matrix-runner mutation proofs

```text
INT4D_MATRIX_MUTATION_APPLIED=citation-drift
Int4dMatrixError: INT4D_CITATION_DRIFT row=dispatcher-crash-before-submit case=takes over after-claim-before-submit with one derived Harness run renamed
```

```text
INT4D_MATRIX_MUTATION_APPLIED=delete-deferral-reason
Int4dMatrixError: INT4D_DEFERRED_FIELD_MISSING row=verifier-outage field=reason
```

```text
INT4D_MATRIX_MUTATION_APPLIED=drop-owner
Int4dMatrixError: INT4D_MATRIX_FIELD_MISSING row=dispatcher-crash-before-submit field=owner
```

```text
INT4D_MATRIX_MUTATION_APPLIED=fake-proven
Int4dMatrixError: INT4D_EVIDENCE_MISSING row=averray-outage source=cited-ci
```
