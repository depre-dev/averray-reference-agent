# Command Center Evaluation

This runbook evaluates Hermes Workspace as an optional operator command center
for the Averray reference agent. It is not part of the default smoke path.

## Decision Snapshot

Hermes Workspace is worth evaluating as a companion UI, not a replacement yet.
It can attach to an existing Hermes gateway and Hermes dashboard pair:

- gateway API on `:8642`
- dashboard API on `:9119`
- workspace UI on `:3000`

The reference stack already runs the built-in Hermes dashboard on `9119`. This
overlay adds a separate Hermes gateway process and the Workspace UI, both
published only to VPS localhost.

## Safety Model

- Do not install Hermes Workspace with `curl | bash` on the VPS.
- Do not bind the command center to a public interface.
- Use SSH or Tailscale tunnels to reach the UI.
- Set a strong `HERMES_WORKSPACE_PASSWORD` before starting the workspace.
- Do not mount the Docker socket.
- Do not give the Workspace container the Averray wallet private key or MCP
  runtime env volume. The gateway owns agent execution; the UI only talks to
  the gateway and dashboard APIs.
- Treat browser terminal access as powerful operator access. If the UI exposes
  a terminal, assume it can run commands inside its container context.

## Configure

Add these values to `.env.prod`:

```dotenv
HERMES_WORKSPACE_IMAGE=ghcr.io/outsourc-e/hermes-workspace:latest
HERMES_WORKSPACE_PORT=3000
HERMES_GATEWAY_PORT=8642

# Optional. If set, the Workspace passes this token to the gateway.
HERMES_GATEWAY_API_KEY=

# Required by the compose overlay. Use a long random value.
HERMES_WORKSPACE_PASSWORD=change-this-to-a-long-random-password

# Keep 0 for plain HTTP over SSH/Tailscale localhost tunnels.
HERMES_WORKSPACE_COOKIE_SECURE=0
HERMES_WORKSPACE_TRUST_PROXY=0
```

## Start

From the VPS checkout:

```bash
docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -p avg \
  --profile command-center \
  up -d hermes hermes-gateway hermes-workspace
```

The default stack remains unchanged if `ops/compose.command-center.yml` and the
`command-center` profile are omitted.

## Open

From your laptop, tunnel the dashboard, gateway, and Workspace UI:

```bash
ssh \
  -L 3000:localhost:3000 \
  -L 8642:localhost:8642 \
  -L 9119:localhost:9119 \
  ubuntu@YOUR_VPS
```

Then open:

```text
http://127.0.0.1:3000
```

The existing built-in Hermes dashboard remains available at:

```text
http://127.0.0.1:9119
```

## Verify

Check the command-center services:

```bash
docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -p avg \
  --profile command-center \
  ps hermes-gateway hermes-workspace
```

Check the gateway and dashboard from the VPS:

```bash
curl -fsS http://127.0.0.1:8642/health
curl -fsS http://127.0.0.1:9119/api/status
```

In the Workspace UI, verify:

- it detects the gateway URL `http://hermes-gateway:8642`
- it detects the dashboard URL `http://hermes:9119`
- chat can reach the configured Hermes provider
- sessions/tool activity are visible, if supported by the pinned Hermes image
- terminal/file/memory panes are either usable or clearly marked unsupported

## Shut Down

```bash
docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -p avg \
  --profile command-center \
  stop hermes-workspace hermes-gateway
```

## Findings To Record

After the evaluation, record:

- whether the pinned `nousresearch/hermes-agent` image exposes enough gateway
  and dashboard APIs for Hermes Workspace enhanced mode
- whether the UI is useful for Averray operations without terminal logs
- whether the Workspace should stay as an optional companion, replace the
  built-in dashboard, or give way to a small custom Averray operator UI
- any security gaps before broader use
