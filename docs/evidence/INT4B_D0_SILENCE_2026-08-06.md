# INT-4b D0 silence baseline — 2026-08-06

This baseline ran before the INT-4b mechanisms against the exact unmodified
reference-agent `main` revision
`39ab2b486659819b254e521359990694f25a3392`. It used two throwaway local
Postgres containers and the production dispatcher process/reconciliation
functions from that revision. No production database, Compose project,
credential, or external sink was used.

The probe stored the malformed Harness status, the tampered dispatching-state
binding, the missing run, and the live run for a terminal task in the two
databases. Both authenticated database readiness probes passed. The three
different dispatcher heartbeat timestamps and three completed reconciliation
cycles prove that the dispatcher stayed live and kept reading the affected
records; `unhealthy=3,3,3` proves the same unhealthy set was observed on every
cycle. This makes each absence below a measured silence rather than a dead-loop
artifact.

```text
INT4B_D0_MAIN_SHA=39ab2b486659819b254e521359990694f25a3392
INT4B_DATABASE_LIVE boundary=reference container=int4b-reference-92005-1785994902631
INT4B_DATABASE_LIVE boundary=harness container=int4b-harness-92005-1785994902631
INT4B_D0_CYCLE cycle=1 heartbeat=2026-08-06T12:00:01.000Z reconciled=3
INT4B_D0_CYCLE cycle=2 heartbeat=2026-08-06T12:00:02.000Z reconciled=3
INT4B_D0_CYCLE cycle=3 heartbeat=2026-08-06T12:00:03.000Z reconciled=3
INT4B_D0_SILENCE poison retries=3 stable_reason=true unhealthy=3,3,3 alerts=0 quarantine_table=absent
INT4B_D0_SILENCE binding actual=00000000-0000-5000-8000-000000000099 intended=5d2e866e-3aea-522e-869e-e9b7be4c9381 reads=3 alerts=0 lifecycle=dispatching
INT4B_D0_SILENCE orphan_pair missing_run_reads=3 terminal_live_run_reads=0 alerts=0
```

The poison log reason was byte-identical on all three cycles:

```text
status_malformed: Harness status response is malformed
```

The dispatching task deliberately had no task-side run binding, which is a
schema-valid crash-window state. Its outbox row was the only record tampered;
the row no longer matched the approved-task-derived intended id, yet it was
read on all three cycles without an alert or lifecycle change. The orphan pair
likewise produced no alert: the missing run was re-read three times, while the
live run attached to the terminal task was never read because terminal tasks
were outside the reconciliation candidate set.

The disposable containers were force-removed by the probe's `finally` cleanup.

## Projection-level contradiction found during strengthening

A second D0 probe replaced the malformed read with a valid read carrying a
tampered `EnvironmentPrepared.manifest_hash`, so the production
`projectHarnessRun` function itself raised `manifest_mismatch`. Exact unmodified
main did **not** retry that failure forever as §0.1 says. It force-cancelled and
blocked the task on cycle one; the task then left the reconciliation candidate
set:

```text
INT4B_DATABASE_LIVE boundary=reference container=int4b-reference-20972-1785997919961
INT4B_DATABASE_LIVE boundary=harness container=int4b-harness-20972-1785997919961
INT4B_D0_CYCLE cycle=1 heartbeat=2026-08-06T12:00:01.000Z reconciled=3
INT4B_D0_CYCLE cycle=2 heartbeat=2026-08-06T12:00:02.000Z reconciled=2
INT4B_D0_CYCLE cycle=3 heartbeat=2026-08-06T12:00:03.000Z reconciled=2
AssertionError: expected [] to have a length of 3 but got +0
Test Files  1 failed (1)
Tests  1 failed (1)
```

The empty warning set is expected from that existing branch: the projection
catch calls `forceCancelTask` instead of `degradedRead`. This contradicts the
work order's required projection-level silence and means the D0 projection row
cannot be recorded as specified without changing what the baseline claims.
