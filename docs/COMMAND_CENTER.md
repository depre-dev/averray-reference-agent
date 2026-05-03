# Command Center Baseline

This runbook operates Hermes Workspace as the optional command center for the
Averray reference agent. It is not part of the default smoke path, but the
baseline below has been verified on the reference VPS.

## Decision Snapshot

Hermes Workspace is now a working companion command center. It attaches to an
existing Hermes gateway and Hermes dashboard pair:

- gateway API on `:8642`
- dashboard API on `:9119`
- workspace UI on `:3000`

The reference stack already runs the built-in Hermes dashboard on `9119`. This
overlay adds a separate Hermes gateway process and the Workspace UI, both
published only to VPS localhost.

Use the surfaces this way:

- Slack is the durable operator/audit channel. Prefer it for mutating production
  commands that should leave a channel-visible trail.
- Hermes Workspace is the richer inspection and guided execution UI. It is good
  for status checks, dry-run previews, tool activity inspection, and controlled
  execution when the operator is actively watching the session.
- Both surfaces route short Averray commands through the same MCP operator
  command handler and workflow tools, so they share run/session/draft state.

Verified golden path:

- Workspace: `status last wikipedia citation repair` returns the latest
  submitted run.
- Workspace: `run one wikipedia citation repair if safe` performs a dry run
  preview first, then can complete claim, draft, validation, and submit when the
  operator explicitly asks to run with `dryRun: false`.
- Slack: `@Averray Reference Agent status last wikipedia citation repair`
  returns the same latest run, including Slack permalink when the run was
  initiated from Slack.

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

If you only need Workspace and the gateway-backed chat/tools, this shorter
tunnel is enough:

```bash
ssh -N -L 3000:127.0.0.1:3000 ubuntu@YOUR_VPS
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

- no yellow `Authentication required` banner appears
- the left sidebar session list loads without `/api/sessions` `401`
- chat can answer a tiny prompt such as `say ok`
- `status last wikipedia citation repair` uses the Averray MCP status tool and
  returns the same latest run that Slack returns
- `run one wikipedia citation repair if safe` gives a dry-run preview before
  any claim/submit mutation
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

## Current Findings

- The pinned `nousresearch/hermes-agent` gateway image exposes enough gateway
  and dashboard APIs for Workspace chat, MCP tool activity, sessions, skills,
  memory, config, and jobs in this deployment mode.
- Hermes Workspace is useful for Averray operations without terminal logs,
  especially for dry-run previews and interactive inspection.
- Slack remains the preferred durable audit channel for operator-triggered
  mutations; Workspace-created runs are still visible to Slack status commands,
  but their Slack permalink is `n/a` because Slack did not initiate them.
- The command center should stay as an optional companion to Slack rather than
  replace Slack yet.
- Do not broaden network exposure. Keep Workspace and gateway bound to VPS
  localhost and reach them through SSH/Tailscale tunnels.

## Future Work

- Add a small Averray-specific operator dashboard if Workspace proves too broad
  for day-to-day operations.
- Add richer run detail views that show budget, open jobs, evidence summary,
  proposal counts, validation status, and Slack permalink in one place.
- Revisit public or team-wide access only after authentication, audit logging,
  and command allowlists are explicitly reviewed.
