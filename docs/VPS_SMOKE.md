# VPS Smoke Runbook

This repo is an external reference-agent stack. It must stay isolated from Averray's production stack.

## Prerequisites

- Docker with the Compose plugin.
- Tailscale or SSH access for the Hermes dashboard.
- Ollama Cloud API key.
- Slack webhook URL for v1 alerts.
- A testnet-only wallet. You can generate it with `scripts/bootstrap-wallet.sh`
  when Node is installed, or fill `AGENT_WALLET_PRIVATE_KEY` manually in
  `.env.prod`.

## First Boot

```bash
git clone https://github.com/depre-dev/averray-reference-agent.git
cd averray-reference-agent

# Optional local sanity checks when Node is installed on the host:
npm ci
npm run typecheck
npm test

# Create .env.prod with one of these two paths.
#
# Path A: wallet bootstrap when Node is installed on the host:
scripts/bootstrap-wallet.sh

# Path B: Docker-only setup, then fill AGENT_WALLET_PRIVATE_KEY manually:
cp ops/.env.example .env.prod

# Edit .env.prod:
# - set OLLAMA_API_KEY
# - keep OLLAMA_BASE_URL as https://ollama.com/v1
# - set SLACK_WEBHOOK_URL
# - set AGENT_WALLET_PRIVATE_KEY if you did not use bootstrap-wallet.sh
# - confirm AVERRAY_API_BASE_URL points at testnet
# - keep HERMES_IMAGE pinned; do not use latest for production smoke
chmod 600 .env.prod

docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg up -d --build
```

If you add or change `AGENT_WALLET_PRIVATE_KEY` after Hermes is already
running, force-recreate the Hermes service so Docker injects the new
environment. The stack also writes selected env values into an internal
Docker volume at `/config-runtime/reference-agent.env`; the MCP launcher
sources that file before starting each Node MCP server so Hermes does not
need to write secrets into `config.yaml`:

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  up -d --build --force-recreate hermes
```

## Slack Operational Alerts

Slack alerts are opt-in. If `SLACK_WEBHOOK_URL` is unset, the reference agent
continues normally and alert delivery is skipped. When configured, alerts are
short, redacted, and include safe identifiers such as `jobId`, `runId`,
`sessionId`, wallet address, claim deadline, and whether a mutation budget was
consumed.

Configured events:

- `claim_precheck_passed`
- `claim_blocked`
- `claim_succeeded`
- `claim_failed`
- `submit_validation_failed`
- `submit_blocked`
- `submit_succeeded`
- `submit_failed`
- `ttl_nearing_expiry`
- `inventory_exhausted`
- `inventory_replenished`

Local submission validation alerts fire before `averray_submit` touches the
submit mutation budget, so schema mistakes are visible without burning the
one-shot submit attempt.

## Slack Operator Commands

Slack alerts are outbound-only. To make Slack messages call the Averray
operator command router, enable the `slack-operator` service with either Slack
Socket Mode or signed HTTP slash/events endpoints. The service accepts only the
short operator commands below and routes them to `averray_handle_operator_command`
semantics directly, not through a free-form Hermes prompt:

```text
run one wikipedia citation repair if safe
run wikipedia citation repair for wiki-en-... if safe
status last wikipedia citation repair
```

Recommended VPS mode is Slack Socket Mode because it uses outbound WebSocket
traffic and does not require exposing a public HTTP port:

```env
SLACK_OPERATOR_ENABLED=1
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_OPERATOR_CHANNEL_ID=C...
SLACK_ALLOWED_USER_IDS=U...
```

Slack app requirements:

- Enable Socket Mode and create an app-level token with `connections:write`.
- Add a bot token with `chat:write`.
- Subscribe to `app_mention` events, or configure a slash command that reaches
  the service through your preferred tunnel/proxy.
- Invite the app to the operator channel.

The service also exposes signed HTTP endpoints on VPS loopback by default:

```text
GET  http://127.0.0.1:8790/health
POST http://127.0.0.1:8790/slack/commands
POST http://127.0.0.1:8790/slack/events
```

If you use HTTP endpoints, set `SLACK_SIGNING_SECRET` and terminate/expose the
route with your chosen tunnel or reverse proxy. Keep
`SLACK_OPERATOR_CHANNEL_ID`/`SLACK_OPERATOR_CHANNEL_IDS` and
`SLACK_ALLOWED_USER_IDS` narrow.

Operator command events are persisted in Postgres with their Slack channel,
user, triggering message permalink, reply permalink, and workflow identifiers
when a run command produces a run. The read-only status command uses that
context so `slackPermalink` points back to Slack when available.

Inbound Slack or command-center messages should be routed to the direct MCP
operator command tool, not rephrased as free-form Hermes prompts. The supported
commands are:

```text
operator status
run one wikipedia citation repair if safe
run wikipedia citation repair for wiki-en-... if safe
status last wikipedia citation repair
```

`averray_handle_operator_command` parses those messages. `operator status`
calls the canonical read-only `averray_operator_status` MCP tool, returning
wallet readiness, policy budget, open Wikipedia job counts, latest run state,
safety guarantees, and safe command suggestions as structured JSON. Repair
commands call `averray_run_wikipedia_citation_repair` directly with the
workflow's wallet, policy, draft, validation, submit, and Slack alert gates.
Latest-run status commands are read-only and return the latest `runId`,
`jobId`, `sessionId`, submitted/failed state, `draftId`, and Slack permalink
when one is available. Add `dry run only` to a repair command when you want a
proposal preview without claim or submit.

Check the host env file:

```bash
grep -E '^SLACK_WEBHOOK_URL=.+$' .env.prod >/dev/null && echo "SLACK_WEBHOOK_URL configured"
```

Check the running Hermes container after boot or force-recreate:

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  exec hermes sh -lc 'test -n "$SLACK_WEBHOOK_URL" && echo "SLACK_WEBHOOK_URL configured"'
```

Check the Slack operator service:

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  ps slack-operator

curl -sS http://127.0.0.1:8790/health
```

## Dashboard Access

Hermes dashboard is not exposed publicly. Docker binds it to
`127.0.0.1:9119` on the VPS, so open the SSH tunnel from your laptop, not from
inside the VPS shell. The Hermes dashboard command uses `--insecure` because
Hermes requires it for the container-internal `0.0.0.0` bind; Docker still
limits host access to VPS loopback.

SSH tunnel:

```bash
ssh -L 9119:localhost:9119 ubuntu@YOUR_VPS
```

Then open:

```text
http://127.0.0.1:9119
```

## Safe First Prompt

Do not claim or submit during the first smoke.

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  exec hermes /opt/hermes/.venv/bin/hermes chat \
  --provider ollama-cloud \
  -m deepseek-v4-pro:cloud \
  -q "Open app.averray.com testnet, find a Wikipedia job, inspect it, and write what you learned. Do not claim or submit."
```

## Claim Readiness Smoke

Run this only after `.env.prod` contains a real testnet-only
`AGENT_WALLET_PRIVATE_KEY`. The script validates that the key has the expected
shape and is not the all-zero placeholder without printing it. It may print
`AGENT_WALLET_ADDRESS`, which is safe.

This smoke checks wallet status, policy budget, compact Wikipedia discovery,
one job definition, and `policy_check_claim`. It explicitly forbids
`averray_claim`, `averray_submit`, approvals, and Wikipedia edits.
Before launching Hermes, it also verifies that the running Hermes container can
see `AGENT_WALLET_PRIVATE_KEY` and that the MCP launcher can read
`/config-runtime/reference-agent.env`; if either fails, force-recreate
`hermes`.

Controlled smokes that do call `averray_claim` must set an explicit run id and
let the MCP mutation guard enforce the boundary outside the model prompt. The
default guard requires `AVERRAY_REQUIRE_CLAIM_RUN_ID=true`, allows only
`AVERRAY_MAX_CLAIM_ATTEMPTS=1`, blocks fresh idempotency-key retries with
`AVERRAY_ALLOW_FRESH_CLAIM_RETRY=false`, and can restrict a run to specific
jobs through `AVERRAY_CLAIM_JOB_ALLOWLIST`.

Controlled smokes that call `averray_submit` must also configure the mutation
boundary outside the prompt. The default guard requires
`AVERRAY_REQUIRE_SUBMIT_RUN_ID=true`, allows only
`AVERRAY_MAX_SUBMIT_ATTEMPTS=1`, blocks retries with
`AVERRAY_ALLOW_SUBMIT_RETRY=false`, and can restrict the run to exact session
and job identifiers with `AVERRAY_SUBMIT_SESSION_ALLOWLIST` and
`AVERRAY_SUBMIT_JOB_ALLOWLIST`. A session id that differs by one character is
blocked before any `/jobs/submit` network call.

```bash
scripts/claim-readiness-smoke.sh
```

To compare a second model without changing `.env.prod`:

```bash
scripts/claim-readiness-smoke.sh --model qwen3.5:cloud
```

Expected result:

- `wallet_status.configured` is true.
- `wallet_export_address` returns the same testnet wallet address you expect.
- `policy_get_budget` returns current per-run/per-day budget limits.
- `averray_list_jobs` returns a compact Wikipedia subset.
- `averray_get_definition` returns one Wikipedia definition.
- `policy_check_claim` returns `pass` or a clear blocker.
- No session is claimed and no work is submitted.

## One-Command Wikipedia Workflow Smoke

The reference agent exposes a first-class workflow so operators do not need to
paste the full claim/evidence/draft/validate/submit sequence each time.

Safe dry run:

```text
run one Wikipedia citation repair if safe, dry run only
```

Specific job dry run:

```text
run Wikipedia citation repair for wiki-en-... if safe, dry run only
```

Mutation run, only after allowlists are set for the exact job/session boundary:

```text
run Wikipedia citation repair for wiki-en-... with runId controlled-wikipedia-onecommand-r1-001 if safe with dryRun=false
```

The workflow tool is `averray_run_wikipedia_citation_repair`. Its default is
`dryRun=true`, which may fetch read-only Wikipedia/source evidence and validate
a proposal preview but must not call `averray_claim` or `averray_submit`.
For short operator intents such as `Run one Wikipedia citation repair if safe.`
or `Run Wikipedia citation repair for <jobId> if safe.`, including Slack and
command-center requests, Hermes should call
`averray_run_wikipedia_citation_repair` first. Lower-level tools such as
`averray_list_jobs` and `averray_claim` are fallback primitives, not the
preferred route for this intent.
With `dryRun=false`, claim and submit still go through the same one-shot
mutation guards, draft persistence, local schema validation, confidence gate,
and Slack lifecycle alerts. If a mutation run omits `runId`, the workflow
generates one before claim and carries that same value through claim, draft
persistence, validation, submit, and Slack context. A blank explicit `runId`
fails closed before any wallet check or mutation.

## Tool Smoke

After Hermes boots, verify the MCP tools from a shell inside the Hermes container when Hermes MCP config is loaded:

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg logs -f hermes
```

Look for:

- Hermes dashboard started.
- MCP servers discovered.
- No public ports published; dashboard is bound only to VPS localhost.
- Skills observer started.
- Postgres migrations applied.

## Runtime Pin

The default Hermes image is pinned to:

```text
nousresearch/hermes-agent@sha256:8811f1809971ac558f8d5e311e22fe73dc2944616dda7295c98acb6028f9df08
```

Before changing that pin, test the new tag on a branch and re-run the safe first prompt.

## Kill Switch

Create the halt file to stop mutating tools:

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  exec hermes sh -lc 'touch /data/HALT'
```

Remove after investigation:

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  exec hermes sh -lc 'rm -f /data/HALT'
```

## Shutdown

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg down
```

Use `down -v` only when you explicitly want to delete Postgres/Hermes data.
