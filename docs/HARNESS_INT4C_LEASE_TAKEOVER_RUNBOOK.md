# INT-4c claim takeover and backpressure runbook

INT-4c gives each per-work-item dispatch claim a finite lease, permits one
takeover generation, and blocks loudly after that generation expires. It also
introduces the dispatcher's first in-flight bound. Before INT-4c there was no
in-flight bound at any level; the D0 probe's `active_bound=1` described its
setup, not an existing control.

This mechanism assumes one database clock on one host. Multi-host clock skew
and concurrency above one are outside INT-4c.

## Configuration

| Variable | Default | Effect |
|---|---:|---|
| `HARNESS_DISPATCH_CLAIM_TTL_MS` | `600000` | Time allowed for a claimed generation to make durable progress. Submission and binding renew it; elapsed time alone never does. |
| `HARNESS_DISPATCH_MAX_INFLIGHT` | `1` | Maximum non-terminal AgentTasks with durable Harness bindings. |

Do not configure `HARNESS_DISPATCH_FAULT_INJECTION` or
`HARNESS_DISPATCH_CRASH_POINT` outside the disposable drill. The crash point is
ignored unless the fence is exactly `HARNESS_DISPATCH_FAULT_INJECTION=enabled`.
When armed, the dispatcher emits an error at startup and stamps the active
point in its heartbeat. The supported points are
`after-claim-before-submit` and `after-submit-before-binding`.

## Operator state

Read one task and the current backpressure transition through the existing
read-only status command:

```sh
node scripts/ops/harness-pilot.mjs status --work-item <work-item-id>
```

`dispatcherBackpressure.active=true` names `observedInflight` and
`maxInflight`. Entry produces one `dispatch_refusal` decision with reason
`backpressure` and one warn alert. Repeated cycles are quiet. Falling below the
bound clears the state and logs the transition without another alert.

An expired generation-1 claim is acquired as generation 2. A takeover first
wins the claim and then reads the durable binding. If no binding exists, it
replays submission with the immutable derived run id. Harness idempotency
adopts an already submitted run. Submission or binding renews the claim; an
expired generation-2 claim becomes `exhausted`, blocks the task, and emits a
critical `dispatch_retry_exhausted` alert. Nothing auto-unblocks it.

## Disposable drills

Build first, then run:

```sh
npm run typecheck
node scripts/ceremony/run-int4c-drills.mjs
```

The runner creates two uniquely named throwaway Postgres containers with no
volumes: one reference-agent store and one Harness run store. It exercises
real dispatcher processes, persisted claims, persisted Harness run counts,
heartbeats, and the real pilot status command. It removes both databases in
`finally` and never starts the production Compose dispatch profile.

Expected green and deliberate mutation evidence is recorded in
[`docs/evidence/INT4C_LEASE_TAKEOVER_DRILLS_2026-08-06.md`](evidence/INT4C_LEASE_TAKEOVER_DRILLS_2026-08-06.md).

## Rollout and rollback

Apply migration `005_dispatch_claim_expiry_backpressure.sql` before starting
the updated dispatcher. Leave the defaults in place for the first rollout and
confirm a normal heartbeat has no `faultInjection` member. Check pilot status
for the durable backpressure state and the alert file for any
`dispatch_retry_exhausted` event.

Rollback is operational: stop the dispatcher and restore the prior image. The
migration is additive and remains in place. Existing generation state is not
deleted or reset. Do not clear a blocked task or alter its claim by hand;
inspect the Harness run and binding first, then use a separately reviewed
operator recovery packet.
