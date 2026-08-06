# INT-4b quarantine and orphan drills — 2026-08-06

The reference-side drills used two throwaway local Postgres 16 containers and
the production dispatcher, store, watchdog, and watchdog SQL probes. The
kernel audit used a real local Docker lifecycle container. No production
database, production Compose profile, credential, external sink, or repository
was used.

The pre-change silences are recorded separately in
[`INT4B_D0_SILENCE_2026-08-06.md`](INT4B_D0_SILENCE_2026-08-06.md).

## Reference-side green run

Command:

```sh
node scripts/ceremony/run-int4b-drills.mjs
```

Observed after every mutation was removed:

```text
INT4B_DATABASE_LIVE boundary=reference container=int4b-reference-96869-1785995393998
INT4B_DATABASE_LIVE boundary=harness container=int4b-harness-96869-1785995393998
INT4B_DRILL_GREEN poison-quarantine marker=durable cycles=3 critical_alerts=1 poison_reads=3 other_reads=4
INT4B_DRILL_GREEN quarantine-restart marker=honored post_restart_reads=0 retry_storm=false
INT4B_DRILL_GREEN transient-not-poison outage_cycles=4 quarantine=false resumed=true heartbeat_cycle=5
INT4B_DRILL_GREEN conflicting-binding dispatcher_marker=present watchdog_alert=critical actual=00000000-0000-5000-8000-000000000099 intended=82bfa207-88d1-5348-91f0-d2964f021c3d
INT4B_DRILL_GREEN orphan-pair task_without_run=warn run_with_terminal_task=warn deduplicated=2 age_gate=fresh_excluded
Test Files  1 passed (1)
Tests  5 passed (5)
```

Four separate restored runs produced the same five green evidence lines and
`5 passed (5)`, one immediately after each mutation run.

## Mutation reds

Each command printed `INT4B_MUTATION_APPLIED` from the exercised code before
the named assertion failed.

Timestamp in poison fingerprint:

```text
INT4B_MUTATION_APPLIED=timestamp-fingerprint
AssertionError: INT4B_POISON_MARKER_MISSING: expected undefined to match object { Object (reason, cycleCount) }
Test Files  1 failed (1)
Tests  1 failed | 4 passed (5)
```

Skipped durable marker write:

```text
INT4B_MUTATION_APPLIED=skip-marker-write
AssertionError: INT4B_RESTART_MARKER_NOT_DURABLE: expected undefined to be defined
Test Files  1 failed (1)
Tests  1 failed | 4 passed (5)
```

Transient failures incorrectly counted:

```text
INT4B_MUTATION_APPLIED=count-transient
AssertionError: INT4B_NEGATIVE_DRILL_TRANSIENT_WAS_QUARANTINED: expected { workItemId: 'int4b-transient', …(5) } to be undefined
Received: Object {
  "cycleCount": 3,
  "reason": "poison_read",
  "workItemId": "int4b-transient",
}
Test Files  1 failed (1)
Tests  1 failed | 4 passed (5)
```

The negative drill detects the forbidden action by reading the durable marker
after four transient cycles and requiring it to be absent. The mutation reached
threshold on cycle three, so the marker made the otherwise silent negative case
fail by name.

One orphan class dropped:

```text
INT4B_MUTATION_APPLIED=drop-orphan-class
AssertionError: INT4B_ORPHAN_CLASS_MISSING: expected [ { schemaVersion: 1, …(5) } ] to have a length of 2 but got 1
Test Files  1 failed (1)
Tests  1 failed | 4 passed (5)
```

## Kernel audit

The independent kernel change was committed as
`37ff6f5b799ed487215d3ad5d17a6024c071dc41`. Its real Docker lifecycle proof
printed:

```text
CONTAINER_AUDIT_GREEN listed=1 labels=valid run_id_match=true
CONTAINER_AUDIT_GREEN finally_remaining=0
1 passed in 14.21s
```

Its offline gate completed with `574 passed, 198 skipped`; its disposable
Postgres acceptance run completed with `54 passed, 718 deselected`. The
acceptance database container was absent from `docker ps --all` after the
command's cleanup trap.
