# Averray Reference Agent

External Hermes + MCP reference agent for studying how a future consumer agent uses Averray.

This project is intentionally separate from the Averray deploy/runtime. Hermes owns the agent loop, browser, memory, dashboard, and skills. The code here only provides Averray-specific MCP tools, policy gates, receipts, trace capture, and skill-file observation.

## v1 Shape

- Hermes Agent pinned Docker runtime.
- Default brain: Ollama Cloud `qwen3.5:cloud`.
- Comparison brain: Ollama Cloud `kimi-k2.5:cloud`.
- Five TypeScript MCP servers: Averray, wallet, receipt, trace, policy.
- One tiny Hermes Python plugin for trace events.
- Skills observer sidecar that ingests Hermes-generated skill files.
- Postgres for our state. Hermes keeps its own SQLite/Honcho memory.
- No public ports. Dashboard is exposed through Tailscale or SSH tunnel only.

## Local Setup

```bash
cd averray-reference-agent
cp ops/.env.example .env.prod
chmod 600 .env.prod
npm install
npm run build
npm run typecheck
npm test
```

Start the isolated stack:

```bash
docker compose --env-file .env.prod -f ops/compose.yml -p avg up -d
```

For the first VPS smoke, follow [docs/VPS_SMOKE.md](docs/VPS_SMOKE.md).

## Hermes Pin

The runtime image is pinned in [ops/.env.example](ops/.env.example):

```text
nousresearch/hermes-agent@sha256:8811f1809971ac558f8d5e311e22fe73dc2944616dda7295c98acb6028f9df08
```

Do not use `latest` in production. Test a new Hermes tag in a branch, run the smoke flow, then update the pin deliberately.

Run the reference prompt:

```bash
docker compose --env-file .env.prod -f ops/compose.yml -f ops/compose.prod.yml -p avg \
  exec hermes /opt/hermes/.venv/bin/hermes chat \
  --provider ollama-cloud \
  -m qwen3.5:cloud \
  -q "Find a Wikipedia citation-repair task on app.averray.com testnet, claim it, complete it, get paid. Use my wallet."
```

Access Hermes dashboard through an SSH tunnel. Run this from your laptop, not
from inside the VPS shell:

```bash
ssh -L 9119:localhost:9119 ubuntu@YOUR_VPS
```

Then open `http://127.0.0.1:9119`.

## Safety Defaults

- Testnet only.
- One wallet.
- No public dashboard port.
- The dashboard is bound to `127.0.0.1:9119` on the VPS for SSH/Tailscale access.
- Hermes runs dashboard mode with `--insecure` only because Docker publishes it
  to VPS loopback, not to the public interface.
- No Averray admin token.
- No shared Averray DB, Redis, Docker network, or volumes.
- No Docker socket.
- No direct Wikipedia edits.
- Mutating MCP tools check policy and kill switches.
