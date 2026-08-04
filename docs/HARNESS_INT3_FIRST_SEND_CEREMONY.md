# The first send — operator ceremony

The first time this system opens a pull request on a repository outside itself.

Everything below is read from the merged scripts, not from the work orders that
specified them. Flags, environment variables, and exit codes were taken from
`scripts/ops/int3d-build-packet.mjs` and `scripts/ops/int3c-send.mjs` at the
commit this document lands on.

**Nobody has run this end to end.** Each piece is tested and gated; the sequence
is not. Expect to stop at a step and fix something. Stopping is the intended
outcome of a first run, not a failure of it.

What *has* been executed against the real scripts, on 2026-08-04:

| checked | result |
|---|---|
| builder refuses a token in its environment | `INT3D_TOKEN_ENVIRONMENT_REFUSED`, exit **65** as documented |
| builder refuses missing flags | `INT3D_USAGE`, exit **64** as documented |
| builder refuses a `token` key nested in the authorization file | `INT3D_AUTHORIZATION_CONTAINS_TOKEN`, exit **67** as documented |
| that refusal does not echo the offending value | sentinel nested three deep, **0 occurrences** in output |

Nothing past that. Everything from Step 2 onward — the store read, the Harness
read, reconstruction, and the whole of shell B — is unexercised outside its
tests.

Read `HARNESS_INT3B_CREDENTIAL_RUNBOOK.md` first. It owns the credential
boundary; this document owns the sequence and does not restate it.

## Before anything

Two decisions, both yours, neither reversible by a later step:

1. **The target repository.** One repository, and it should be one you would not
   mind an unwanted commit landing on. Not this repository.
2. **The credential owner** — whose GitHub App, and where its private key lives.

Then, per the credential runbook: create the App, install it on exactly that one
repository, and mint an installation access token. Selected-repository scope.
Contents write, Pull requests write, and nothing else.

## The shape: two shells, and why

The builder reads the database. The sender holds the token. **Neither process may
do both**, and the builder enforces it — `GITHUB_INSTALLATION_TOKEN` present in
its environment is an immediate refusal with exit **65**, before it parses
arguments or touches the store.

So the ceremony runs in two terminals, and the split is the point:

| | shell A — builder | shell B — sender |
|---|---|---|
| `DATABASE_URL` | set | not needed |
| `GITHUB_INSTALLATION_TOKEN` | **must be absent** | set |
| reaches | dispatcher DB, Harness, artifacts | GitHub |

If you find yourself exporting the token in shell A to make something work, stop.
That is the mistake the refusal exists to catch.

## Step 0 — build, and prove the build

**Every command in this document runs from the repository root.** Both shells,
every step. A fresh terminal opens in your home directory, where the first
command fails with `Cannot find module '/Users/you/scripts/ops/…'` — which looks
like a missing script and is only a missing `cd`.

```bash
cd /path/to/averray-reference-agent
```

Both scripts import from the workspace packages' `dist/`. Build before anything
else:

```bash
npm run typecheck
```

**If that fails on a clean checkout** with errors like `Module '"@avg/mcp-common"'
has no exported member 'query'`, the incremental build state is stale — not the
code. `tsc -b` reads `.tsbuildinfo`, concludes a package is current, and leaves
`dist/` partially emitted. The symptom downstream is an `ERR_MODULE_NOT_FOUND`
naming a file that plainly exists in `src/`. This happened on a clean `main` on
2026-08-04; CI never sees it because CI always builds from scratch.

```bash
npx tsc -b --clean packages/* services/*
find . -maxdepth 3 -name "*.tsbuildinfo" -not -path "./node_modules/*" -delete
npm run typecheck
```

Then prove the toolchain actually works, using a refusal that costs nothing:

```bash
node scripts/ops/int3d-build-packet.mjs
```

Expect `INT3D_USAGE` and exit **64**. A module-resolution stack trace instead
means the build is still wrong, and you want to know that now rather than in
shell B with a live token.

## Step 1 — the authorization file

From the token-issuance response, strip the token and save what remains:

```json
{
  "identity": "<app>#installation-<id>",
  "repositorySelection": "selected",
  "permissions": {
    "contents": "write",
    "pullRequests": "write",
    "extraWriteScopes": []
  }
}
```

The builder walks this file recursively and refuses on any key named `token` at
any depth — exit **67**. It does not trust that you stripped it.

`extraWriteScopes` must be empty. The sender requires it, and a non-empty list
means the installation has authority the ceremony did not approve.

## Step 2 — build the packet (shell A, no token)

### What Step 2 needs to exist first

A live dispatcher database with a `handoff_ready` task, and a Harness run the
`harness` CLI can still read. Neither survives a teardown, so if the ceremony
environment is gone this step is not "one command" — it is a bring-up.

That bring-up is already written: **`HARNESS_INT2_CEREMONY_RUNBOOK.md` §1**
(disposable Postgres pair, pinned Harness checkout, pilot profile, worker), then
**§2.6**, which produces exactly what this step consumes — a verified green
handoff that is complete and unactuated. Do not improvise a shorter path; §1.1
already carries the traps, including why `CEREMONY_ROOT` must not be a
`mktemp -d` under `/var/folders`.

Once that is standing, the four path arguments are:

| flag | what it must point at |
|---|---|
| `--repository-root` | a **local Git checkout of the target repository** — the one the PR will open against. Not the ceremony root, not the run workspace. The port pins `owner/name` and the base ref against it. |
| `--base-ref` | the base branch, e.g. `main` |
| `--patch-artifact-root` | a **content-addressed directory**: one file per artifact, named by its bare sha256 hex |
| `--payload-artifact-root` | an empty directory for the payload this step writes |

### The artifact root does not populate itself

`--patch-artifact-root` is read as `path.join(root, digest)`, where `digest` is
the artifact ref's `sha256` with the `sha256:` prefix removed, and the ref's URI
must be exactly `artifact://sha256/<digest>`.

The run's patch lives in Harness's own store, and **nothing in this repository
mirrors it into that directory.** Export it yourself:

```bash
harness artifacts get artifact://sha256/<digest> --out "$PATCH_ROOT/<digest>"
```

The filename must be the bare digest with no prefix and no extension, or the read
misses and the build refuses.

> Verified from source, not from a run: the flag-to-port mapping, the on-disk
> filename format, and the CLI's `--out`. The export step itself has not been
> executed end to end. If it turns out an operator needs this every time, it
> wants a packet rather than a paragraph.

```bash
node scripts/ops/int3d-build-packet.mjs \
  --work-item <id> \
  --repository-root <path> \
  --base-ref <ref> \
  --patch-artifact-root <path> \
  --payload-artifact-root <path> \
  --authorization ./authorization.json \
  --out ./packet.json
```

Also reads `DATABASE_URL`, `HARNESS_BIN` (default `harness`),
`HARNESS_DISPATCH_READ_TIMEOUT_MS`, `HALT_FILE` (default `/data/HALT`), and
`HARNESS_REPOSITORY_HALT_FILE`.

This reconstructs the handoff from durable inputs rather than reading a stored
one — the handoff was never persisted. `verifiedAt` still comes from the Harness
run's own timestamp, so it stays true however long afterwards you build.
`generatedAt` is when you built it, which is what that field means.

### If it refuses

| exit | meaning |
|---|---|
| 64 | usage — a required flag is missing |
| 65 | `GITHUB_INSTALLATION_TOKEN` is set — you are in the wrong shell |
| 66 | authorization file is not valid JSON, or not an object |
| 67 | authorization file contains a `token` key |
| 68 | `--out` already exists — it will not overwrite |
| 69 | no `AgentTask` for that work item |
| 70 | run binding unavailable or inconsistent |
| 71 | the bound run is not terminal |
| 72 | task lifecycle is not `handoff_ready` |
| 73 / 74 | global / repository HALT declared |

**71 and 72 are the interesting ones.** 71 means the run is still moving and
reconstruction would describe a state that has since changed. 72 can also mean a
*newer* task version exists that has not reached `handoff_ready` — the builder
takes the highest version, so a re-approved task blocks shipping the old one's
work. That is intended.

## Step 3 — pre-flight (shell B, token set)

```bash
node scripts/ops/int3c-send.mjs preflight \
  --handoff ./packet.json \
  --repo <owner/name> \
  --evidence ./preflight-evidence.json
```

This is a **live API call** against the real repository with the real token. It
reads authorization, resolves the repository, looks up the deterministic head,
reads the live base, and re-checks HALT. It cannot open a pull request — the
module containing that operation is not loaded on this path.

Expect `ready`, or `adoptable` if the exact PR already exists.

## Step 4 — read the evidence, then stop

Open `preflight-evidence.json` and check it by eye, not by exit code:

- `repositorySelection` is `selected`
- the repository is the one you chose, spelled the way you meant
- `contents` and `pullRequests` are `write`, `extraWriteScopes` is `[]`
- `liveBaseSha` matches what you expect the base branch to be
- `derivedHeadRef` is the `harness/*` ref you expect

This is the last point where nothing has happened yet. Everything before it is
reversible by deleting a file.

## Step 5 — the send

```bash
node scripts/ops/int3c-send.mjs send \
  --handoff ./packet.json \
  --repo <owner/name> \
  --evidence ./send-evidence.json \
  --confirm <owner/name>
```

`--confirm` must repeat `--repo` exactly, or exit **67**. It exists so that
recalling the previous command and editing it cannot reach a send.

**Run it once.** Do not loop, do not retry on a timeout, do not re-run because
the output looked wrong. If the process dies after GitHub accepted the create,
one re-run resolves it correctly: the sender finds the deterministic head, adopts
the existing PR, and does not create a second one. That is a deliberate
operator decision, not an automatic retry.

### Sender exit codes

| exit | meaning |
|---|---|
| 64 | usage |
| 65 | packet invalid — includes canonical-bytes mismatch |
| 66 | `GITHUB_INSTALLATION_TOKEN` absent or empty |
| 67 | `--confirm` missing or not equal to `--repo` |
| 68 | handoff not eligible for PR open |
| 69 / 70 | global / repository HALT |
| 71 | operation refused |
| 72 | evidence could not be written |

## Step 6 — record

Keep both evidence files. `send-evidence.json` carries the PR number, head commit
SHA, payload artifact hash, and confirmation that the remote head tree equals the
payload's `treeSha`.

Neither file contains the token. That is enforced by a test that runs the driver
with a sentinel token and greps every output for it — and the test has been seen
failing, so it is known to be capable of catching a leak.

**Merging the PR is a human action.** The sender has no merge, close, comment,
force-push, or branch-protection operation, and will not acquire one.

## If something goes wrong

Declare HALT first, then diagnose. `HALT_FILE` for global,
`HARNESS_REPOSITORY_HALT_FILE` for one repository. Both are re-checked by the
sender on every operation, including between pre-flight and send.

Revocation is in the credential runbook §"Rotation and revocation". The short
version: HALT, stop the sender, revoke the installation token, and keep HALT
active until a fresh pre-flight passes.

Preserve evidence rather than retrying. A failed first send that leaves a clear
record is a better outcome than a successful second attempt that leaves none.
