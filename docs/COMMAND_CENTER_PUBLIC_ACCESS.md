# Command Center Public Access

This runbook publishes Hermes Workspace at a stable HTTPS hostname while keeping
the Averray reference agent services private. Use this when you need to reach
the command center from a browser without an SSH tunnel.

## Recommended Shape

Use Cloudflare Zero Trust:

- Cloudflare Tunnel connector runs on the VPS as `cloudflared`.
- Hermes Workspace still listens only inside Docker and on VPS localhost.
- The public hostname is protected by Cloudflare Access before traffic reaches
  the VPS.
- `hermes-gateway`, `hermes` dashboard, Postgres, and Slack operator ports stay
  private.

This is stronger than exposing Caddy/Nginx directly because the VPS does not
need inbound HTTP/HTTPS ports for the command center.

## Cloudflare Setup

In Cloudflare One:

1. Go to **Networks > Connectors > Cloudflare Tunnels**.
2. Create a tunnel named `averray-command-center`.
3. Choose the Docker connector option and copy the tunnel token.
4. Add a public hostname, for example:
   - hostname: `command.example.com`
   - service: `http://hermes-workspace:3000`
5. Go to **Access controls > Applications**.
6. Add a **Self-hosted** application for the same hostname.
7. Add an Allow policy for explicit operator email addresses only.

Do not create policies that include `Everyone` or all One-Time PIN users. If
you use One-Time PIN, pair it with an explicit email list or tightly scoped
email domain.

## VPS Environment

Add the tunnel token to `.env.prod`:

```dotenv
CLOUDFLARED_IMAGE=cloudflare/cloudflared:latest
CLOUDFLARED_TUNNEL_TOKEN=paste-cloudflare-tunnel-token-here
```

When accessing Workspace through HTTPS via Cloudflare, use secure cookies and
trust proxy headers:

```dotenv
HERMES_WORKSPACE_COOKIE_SECURE=1
HERMES_WORKSPACE_TRUST_PROXY=1
```

Cloudflare Access can be the only browser-facing login gate. Use this only when
the Access application allows explicit operator emails and the Workspace port
remains localhost-only on the VPS:

```dotenv
HERMES_WORKSPACE_ALLOW_INSECURE_REMOTE=1
HERMES_WORKSPACE_PASSWORD=
```

If you prefer defense in depth, leave `HERMES_WORKSPACE_ALLOW_INSECURE_REMOTE=0`
and set a strong `HERMES_WORKSPACE_PASSWORD`; Workspace will ask for that
password after Cloudflare Access login.

Keep these existing bindings as localhost-only:

```dotenv
HERMES_WORKSPACE_PORT=3000
HERMES_GATEWAY_PORT=8642
```

## Start

From the VPS checkout:

```bash
docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -f ops/compose.cloudflare-access.yml \
  -p avg \
  --profile command-center \
  up -d hermes hermes-gateway hermes-workspace cloudflared
```

## Verify

Check the services:

```bash
docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -f ops/compose.cloudflare-access.yml \
  -p avg \
  --profile command-center \
  ps hermes-gateway hermes-workspace cloudflared
```

Watch the tunnel logs:

```bash
docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -f ops/compose.cloudflare-access.yml \
  -p avg \
  --profile command-center \
  logs -f --tail=120 cloudflared
```

From a browser:

1. Open `https://command.example.com`.
2. Confirm Cloudflare Access asks for your approved login.
3. If `HERMES_WORKSPACE_ALLOW_INSECURE_REMOTE=0`, confirm Workspace also asks
   for `HERMES_WORKSPACE_PASSWORD`. If
   `HERMES_WORKSPACE_ALLOW_INSECURE_REMOTE=1`, confirm Workspace opens without a
   second password prompt.
4. Run `operator status`.
5. Run `operator status details`.

From a machine that is not authenticated with Access, the hostname should show
the Cloudflare Access login screen, not Hermes Workspace.

## Safety Checks

From outside the VPS, these ports should not be reachable directly:

- `3000` Workspace UI
- `8642` Hermes gateway
- `9119` Hermes dashboard
- Postgres
- Slack operator HTTP port

On the VPS, the local checks should still work:

```bash
curl -fsS http://127.0.0.1:3000 >/dev/null
curl -fsS http://127.0.0.1:8642/health
curl -fsS http://127.0.0.1:9119/api/status
```

## Stop Public Access

To disable public command-center access while keeping the local command center
running:

```bash
docker compose --env-file .env.prod \
  -f ops/compose.yml \
  -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml \
  -f ops/compose.cloudflare-access.yml \
  -p avg \
  --profile command-center \
  stop cloudflared
```

You can also disable or delete the Access application in Cloudflare One.

## References

- Cloudflare Tunnel publishes local services through outbound-only
  `cloudflared` connections without exposing inbound origin ports:
  <https://developers.cloudflare.com/tunnel/>
- Cloudflare Tunnel public hostnames map a hostname to a local service URL:
  <https://developers.cloudflare.com/tunnel/routing/>
- Cloudflare Access self-hosted applications protect internal tools with
  identity policies:
  <https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/>
- Cloudflare warns against broad Access policies such as `Everyone` or all
  One-Time PIN users:
  <https://developers.cloudflare.com/cloudflare-one/policies/access/>
