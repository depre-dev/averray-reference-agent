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
