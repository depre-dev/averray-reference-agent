# Deploy runbook — Hermes monitor stack

The `slack-operator` (and its sibling Node services) run from one image,
`avg-node-runtime`, built by `ops/Dockerfile.node`. That image now also
contains the redesigned monitor SPA (served at `/monitor/next`; the legacy
HTML monitor stays at `/monitor`).

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

- New board (preview): `https://monitor.averray.com/monitor/next`
- Legacy monitor (unchanged): `https://monitor.averray.com/monitor`
- Health/manifest (lists active routes): `GET /health`

The legacy monitor stays the default until the redesign is validated on a
real shift; cutover (mounting the new UI at `/monitor` and retiring the
legacy HTML) is a separate, deliberate change.

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
