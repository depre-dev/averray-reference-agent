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
# - set SLACK_WEBHOOK_URL
# - set AGENT_WALLET_PRIVATE_KEY if you did not use bootstrap-wallet.sh
# - confirm AVERRAY_API_BASE_URL points at testnet
# - keep HERMES_IMAGE pinned; do not use latest for production smoke
chmod 600 .env.prod

docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg up -d --build
```

## Dashboard Access

Hermes dashboard is not exposed publicly.

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
  exec hermes hermes "Open app.averray.com testnet, find a Wikipedia job, inspect it, and write what you learned. Do not claim or submit."
```

## Tool Smoke

After Hermes boots, verify the MCP tools from a shell inside the Hermes container when Hermes MCP config is loaded:

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg logs -f hermes
```

Look for:

- Hermes dashboard started.
- MCP servers discovered.
- No public ports published.
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
