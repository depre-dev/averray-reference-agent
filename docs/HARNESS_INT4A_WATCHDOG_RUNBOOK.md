# INT-4a standalone watchdog runbook

The watchdog is a default Compose service, independent of the dispatcher,
Hermes, and slack-operator. It never dispatches, mutates a task, or performs
remediation. It reads both Postgres boundaries, reads the dispatcher heartbeat,
tails the dispatcher alert JSONL, writes its own observability files, and posts
redacted alerts to a direct Slack incoming webhook when configured.

Buzz/Nostr is deliberately not part of INT-4a. It is the separate INT-4a.1
packet described in the work order.

## Configuration

The only credential-like value is `WATCHDOG_SLACK_WEBHOOK_URL`. The operator
adds it to the watchdog's production environment after merge. Never commit,
print, or pass the URL as a command-line argument. With the variable absent or
empty, the service remains live and reports the Slack sink as `disabled`.

Defaults:

| Variable | Default | Purpose |
|---|---:|---|
| `WATCHDOG_POLL_INTERVAL_MS` | `15000` | Watch interval. |
| `WATCHDOG_DISPATCHER_STALE_MS` | `90000` | Maximum dispatcher-heartbeat age. |
| `WATCHDOG_HARNESS_SOURCE_STALE_MS` | `900000` | Maximum source-event age while a Harness run is live. Idle systems do not alert on source age. |
| `WATCHDOG_DATABASE_TIMEOUT_MS` | `5000` | Bound on each read-only database probe. |
| `WATCHDOG_HEARTBEAT_PATH` | `/data/harness-watchdog-heartbeat.json` | Watchdog heartbeat. |
| `WATCHDOG_STATUS_PATH` | `/data/harness-watchdog-status.json` | One-line operator status. |

The service shares `HARNESS_DISPATCH_HEARTBEAT_PATH`,
`HARNESS_DISPATCH_ALERTS_PATH`, `DATABASE_URL`, and `HARNESS_DATABASE_URL` with
the watched boundaries. It does not log those values.

## Operator check

After the normal image deployment, recreate only the watchdog through the
repository's normal production Compose invocation. Then verify the container
is running and read these two local files from the container:

```sh
cat /data/harness-watchdog-heartbeat.json
cat /data/harness-watchdog-status.json
```

The status must name Slack as `configured` after provisioning, or `disabled`
when the webhook variable is absent. `updatedAt` must advance. An active issue
names the affected boundary; it never contains a database driver error or DSN.

The recursion ends here: there is no watchdog-for-the-watchdog. The service has
Compose `restart: unless-stopped`; the operator checks its container state and
heartbeat during routine health checks.

## Local drills

Build first, then run the disposable Compose drill:

```sh
npm run typecheck
node scripts/ceremony/run-int4a-watchdog-drills.mjs
```

The runner creates a unique `codex-int4a-*` Compose project, uses sentinel-only
Postgres credentials and a local fake Slack listener, and always removes its
containers, volumes, and network. It never addresses the production `avg`
project.

## Sink outage and rollback

Slack delivery is forward-only and best-effort. The JSONL alert is written
first, so a webhook outage does not erase evidence or stop another future sink.
Clear `WATCHDOG_SLACK_WEBHOOK_URL` and recreate only the watchdog to disable
external delivery; status will say `disabled`. Stopping the watchdog does not
change dispatcher authority or task state, but it removes external detection
until the service is restored.
