# INT-4c D0 partial baseline — stopped 2026-08-06

This was the required pre-implementation D0 run against exact unmodified main
`4164549b146ec87e57d093a926588ea82e17b3e6`. It used one uniquely named,
throwaway local Postgres 16 container. No production database, production
Compose profile, credential, kernel checkout, or external service was used.

The run established two of the required baselines:

```text
INT4C_D0_MAIN_SHA=4164549b146ec87e57d093a926588ea82e17b3e6
INT4C_D0_DATABASE_LIVE container=int4c-d0-80007-1786007429501
INT4C_D0_SILENCE orphaned_claim lifecycle=dispatching claim_lease=null run_reads=3 alerts=0 heartbeats=1,2,2,3,3
INT4C_D0_SILENCE backpressure active_bound=1 queued_attempt=dispatched named_refusal=false operator_signal=false alerts=0
```

The orphaned-claim probe used a newly constructed dispatcher process over the
persisted task and claim. Three completed reconciliation reads and heartbeat
cycles prove the restarted loop was live while the claim remained without an
expiry, alert, binding, or lifecycle change. The duplicated heartbeat cycle
numbers are the process's normal start/end heartbeat pair, not repeated work.

The backpressure probe stored one non-terminal bound task, then presented a
second approved task. Exact main dispatched the second task and emitted neither
a decision reason nor an alert named `backpressure`.

`active_bound=1` describes the probe's intended occupancy, not a pre-existing
dispatcher limit. Exact main has no in-flight bound at any level; D2 will
introduce the bound rather than name an existing one. The eventual drill-ledger
row must preserve that distinction.

## Required global-lease proof did not complete

The two-child-process probe failed before it could establish its required
starting condition:

```text
× records dead-holder takeover and the live-holder negative with two processes 5321ms
  → INT4C_D0 lease holder d0-holder was not observed

Error: INT4C_D0 lease holder d0-holder was not observed
 ❯ waitForHolder test/integration/int4c-d0-baseline.test.ts:450:9
 ❯ test/integration/int4c-d0-baseline.test.ts:202:7

Test Files  1 failed (1)
Tests  1 failed | 2 passed (3)
```

Cause: the probe spawned the holder and contender concurrently, so the
contender could acquire the empty global lease before the intended holder's
identity was observed. This is a probe ordering race; it is not evidence for or
against the production lease mechanism.

The probe was corrected to wait until `d0-holder` was visible in
`dispatch_lease` before spawning `d0-contender`. The correction was committed as
`5b0f570ca6ed8df63d2e979645138b6b9e405561` before execution.

## Adjudicated corrected-instrument run

The operator classified the concurrent-start race as an instrument defect and
authorized one run of only the corrected two-process baseline. The two other D0
cases were skipped rather than rerun:

```text
INT4C_D0_MAIN_SHA=4164549b146ec87e57d093a926588ea82e17b3e6
INT4C_D0_PROBE_SHA=5b0f570ca6ed8df63d2e979645138b6b9e405561
INT4C_D0_DATABASE_LIVE container=int4c-d0-86634-1786008850803
INT4C_D0_LEASE_LIVE holder=d0-holder contender=d0-contender ttl_windows=3 contender_acquired=false holder_pid=86760 contender_pid=86767
INT4C_D0_LEASE_TAKEOVER dead_holder=d0-holder new_holder=d0-contender fired=true identities_visible=d0-holder,d0-contender
Test Files  1 passed (1)
Tests  1 passed | 2 skipped (3)
```

This proves both halves of the corrected inventory on exact main: a renewing
holder is not stolen from across three TTL windows, and the existing global
lease is acquired by the second real process after the dead holder's expiry.
No D1–D7 implementation had begun when either D0 run was recorded.
