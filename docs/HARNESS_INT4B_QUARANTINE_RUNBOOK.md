# INT-4b quarantine and orphan detection runbook

INT-4b detects, alerts, marks, and stops. It never auto-cancels, auto-reaps, or
auto-clears. The dispatcher is the only component that writes a durable task
quarantine marker. The standalone watchdog uses its own read-only SQL and only
emits alerts.

## Thresholds

| Variable | Default | Effect |
|---|---:|---|
| `HARNESS_DISPATCH_POISON_THRESHOLD` | `5` | Consecutive cycles with the same stable non-transient read/projection failure before the dispatcher marks the task. |
| `WATCHDOG_ORPHAN_AGE_MS` | `600000` | Minimum age before either orphan class produces a warning. |

A successful bound-run read resets the in-memory poison count. Retryable
connection, timeout, and database-restart failures do not contribute to it.
Changing either threshold is an operator configuration change; do not tune one
to make a drill pass.

## Read state

Use the read-only pilot status command:

```sh
node scripts/ops/harness-pilot.mjs status --work-item <work-item-id>
```

Each task reports `quarantine.active`. An active marker also reports its
`reason`, content-stable `fingerprint`, `cycleCount`, and `quarantinedAt`.
Dispatcher heartbeat `cycleCount` must advance before treating the absence of
an alert or marker as meaningful.

Watchdog status remains at its configured status path, normally:

```sh
cat /data/harness-watchdog-status.json
```

The watchdog deduplicates binding and orphan alerts across cycles. A watchdog
database outage does not silently clear its active-issue memory.

## Operator un-quarantine ceremony

First inspect and reconcile the binding/run state. Then, and only then, clear
one marker explicitly:

```sh
node scripts/ops/harness-pilot.mjs unquarantine \
  --work-item <work-item-id> \
  --version <task-version> \
  --operator <operator-id> \
  --confirm
```

The verb refuses without the exact `--confirm`, refuses when no active marker
exists, and records the clearing operator and time on the marker. Nothing else
clears a marker automatically.

## Container audit ceremony

The kernel-side command is read-only by default:

```sh
uv run harness containers audit
```

It lists stopped deterministic runtime containers with age, run id, label
state, and `action=listed`. Only a container whose run-id and created-at labels
are valid and whose run id matches its deterministic name is removable through
the command. After reviewing the output, removal is a separate explicit act:

```sh
uv run harness containers audit --remove
```

Missing, invalid, or name-mismatched labels produce `action=refused`; they are
never deleted merely because their name has the expected prefix. No dispatcher,
watchdog loop, timer, or test cleanup invokes `--remove`. Docker lifecycle tests
call the targeted low-level cleanup in `finally` and assert their own audit entry
is absent afterward.

## Disposable drills

Build before running the reference-side drills:

```sh
npm run typecheck
node scripts/ceremony/run-int4b-drills.mjs
```

The script creates two uniquely named throwaway Postgres containers and removes
them in `finally`. It never starts the production Compose dispatch profile.
Expected green and mutation evidence is recorded in
[`docs/evidence/INT4B_QUARANTINE_DRILLS_2026-08-06.md`](evidence/INT4B_QUARANTINE_DRILLS_2026-08-06.md).
