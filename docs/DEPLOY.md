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

## Assumptions / things to confirm in your environment

- The image name assumes the GitHub org is `depre-dev` (i.e.
  `ghcr.io/<owner>/averray-reference-agent`). CI derives it from
  `github.repository`, so it tracks the repo automatically.
- GHCR push uses the workflow's `GITHUB_TOKEN` with `packages: write`. The
  org/repo must allow Actions to create packages (Settings → Actions →
  Workflow permissions, and the package's access settings).
- The first push to `main` creates the package; set its visibility +
  link it to the repo as desired.
