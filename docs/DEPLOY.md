# Deploy runbook — Hermes monitor stack

The `slack-operator` (and its sibling Node services) run from one image,
`avg-node-runtime`, built by `ops/Dockerfile.node`. That image serves the
redesigned monitor SPA as the **only board at `/monitor`**. The legacy
HTML monitor has been retired (`renderMonitorHtml` deleted); `/monitor/next`
302s to `/monitor/`. The `/monitor/events` + `/monitor/stream` data
endpoints and `/monitor/manifest.webmanifest` remain.

There are two ways to deploy. **Registry-pull is recommended**;
build-on-server is the fallback.

> Compose invocation below uses `-f ops/compose.yml -f ops/compose.prod.yml`
> and `--env-file ops/.env.prod`. Adjust to your actual prod overlay set
> (e.g. add `-f ops/compose.cloudflare-access.yml`) and env file.

---

## 1. Registry-pull (recommended)

CI builds `avg-node-runtime` on every push to `main` and pushes it to GHCR
as:

- `ghcr.io/depre-dev/averray-reference-agent:latest`
- `ghcr.io/depre-dev/averray-reference-agent:sha-<short-sha>` (immutable —
  use this for reproducible deploys + rollback)

The compose services pull whatever `AVERRAY_IMAGE` points at
(`image: ${AVERRAY_IMAGE:-avg-node-runtime}`).

### One-time VPS setup

If the GHCR package is **private** (the default for org packages), log the
VPS's Docker in once with a PAT that has `read:packages`:

```sh
echo "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin
```

(Or make the package public in the repo's *Packages* settings and skip this.)

### Deploy

Pin to the SHA you want to ship (find it on the merged PR / Actions run):

```sh
export AVERRAY_IMAGE=ghcr.io/depre-dev/averray-reference-agent:sha-<short-sha>
docker compose --env-file ops/.env.prod -f ops/compose.yml -f ops/compose.prod.yml pull
docker compose --env-file ops/.env.prod -f ops/compose.yml -f ops/compose.prod.yml up -d
```

No build runs on the box; you ship the exact artifact CI built and tested.
Putting `AVERRAY_IMAGE=...` in `ops/.env.prod` instead of exporting it makes
the value sticky across deploys.

### Rollback

Point `AVERRAY_IMAGE` at a previous `sha-…` tag and re-run `pull` + `up -d`.
No rebuild, seconds to recover.

---

## 2. Build-on-server (fallback)

Unchanged from before — leave `AVERRAY_IMAGE` unset so compose uses the
locally-built `avg-node-runtime`:

```sh
git pull
docker compose --env-file ops/.env.prod -f ops/compose.yml -f ops/compose.prod.yml build
docker compose --env-file ops/.env.prod -f ops/compose.yml -f ops/compose.prod.yml up -d
```

---

## After deploy

- Board (the only one): `https://monitor.averray.com/monitor`
- Health/manifest (lists active routes): `GET /health`

The redesigned board is the single pipeline at `/monitor`. The legacy HTML
monitor has been retired — `renderMonitorHtml` is deleted and there is no
`/monitor/legacy`. `/monitor/next` (the old preview path) 302s to
`/monitor/`. Operator actions that lived only in the legacy UI (recheck,
Codex dispatch) are tracked for wiring onto the new board in
`docs/MONITOR_ACTION_PARITY.md`.

---

## Optional: the Tier-1 surface-sweep runner (`testbed-runner` profile)

Off by default. Enable it so queued `surface_sweep` missions (e.g. the
post-deploy step in the platform repo's `deploy-production.yml`) actually
execute — without it they queue forever and the board shows "no healthy
runner". It's a profile-gated service, mirroring `codex-runner` /
`claude-runner`.

**`.env.prod` edits:**
```
TESTBED_MISSION_RUNNER_ENABLED=1
# Public-only T1 route sweeps should target the public site. Keep
# AVERRAY_APP_BASE_URL pointed at the gated operator app for signed-in T2/T3
# sessions.
TESTBED_SURFACE_SWEEP_BASE_URL=https://averray.com
# Optional: the env's truth boundary the honesty check asserts. Set to
# testnet / demo / local-simulation when the deployed env is non-production so
# data-bearing surfaces must carry that marker; leave empty otherwise.
AVERRAY_TESTBED_EXPECTED_BOUNDARY=
```

**Bring it up under its profile** (shares the `avg-data` volume, so it reads
the same mission queue the `/monitor/testbed-missions` endpoint writes):
```
docker compose --env-file ops/.env.prod --profile testbed-runner \
  -f ops/compose.yml -f ops/compose.prod.yml up -d testbed-mission-runner
```

The runtime image already ships system Chromium at `/usr/bin/chromium`
(`ops/Dockerfile.node`), and the service points the Playwright executor at it
via `TESTBED_MISSION_BROWSER_EXECUTABLE_PATH` — no extra browser install.

**Verify it's online** (no secrets printed):
```
docker compose --env-file ops/.env.prod -f ops/compose.yml -f ops/compose.prod.yml \
  logs --since 5m testbed-mission-runner | grep -iE "online|idle|claimed|chromium|disabled" | tail -10
```
A healthy runner logs `idle` (online, waiting). Once it claims a sweep, the
per-route report appears on the board and the entrypoint's "no healthy runner"
note flips to online.

---

## Optional: C3 specialist runners (`test-writer-runner`, `security-runner`, `docs-runner` profiles)

Off by default. The C3 specialists are Claude-family runners pinned to one
internal role, so each claims ONLY tasks whose `agent` matches the pin:

| Agent | Profile | Service | Branch prefix | Scope |
| --- | --- | --- | --- | --- |
| `test-writer` | `test-writer-runner` | `test-writer-task-runner` | `test-writer/*` | low-risk test coverage |
| `security` | `security-runner` | `security-task-runner` | `security/*` | proposes security-focused fixes/reviews; high-risk findings escalate |
| `docs` | `docs-runner` | `docs-task-runner` | `docs/*` | proposes docs updates for changed surfaces |

The queue's per-agent claim filter keeps specialist runners isolated from the
`claude-runner` and from each other. Without the matching profile enabled,
approved specialist tasks queue forever. Same gates as the `claude-runner`: the
startup billing-route verification (fails loud on a mismatch and refuses to
claim), the **fail-closed** worker repo allow-list
(`CLAUDE_BRANCH_WORKER_ALLOWED_REPOS`, shared), `HALT_FILE`, and the heartbeat.
Each opens a normal PR through the usual human review gate — no auto-merge,
auto-approve, deploy authority, or security auto-action.

**`.env.prod` edits:**
```
TEST_WRITER_TASK_RUNNER_ENABLED=1
SECURITY_TASK_RUNNER_ENABLED=1
DOCS_TASK_RUNNER_ENABLED=1
# Shared with the claude-runner; still fails closed when empty. Opt repos in:
CLAUDE_BRANCH_WORKER_ALLOWED_REPOS=owner/repo
# Plus the same Claude worker auth/billing you use for the claude-runner
# (CLAUDE_WORKER_AUTH_MODE + CLAUDE_CODE_OAUTH_TOKEN, or api-mode ANTHROPIC_API_KEY
# + CLAUDE_WORKER_DAILY_BUDGET). The runner verifies the route at startup.
```

**Bring it up under its profile** (shares the `avg-data` volume, so it reads the
same task queue the operator/autopilot approves into):
```
docker compose --env-file ops/.env.prod --profile test-writer-runner \
  -f ops/compose.yml -f ops/compose.prod.yml up -d test-writer-task-runner
docker compose --env-file ops/.env.prod --profile security-runner \
  -f ops/compose.yml -f ops/compose.prod.yml up -d security-task-runner
docker compose --env-file ops/.env.prod --profile docs-runner \
  -f ops/compose.yml -f ops/compose.prod.yml up -d docs-task-runner
```

It is controlled independently of the `claude-runner`:
`TEST_WRITER_TASK_RUNNER_ENABLED`, `SECURITY_TASK_RUNNER_ENABLED`, and
`DOCS_TASK_RUNNER_ENABLED` each map to that container's own
`CLAUDE_TASK_RUNNER_ENABLED`, so enabling the claude-runner does not enable a
specialist (and the agent pin means none claims another agent's tasks).

**Verify it's online** (no secrets printed):
```
docker compose --env-file ops/.env.prod -f ops/compose.yml -f ops/compose.prod.yml \
  logs --since 5m test-writer-task-runner | grep -iE "test-writer|online|idle|claimed|REFUSING|disabled" | tail -10
docker compose --env-file ops/.env.prod -f ops/compose.yml -f ops/compose.prod.yml \
  logs --since 5m security-task-runner | grep -iE "security|online|idle|claimed|REFUSING|disabled" | tail -10
docker compose --env-file ops/.env.prod -f ops/compose.yml -f ops/compose.prod.yml \
  logs --since 5m docs-task-runner | grep -iE "docs|online|idle|claimed|REFUSING|disabled" | tail -10
```
A healthy runner logs `<agent> runner is online; no approved <agent> task is
waiting` (idle). On a billing-route mismatch it logs `REFUSING TO CLAIM` and
writes a `misconfigured` heartbeat rather than running on the wrong route.

---

## Optional: the T4 Tier-2 gold-path tester (`command` executor)

Off by default. The Tier-2 LLM gold-path tester drives the product's agent gold
path (onboard → claim → submit → verify → payout/SBT → receipt) and judges it
honestly. It runs through the testbed runner's **`command` executor** — point a
testbed runner at the gold-path entry:

```
TESTBED_MISSION_RUNNER_ENABLED=1
TESTBED_MISSION_RUNNER_EXECUTOR=command
TESTBED_MISSION_RUNNER_ARGS=services/slack-operator/dist/gold-path-mission-entry.js
TESTBED_MISSION_ENVIRONMENT=testnet      # T5 binds mutation; mainnet is read-only by construction
TESTBED_SESSION_SIGNER_URL=http://test-wallet-signer:8791   # T3 session (API Bearer); key never enters the model
TESTBED_GOLDPATH_DEEP=0                   # opus for deep/critical; sonnet otherwise (A4)
TESTBED_GOLDPATH_LIVE=0                   # see note below
```

Gold-path missions are queued with `mode: "gold_path"` and **land `requested`** —
they stay behind the operator approve gate (`POST /monitor/testbed-missions/{id}/approve`)
and never auto-run. Mutation is bound by T5: only `local/testnet/staging` may
mutate; **mainnet is structurally read-only**.

> **The runner claims ALL ready missions** (no per-mode filter yet), so run the
> gold-path command executor in a deployment whose queue contains only
> `gold_path` missions, or wait for the per-mode-claim follow-up. A mixed queue
> would route surface-sweep missions through the gold-path entry.

> **Live driver is a follow-up.** This PR ships the executor — the T5 mutation
> binding, T3 session, A4 model policy, the honest self-judge, the report, and
> the approve-gate wiring — with a deterministic fake driver for CI. The live
> **Claude Agent SDK + Playwright-MCP** driver is not wired yet: with
> `TESTBED_GOLDPATH_LIVE` unset (or set, until the driver lands) the runner emits
> an honest **"not executed"** report rather than a fake pass.

---

## Assumptions / things to confirm in your environment

- The image name assumes the GitHub org is `depre-dev` (i.e.
  `ghcr.io/<owner>/averray-reference-agent`). CI derives it from
  `github.repository`, so it tracks the repo automatically.
- GHCR push uses the workflow's `GITHUB_TOKEN` with `packages: write`. The
  org/repo must allow Actions to create packages (Settings → Actions →
  Workflow permissions, and the package's access settings).
- The first push to `main` creates the package; set its visibility +
  link it to the repo as desired.
