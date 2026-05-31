# Hermes Go-Live — Activation & Operator Runbook

- **Status:** Operational runbook. The **verified** sequence for arming the dormant orchestration capabilities on the prod VPS, and the burn-in procedure before autopilot.
- **Date:** 2026-05-31
- **Audience:** the operator (human), on the prod host. Agents do **not** SSH to prod.
- **Companions:** [`HERMES_ROADMAP.md`](./HERMES_ROADMAP.md) (what's built), [`HERMES_ORCHESTRATION_DESIGN.md`](./HERMES_ORCHESTRATION_DESIGN.md) (§O4 autonomy), [`HERMES_PHASE2_DESIGN.md`](./HERMES_PHASE2_DESIGN.md) (D3 anomaly auto-pause), [`HERMES_PHASE3_DESIGN.md`](./HERMES_PHASE3_DESIGN.md) (B2 self-healing).

> **Why this doc exists.** The features ship **dormant** (env-gated, default off) and are armed by editing the prod env file — *not* by running env assignments in the shell. The first activation took several rounds because of three repeatable gotchas; they're all written down below so re-activation is copy-paste once.

---

## The three gotchas (read first)

1. **Env flags go in the FILE, not the shell.** Typing `D3_ANOMALY_PAUSE_ENABLED=1` at the prompt sets a throwaway shell var that `docker compose --env-file` never reads. The value must live in the prod env file.
2. **The env file is `.env.prod` at the repo ROOT** — `/srv/averray-reference-agent/.env.prod`, **not** `ops/.env.prod`. A wrong `--env-file` path makes every var resolve blank → `service "hermes" has neither an image nor a build context specified: invalid compose project`.
3. **Never run `--remove-orphans`.** Compose warns about orphans (`hermes-gateway`, `cloudflared`, `hermes-workspace`) only because a partial `-f` list doesn't name them. They are live services — `--remove-orphans` would **delete** them. Fix the warning by passing the **full `-f` list** instead.

A fourth, subtler one: when you paste a block that documents the keys with leading `#`, you paste **comments**. Uncomment them (see below) — don't assume a paste armed them.

---

## Prereqs

- You are `ssh`'d to the prod host and in the stack dir: `cd /srv/averray-reference-agent`.
- The stack is already deployed and healthy (the normal deploy ran). This runbook only **arms gated features** on top of a running stack.
- Keep **autopilot OFF** through activation and the burn-in. Arming D3/B2/runners is safe (they propose, they don't merge/deploy); autopilot is the separate, later flip.

Define the compose alias once (full `-f` list — adjust filenames to match your deploy):

```bash
cd /srv/averray-reference-agent
C="docker compose -p avg --env-file .env.prod \
  -f ops/compose.yml -f ops/compose.prod.yml \
  -f ops/compose.command-center.yml -f ops/compose.cloudflare-access.yml"
```

---

## Step 1 — arm the gated features in `.env.prod`

These keys ship commented/defaulted-off. Uncomment + set them **in the file**. If your file ships them as commented lines (`# KEY=...`), strip the leading `# ` for exactly these keys:

```bash
sed -i -E 's/^# (D3_ANOMALY_PAUSE_ENABLED|B2_SELF_HEALING_ENABLED|B2_SELF_HEALING_REPO|CLAUDE_BRANCH_WORKER_ALLOWED_REPOS|HERMES_DISPATCH_ALLOWED_REPOS)=/\1=/' .env.prod
```

Target state (verify by grep — **no leading `#`**):

```bash
grep -nE '^(D3_ANOMALY_PAUSE_ENABLED|B2_SELF_HEALING_ENABLED|B2_SELF_HEALING_REPO|CODEX_BRANCH_WORKER_ALLOWED_REPOS|CLAUDE_BRANCH_WORKER_ALLOWED_REPOS|HERMES_DISPATCH_ALLOWED_REPOS)=' .env.prod
```

| Key | Value | Effect |
|---|---|---|
| `D3_ANOMALY_PAUSE_ENABLED` | `1` | tiered anomaly auto-pause (soft→supervised, hard→`HALT_FILE`) |
| `B2_SELF_HEALING_ENABLED` | `1` | self-healing **proposes** fix tasks (never auto-runs; D3-interlocked) |
| `B2_SELF_HEALING_REPO` | `averray-agent/agent` | repo B2 proposes fixes against |
| `CODEX_BRANCH_WORKER_ALLOWED_REPOS` | `averray-agent/agent,depre-dev/averray-reference-agent` | fail-closed allowlist (Codex runner) |
| `CLAUDE_BRANCH_WORKER_ALLOWED_REPOS` | `averray-agent/agent,depre-dev/averray-reference-agent` | fail-closed allowlist (Claude runner) |
| `HERMES_DISPATCH_ALLOWED_REPOS` | `averray-agent/agent` | fail-closed dispatch allowlist |

> Allowlists are **fail-closed**: empty = nothing dispatched. Scope them to exactly the repos you intend.

---

## Step 2 — bring up the runners + reload the operator

```bash
$C --profile claude-runner up -d claude-task-runner          # Claude greenfield runner
$C --profile test-writer-runner up -d test-writer-runner     # C3 specialist (#311) — optional, off by default
$C up -d --force-recreate slack-operator                     # reload D3/B2 env + register routines
```

`--force-recreate` on `slack-operator` is required — it re-reads `.env.prod`. Without it the container keeps the old (off) env.

---

## Step 3 — verify it actually armed (don't trust the paste)

**3a. Container sees the flags:**
```bash
docker exec avg-slack-operator-1 sh -c 'printenv | grep -E "D3_ANOMALY_PAUSE_ENABLED|B2_SELF_HEALING_ENABLED|B2_SELF_HEALING_REPO|HERMES_DISPATCH_ALLOWED_REPOS"'
```
Expect `D3_ANOMALY_PAUSE_ENABLED=1`, `B2_SELF_HEALING_ENABLED=1`, `B2_SELF_HEALING_REPO=averray-agent/agent`, `HERMES_DISPATCH_ALLOWED_REPOS=averray-agent/agent`.

**3b. Routines actually running** (the `slack_operator_starting` summary object does **not** list D3/B2 — look for the *action* lines instead; note `anomaly` ≠ `anomalies`, so use a loose pattern):
```bash
docker logs avg-slack-operator-1 2>&1 | grep -iE 'anomal|self.?heal|suspend|escalat'
```
A `"msg":"b2_self_healing_acted"` line with `action:"propose"` entries = B2 is live and proposing. No anomaly line = nothing tripped (good).

---

## Step 4 — the supervised burn-in (autopilot stays OFF)

Activation does **not** turn on autopilot. It arms the *propose / assist* layer. Now run supervised:

1. **Clear B2's opening queue.** On first arm, B2 proposes fixes for any pre-existing failed/stale tasks (e.g. old testbed missions). These are **proposals** (`action:"propose"`) and will not run until you approve them on the board. Triage them: approve the good ones, dismiss the noise.
2. **Watch the approved tasks run** through the Claude/Codex runners — CI green, narrow diffs, sane routing.
3. **Watch D3** — confirm it stays quiet under normal load and that a deliberate anomaly (e.g. a retry loop) actually trips it to supervised / `HALT_FILE`.
4. **Watch routing quality** — Hermes's proposed agent + risk-tier calls. This is the data that tells you whether autopilot's judgment (same model, `deepseek-v4-pro`) is trustworthy. See [`HERMES_AGENT_MODELS_AND_EFFORT.md`](./HERMES_AGENT_MODELS_AND_EFFORT.md) §4.

Only after the burn-in holds up do you consider the autopilot flip — a **separate, deliberate** action (board switch / chat "Hermes, you're in charge until …"), gated by allowlist + budget + not-suspended + not-HALT + `riskTier != high`, and it **only auto-approves DISPATCH** — never merge, never deploy.

---

## Rollback / panic

- **Stop all mutating work now:** `touch` the `HALT_FILE` (path per the ops env) — every runner/dispatch stops.
- **Disarm a feature:** set its flag back to `0` in `.env.prod`, then `$C up -d --force-recreate slack-operator`.
- **Stop a runner:** `$C stop claude-task-runner` (and/or `test-writer-runner`).
- **Autopilot off:** flip the board switch / clear the autonomy mode; it auto-expires at the stated time else a 4h cap regardless.

---

## Invariants (never violated by activation)

- Merge and deploy stay **human-gated**, always.
- High-risk surfaces (contracts / chain-settlement / secrets / migrations / deploy-ops) stay **rule-bound to Codex**.
- Allowlists are **fail-closed**; testnet-only wallets; B2 proposes but never auto-runs; D3 owns the autopilot-suspended flag.
- Agents do not SSH to prod. This runbook is operator-run.

---

*End of go-live runbook. Activation arms the propose/assist layer; autopilot is the later, separately-gated flip after a clean supervised burn-in.*
