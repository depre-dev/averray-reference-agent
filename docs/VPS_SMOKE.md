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
shape without printing it. It may print `AGENT_WALLET_ADDRESS`, which is safe.

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
