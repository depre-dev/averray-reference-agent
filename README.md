# Averray Reference Agent

External Hermes + MCP reference agent for studying how a future consumer agent uses Averray.

This project is intentionally separate from the Averray deploy/runtime. Hermes owns the agent loop, browser, memory, dashboard, and skills. The code here only provides Averray-specific MCP tools, policy gates, receipts, trace capture, and skill-file observation.

## v1 Shape

- Hermes Agent pinned Docker runtime.
- Default brain: Ollama Cloud `deepseek-v4-pro:cloud`.
- Comparison brain: Ollama Cloud `qwen3.5:cloud`.
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

After the read-only smoke passes and `.env.prod` contains a real testnet-only
wallet key, run the non-mutating claim-readiness smoke:

```bash
scripts/claim-readiness-smoke.sh
```

It checks wallet status, policy budget, compact Wikipedia discovery, one job
definition, and claim policy. It must not claim or submit.
If the wallet key was added after Hermes was already running, recreate the
Hermes service first so the container sees the updated environment.

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
  -m deepseek-v4-pro:cloud \
  -q "Find a Wikipedia citation-repair task on app.averray.com testnet, claim it, complete it, get paid. Use my wallet."
```

Access Hermes dashboard through an SSH tunnel. Run this from your laptop, not
from inside the VPS shell:

```bash
ssh -L 9119:localhost:9119 ubuntu@YOUR_VPS
```

Then open `http://127.0.0.1:9119`.

## Optional Command Center

Hermes Workspace can run as a richer operator UI through an opt-in Compose
overlay. It is disabled by default and keeps the workspace UI and gateway bound
to VPS localhost for SSH/Tailscale access. The current baseline supports
Workspace chat, Averray MCP tools, status checks, dry-run previews, and guarded
Wikipedia citation-repair execution.

Start with [docs/COMMAND_CENTER.md](docs/COMMAND_CENTER.md). Do not install
Workspace with `curl | bash` on the VPS, and do not expose the UI publicly.

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
- Mutating MCP tools check policy, kill switches, and framework-enforced
  mutation budgets. `averray_claim` requires a run id by default, allows one
  claim attempt per run, blocks fresh idempotency-key retries unless explicitly
  enabled, and can be narrowed with `AVERRAY_CLAIM_JOB_ALLOWLIST`.
  `averray_submit` also requires a run id by default, allows one submit attempt
  per run, blocks retries unless explicitly enabled, and can be narrowed with
  exact `AVERRAY_SUBMIT_SESSION_ALLOWLIST` and `AVERRAY_SUBMIT_JOB_ALLOWLIST`
  values.
- Submission proposals should be persisted before validation with
  `averray_save_draft_submission`. Resumed sessions can use
  `averray_get_draft_submission`, `averray_list_draft_submissions`, or pass
  `draftId` into `averray_validate_submission` / `averray_submit` so validation
  and submit use the exact same structured JSON object instead of reconstructed
  chat text.
- Wikipedia citation evidence helpers are read-only. They fetch pinned
  revisions, extract citation/source/archive evidence, check source URLs, and
  look up Wayback snapshots without editing Wikipedia or mutating Averray state.
- Optional Slack operational alerts can be enabled with `SLACK_WEBHOOK_URL`.
  They cover claim prechecks, claim/submit outcomes, local validation failures,
  TTL warnings, and inventory exhaustion/replenishment. See
  [docs/VPS_SMOKE.md](docs/VPS_SMOKE.md#slack-operational-alerts).
- Optional Slack inbound operator commands can be enabled with the
  `slack-operator` service. Socket Mode is supported for outbound-only VPS
  connectivity; signed HTTP slash/events endpoints are also available on
  localhost. See [docs/VPS_SMOKE.md](docs/VPS_SMOKE.md#slack-operator-commands).
- Slack and command-center operators can route short commands through
  `averray_handle_operator_command` instead of a free-form Hermes prompt. It
  recognizes `operator status`, `operator status details`,
  `run one wikipedia citation repair if safe`, and
  `status last wikipedia citation repair`. `operator status` calls the
  canonical read-only `averray_operator_status` MCP tool and returns wallet,
  budget, open-job, latest-run, safety, and safe-command metadata for any MCP
  client. Human surfaces can show compact identifiers by default while keeping
  full identifiers in the structured MCP JSON; add `details`, `full`, or
  `audit` to a status command when an operator needs the full run/session/draft
  audit trail. Repair commands call the Wikipedia workflow tool directly;
  latest-run status returns the current run/session/draft/submit state,
  including persisted Slack context when available, without mutating anything.
