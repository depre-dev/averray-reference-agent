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
- Set strong `HERMES_WORKSPACE_PASSWORD` and `HERMES_GATEWAY_API_KEY`
  values before starting the workspace.
- The Workspace image still checks the legacy `CLAUDE_API_TOKEN` name for
  OpenAI-compatible gateway calls. The Compose overlay maps that gateway alias
  to `HERMES_GATEWAY_API_KEY`.
- Do not set `CLAUDE_DASHBOARD_TOKEN` to the gateway bearer. The dashboard
  session path is separate from the OpenAI-compatible gateway API and a stale
  or mismatched dashboard token can produce `401 Unauthorized` session calls.
- Workspace writes session and Kanban metadata below `$HOME/.hermes`. The
  Compose overlay sets `HOME=/tmp/workspace-home` because the upstream image's
  default `/home/workspace` path is not writable in this deployment mode.
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

# Required because the gateway binds 0.0.0.0 inside Docker so the Workspace
# container can reach it. Use a long random value.
HERMES_GATEWAY_API_KEY=change-this-to-a-long-random-token

# Required by the compose overlay. Use a long random value.
HERMES_WORKSPACE_PASSWORD=change-this-to-a-long-random-password

# Keep 0 for plain HTTP over SSH/Tailscale localhost tunnels.
HERMES_WORKSPACE_COOKIE_SECURE=0
HERMES_WORKSPACE_TRUST_PROXY=0
```

To generate both secrets on the VPS:

```bash
grep -q '^HERMES_GATEWAY_API_KEY=' .env.prod || \
  printf '\nHERMES_GATEWAY_API_KEY=%s\n' "$(openssl rand -base64 32)" >> .env.prod

grep -q '^HERMES_WORKSPACE_PASSWORD=' .env.prod || \
  printf '\nHERMES_WORKSPACE_PASSWORD=%s\n' "$(openssl rand -base64 32)" >> .env.prod
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
- settings show model `hermes-agent` and chat can answer a tiny prompt such as
  `say ok`
- chat can reach the configured Hermes provider
- sessions/tool activity are visible, if supported by the pinned Hermes image
- terminal/file/memory panes are either usable or clearly marked unsupported

If chat returns `model "${HERMES_DEFAULT_MODEL}" not found`, the mounted
Hermes config is still using an unexpanded placeholder. The checked-in
`hermes/config/hermes.yaml` intentionally uses concrete Ollama Cloud defaults
for the gateway process:

```yaml
model:
  provider: ollama-cloud
  base_url: https://ollama.com/v1
  api_key_env: OLLAMA_API_KEY
  default: deepseek-v4-pro:cloud
```

If the Workspace UI shows `Authentication required — Hermes Agent rejected the
connection token` while `/v1/chat/completions` works, clear the Workspace
server-side and browser-side saved state after confirming only gateway token
aliases are present:

```bash
docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -p avg \
  --profile command-center \
  exec hermes-workspace env | grep -E 'HERMES_API|CLAUDE_API|CLAUDE_DASHBOARD|HOME'
```

The expected state is that `HERMES_API_TOKEN` and `CLAUDE_API_TOKEN` are set,
while `CLAUDE_DASHBOARD_TOKEN` is absent.

Then clear Workspace server-side state and recreate the container:

```bash
docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -p avg \
  --profile command-center \
  exec hermes-workspace sh -lc 'rm -rf /tmp/workspace-home/.hermes && mkdir -p /tmp/workspace-home/.hermes'

docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -p avg \
  --profile command-center \
  up -d --force-recreate hermes-workspace
```

Then clear site data for `127.0.0.1:3000` in the browser and reconnect.

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
