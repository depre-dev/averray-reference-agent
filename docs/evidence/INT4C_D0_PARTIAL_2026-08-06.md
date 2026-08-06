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

The probe was corrected locally to wait until `d0-holder` was visible in
`dispatch_lease` before spawning `d0-contender`. It was not rerun: the packet's
standing one-attempt/stop-on-failure rule prohibited treating a repaired probe
as the original D0 attempt. No D1–D7 implementation was started. The global
dead-holder takeover and live-holder negative therefore remain unproven by this
packet.
