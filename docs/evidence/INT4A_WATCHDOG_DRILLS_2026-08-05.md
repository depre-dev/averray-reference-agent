# INT-4a watchdog drill evidence — 2026-08-05

All runs used disposable Compose projects named `codex-int4a-*`, sentinel-only
database credentials, and a local fake Slack listener. No production Compose
project, production database, real webhook, Hermes credential, or Buzz/Nostr
surface was used.

The accepted pre-change silence and its liveness proofs remain in
[INT4A_D0_SILENCE_2026-08-05.md](INT4A_D0_SILENCE_2026-08-05.md).

## Red before the watchdog

Dispatcher killed, with the dispatcher first proven live by an advancing
heartbeat:

```text
D0_HEARTBEAT_ONE=2026-08-05T09:19:43.852Z
D0_HEARTBEAT_TWO=2026-08-05T09:19:48.862Z
D0_HEARTBEAT_ADVANCING=true
D0_DISPATCHER_KILLED_ALERT_FILE_DELTA=0
D0_DISPATCHER_KILLED_EXTERNAL_DELIVERY_DELTA=0
D0_DISPATCHER_KILLED_SILENCE=true
```

Harness Postgres stopped, after authenticated `select 1` proved it live:

```text
D0_HARNESS_DB_LIVE=1
D0_HARNESS_DB_STOPPED=true state=missing
D0_DB_DOWN_DISPATCHER_STILL_LIVE=true
D0_DB_DOWN_ALERT_FILE_DELTA=0
D0_DB_DOWN_EXTERNAL_DELIVERY_DELTA=0
D0_DB_DOWN_SILENCE=true
```

Hermes unavailable, with every local Hermes/slack-operator container stopped
and no watchdog process present:

```text
INT4A_DATABASE_LIVE service=reference-db authenticated_select=1
INT4A_DATABASE_LIVE service=harness-db authenticated_select=1
INT4A_DRILL_RED hermes-unavailable-baseline external_delivery_missing watchdog_absent hermes=stopped slack_operator=stopped
Error: INT4A_DRILL_ASSERTION_FAILED hermes-unavailable-baseline: external_delivery_missing watchdog_absent hermes=stopped slack_operator=stopped
```

## Restored green drills

The real dispatcher heartbeat advanced before injection, both databases
answered authenticated queries, and all three assertions passed through the
local HTTP listener:

```text
INT4A_DATABASE_LIVE service=reference-db authenticated_select=1
INT4A_DATABASE_LIVE service=harness-db authenticated_select=1
INT4A_DISPATCHER_LIVE heartbeat_one=2026-08-05T13:37:51.205Z heartbeat_two=2026-08-05T13:37:56.227Z
INT4A_DRILL_START dispatcher-killed
INT4A_DRILL_GREEN dispatcher-killed file=present slack=delivered watchdog=running
INT4A_DRILL_START harness-db-down
INT4A_DRILL_GREEN harness-db-down file=present slack=delivered watchdog=running
INT4A_DRILL_START hermes-unavailable
INT4A_DRILL_GREEN hermes-unavailable hermes=stopped slack_operator=stopped dispatcher_alert=delivered harness_db_alert=delivered
INT4A_DRILLS_RESULT=green 3/3
```

The first DB-down implementation attempt was also usefully red:

```text
INT4A_DRILL_RED harness-db-down delivery_missing code=watchdog_harness_database_unreachable file_emission=false slack_delivery=false mutation=none
```

It exposed that `pg` emits an unhandled error when an idle pooled connection is
severed. Handling that pool event and bounding query time made the restored
green above possible; the watchdog, rather than Node's EventEmitter, now owns
the failure transition.

## Mutation proofs

### Dispatcher threshold set to infinity

The runner injected `9007199254740991`, Compose passed it to the watchdog, and
the delivery assertion went red:

```text
INT4A_DRILL_RED dispatcher-killed delivery_missing code=watchdog_dispatcher_heartbeat_stale file_emission=false slack_delivery=false mutation=threshold-infinity
Error: INT4A_DRILL_ASSERTION_FAILED dispatcher-killed: delivery_missing code=watchdog_dispatcher_heartbeat_stale file_emission=false slack_delivery=false mutation=threshold-infinity
```

Removing the mutation restored:

```text
INT4A_DRILL_GREEN dispatcher-killed file=present slack=delivered watchdog=running
```

### Redaction scrub replaced by identity

The focused test printed proof that the mutation reached the forwarder, then
failed on the outbound HTTP body:

```text
INT4A_MUTATION_APPLIED=redaction_identity_scrub
AssertionError: expected '{"text":"[HARNESS WATCHDOG CRITICAL] …' not to contain 'INT4A_TOKEN_SENTINEL_DO_NOT_LEAK'
Expected: "INT4A_TOKEN_SENTINEL_DO_NOT_LEAK"
Received: "{"text":"[HARNESS WATCHDOG CRITICAL] sentinel_probe: Authorization: Bearer INT4A_TOKEN_SENTINEL_DO_NOT_LEAK"}"
Tests  1 failed | 8 skipped (9)
```

Removing the mutation restored:

```text
✓ test/unit/harness-watchdog.test.ts > the direct Slack forwarder > scrubs secret-bearing fields and authorization text before delivery
Tests  1 passed | 8 skipped (9)
```

### Slack URL black-holed

The local JSONL emission remained present, but the delivery assertion went red:

```text
INT4A_DRILL_RED dispatcher-killed delivery_missing code=watchdog_dispatcher_heartbeat_stale file_emission=true slack_delivery=false mutation=slack-blackhole
Error: INT4A_DRILL_ASSERTION_FAILED dispatcher-killed: delivery_missing code=watchdog_dispatcher_heartbeat_stale file_emission=true slack_delivery=false mutation=slack-blackhole
```

Removing the mutation restored:

```text
INT4A_DRILL_GREEN dispatcher-killed file=present slack=delivered watchdog=running
```

This is the load-bearing proof that the drill checks delivery, not merely file
emission.

## Structural independence mutation

An actual side-effect import was temporarily added as
`services/harness-watchdog/src/forbidden-mutation.ts`:

```text
1:import "../../slack-operator/src/index.js";
AssertionError: forbidden watchdog imports: expected [ Array(1) ] to deeply equal []
+ Array [
+   "forbidden-mutation.ts -> ../../slack-operator/src/index.js",
+ ]
Tests  1 failed | 8 skipped (9)
```

This first revealed and corrected a gap in the guard for bare side-effect
imports. After deleting the deliberate import:

```text
✓ test/unit/harness-watchdog.test.ts > the watchdog import surface > has no slack-operator or Hermes-facing import
Tests  1 passed | 8 skipped (9)
```

## Disabled-sink status

With `WATCHDOG_SLACK_WEBHOOK_URL` absent:

```text
INT4A_STATUS_JSON={"schemaVersion":1,"kind":"harness_watchdog_status","updatedAt":"2026-08-05T10:00:00.000Z","activeIssues":[],"sinks":[{"name":"slack","state":"disabled"}],"lastAlertForwarded":null,"thresholds":{"dispatcherStaleMs":90000,"harnessSourceStaleMs":900000,"databaseTimeoutMs":5000,"pollIntervalMs":10}}
```
