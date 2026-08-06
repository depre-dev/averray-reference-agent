# INT-4c claim takeover and backpressure evidence — 2026-08-06

The D0 baseline, including the failed concurrent-start instrument and its
adjudicated correction, remains in
[`INT4C_D0_PARTIAL_2026-08-06.md`](INT4C_D0_PARTIAL_2026-08-06.md). The amended
fresh-UUID contradiction that introduced the second crash point remains in
[`INT4C_FRESH_UUID_CONTRADICTION_2026-08-06.md`](INT4C_FRESH_UUID_CONTRADICTION_2026-08-06.md).

Every run below used two uniquely named, throwaway Postgres 16 containers with
no volumes. No production database, Compose dispatch profile, credential,
external service, or kernel change was involved.

## Six-row drill — green

```text
INT4C_FAULT_HEARTBEAT dispatcher=before-holder fault_injection=enabled crash_point=after-claim-before-submit
INT4C_NORMAL_HEARTBEAT dispatcher=before-contender fault_injection=absent
INT4C_DRILL_GREEN before-submit takeover=true runs=1 attempt=1 run_id_equals_derivation=true binding=1 claim_generation=2 holder=before-contender fault_stamp=present normal_stamp=absent
INT4C_FAULT_HEARTBEAT dispatcher=after-holder fault_injection=enabled crash_point=after-submit-before-binding
INT4C_DRILL_GREEN after-submit takeover=true adopted_existing=true resubmitted_second_run=false runs=1 attempt=1 binding=1 binding_holder=after-contender claim_generation=2
INT4C_DRILL_GREEN no-takeover-while-alive holder=live-holder contender=live-contender ttl_windows=3 contender_acquired=false
INT4C_DRILL_GREEN restart-resume runs=1 attempt=1 binding=1 same_derived_id=true
INT4C_CHILD_ERROR Harness dispatcher fault injection is armed {"crashPoint":"after-claim-before-submit"}
INT4C_DRILL_GREEN bounded-retry lifecycle=blocked claim_generation=2 critical_alert=1 third_submit_attempts=0 harness_runs=0
INT4C_BACKPRESSURE_STATUS {"observed":true,"active":true,"observedInflight":1,"maxInflight":1,"changedAt":"2026-08-06T12:26:51.321Z"}
INT4C_DRILL_GREEN backpressure introduced_bound=1 refusal_visible=true status_reason=backpressure warn_alerts=1 repeated_cycles=2 cleared=true queued_dispatched=true
Test Files  1 passed (1)
Tests  6 passed (6)
```

The live-holder line omits the run-specific child PIDs from this committed
record; the raw run printed both process identities. The fault-injection stamp
was asserted from the crashing holder's heartbeat. The normal contender's
heartbeat was asserted not to contain a `faultInjection` member.

The after-submit row is the adoption proof: the first holder had already
persisted the derived run at attempt 1; the new holder replayed that immutable
id, Harness kept exactly one run, and the new holder wrote the one binding at
claim generation 2.

## Mutation: healthy holder stops renewing

The mutation was observed by the child and the negative drill failed on the
persisted lease holder:

```text
INT4C_LIVE_HOLDER_WAS_STOLEN: expected 'live-contender' to be 'live-holder' // Object.is equality
Expected: "live-holder"
Received: "live-contender"
Test Files  1 failed (1)
Tests  1 failed | 5 skipped (6)
```

After restoring renewal:

```text
INT4C_DRILL_GREEN no-takeover-while-alive holder=live-holder contender=live-contender ttl_windows=3 contender_acquired=false
Test Files  1 passed (1)
Tests  1 passed | 5 skipped (6)
```

## Mutation: retry path mints a fresh UUID

The source mutation was verified at the executed line before both runs. The
before-submit case kept one run but broke correlation:

```text
INT4C_BEFORE_SUBMIT_CORRELATION_BREAK: expected '99724884-9088-4be8-9027-dbffeada1ade' to be 'd98031dd-e86c-5d08-b41f-5e651ce32047' // Object.is equality
Expected: "d98031dd-e86c-5d08-b41f-5e651ce32047"
Received: "99724884-9088-4be8-9027-dbffeada1ade"
Test Files  1 failed (1)
Tests  1 failed | 5 skipped (6)
```

The after-submit case found the first derived run and then created the mutated
fresh-id run, so the Harness store count reached two:

```text
INT4C_AFTER_SUBMIT_DUPLICATE_RUN_COUNT: expected [ { …(2) }, { …(2) } ] to have a length of 1 but got 2
- Expected
+ Received

- 1
+ 2
Test Files  1 failed (1)
Tests  1 failed | 5 skipped (6)
```

After restoring `claim.intendedRunId`:

```text
INT4C_DRILL_GREEN before-submit takeover=true runs=1 attempt=1 run_id_equals_derivation=true binding=1 claim_generation=2 holder=before-contender fault_stamp=present normal_stamp=absent
INT4C_DRILL_GREEN after-submit takeover=true adopted_existing=true resubmitted_second_run=false runs=1 attempt=1 binding=1 binding_holder=after-contender claim_generation=2
```

## Mutation: remove the retry bound

The fenced third dispatcher reached submission and the Harness run store made
the removed guard visible:

```text
INT4C_RETRY_BOUND_REMOVED_THIRD_SUBMIT: expected 1 to be +0 // Object.is equality
- Expected
+ Received

- 0
+ 1
Test Files  1 failed (1)
Tests  1 failed | 5 skipped (6)
```

After restoring the generation-2 exhaustion guard:

```text
INT4C_DRILL_GREEN bounded-retry lifecycle=blocked claim_generation=2 critical_alert=1 third_submit_attempts=0 harness_runs=0
Test Files  1 passed (1)
Tests  1 passed | 5 skipped (6)
```

## Mutation: remove alert transition deduplication

The second backpressured cycle emitted a second warn alert and the alert-count
assertion failed before the equivalent decision-count assertion:

```text
INT4C_BACKPRESSURE_ALERT_DEDUP: expected [ { severity: 'warn', …(5) }, …(1) ] to have a length of 1 but got 2
- Expected
+ Received

- 1
+ 2
Test Files  1 failed (1)
Tests  1 failed | 5 skipped (6)
```

After restoring transition-only notification:

```text
INT4C_DRILL_GREEN backpressure introduced_bound=1 refusal_visible=true status_reason=backpressure warn_alerts=1 repeated_cycles=2 cleared=true queued_dispatched=true
Test Files  1 passed (1)
Tests  1 passed | 5 skipped (6)
```
