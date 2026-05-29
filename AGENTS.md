# Agent Collaboration Rules

This repo is built by multiple autonomous agents (Codex, Claude) plus a human
operator, and reviewed/operated by Hermes. Optimize for **small, reviewable PRs**
and **never break the production agent**. Read [docs/CODEX_HANDOFF_PROTOCOL.md](docs/CODEX_HANDOFF_PROTOCOL.md)
for the build→review→approve model and [docs/HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md](docs/HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md)
for where this is all heading.

---

## Durable invariants

**These hold no matter how far the orchestration evolves — including after the
multi-agent dashboard tool is fully built.** Everything *else* in this doc describes
how things work **today** and must be updated as phases land (see the last bullet).

1. **Humans own merge and deploy.** No agent — however autonomous Hermes becomes —
   auto-merges or auto-deploys. Ever.
2. **CI (`ci.yml`) is the merge gate.** Never bypass a failing check.
3. **No direct pushes to `main`.** One narrow, reviewable PR per task.
4. **The agent wallet stays testnet-only.** No mainnet key, no real-fund movement,
   no silently raised spend budgets.
5. **The `HALT_FILE` kill switch is always honored** by every mutating path. Never
   add a bypass.
6. **New power comes with a new guardrail.** Any capability that lets an agent
   (including Hermes) act on the world — dispatch/enqueue work, mutate GitHub, spend,
   submit — must ship with an explicit allowlist + budget **and** keep a human
   approval step. No ungated agent authority.
7. **Secrets are never committed, printed, or logged.**
8. **Verify chain facts before asserting them.** For any Polkadot / Substrate /
   Asset Hub behavior, address, runtime, fee, XCM, or settlement claim, check the
   `polkadot-docs` MCP (plus on-chain/runtime state or transaction evidence) before
   relying on memory or assumption. Never state a chain fact the product depends on
   without verifying it — the truth-boundary discipline, applied to the chain.
9. **Keep this file true.** When a change alters how agents work — a new runner, a
   dispatch path, a new gate, a role change — update `AGENTS.md` (and the affected
   docs) **in the same PR**. A stale working agreement is worse than none.

---

## Quick reference

```bash
npm ci            # install (CI uses this; locally `npm install` is fine)
npm run typecheck # tsc -b across all workspaces — must pass
npm test          # vitest run — must pass
npm run build     # tsc -b emit (only needed to validate emit / run dist)
```

If you touched `ops/`, the `Dockerfile`, or compose files, also validate what CI validates:

```bash
docker compose --env-file ops/.env.example -f ops/compose.yml -f ops/compose.prod.yml config
```

**Golden path for a task:** branch from fresh `origin/main` → make the change →
run `typecheck` + `test` (+ docker checks if relevant) → open a **narrow** PR with
notes → CI is the merge gate → a human approves and merges. Agents do not merge or
deploy.

---

## What this repo is

The external **Hermes + MCP reference agent** — the deployment that runs on the VPS.
It owns the worker runners, the task queue, the live monitor board, and the Averray
MCP servers. **Build orchestration/agent work here.**

The sibling **`averray-agent/agent`** ("the platform") is a *separate* repo: the
Averray product (operator app, contracts, indexer, SDK) plus the GitHub workflows
that SSH in to invoke Hermes. Don't edit the platform repo from here.

| Path | What lives there |
|---|---|
| `packages/averray-mcp/` | Main MCP server Hermes calls: tools, `invoke_agent_task`, operator commands, mutation policy |
| `packages/{wallet,receipt,trace,policy}-mcp/` | The other four MCP servers |
| `packages/monitor-ui/` | The board SPA (built into the Docker image with Vite — **not** committed) |
| `packages/{mcp-common,schemas}/` | Shared helpers + Zod schemas |
| `services/slack-operator/` | Serves the `/monitor` board, the Codex task queue + runner, testbed mission runner |
| `services/skills-observer/` | Sidecar ingesting Hermes skill files |
| `ops/` | Docker Compose stack (`compose.yml`, `compose.prod.yml`, `compose.command-center.yml`, `compose.cloudflare-access.yml`), migrations |
| `hermes/` | Hermes config (`hermes.yaml`, `policy.yaml`) + trace plugin |
| `test/unit/` | Vitest suites (alongside `*.test.ts(x)` colocated in packages) |

TypeScript monorepo: npm workspaces (`packages/*`, `services/*`), Node ≥ 22, ESM
(`"type": "module"`, `NodeNext`), `strict` on.

---

## Agent roles

- **Codex and Claude are builders.** Each works in its own branch/worktree, edits
  code, opens PRs, responds to review, and fixes failures. **Codex owns
  chain/settlement-adjacent work**; Claude takes UI, docs, and general code.
- **Hermes reviews and operates** — observes GitHub, reviews PR risk, runs
  read-only checks, reports to the PR/Slack/monitor, and proposes operator actions.
  Today Hermes is **recommendation-only**: it must not merge, deploy, submit work, or
  run guarded live mutations during a handoff. As Hermes gains orchestration powers
  (routing and dispatching tasks per the orchestration plan), those powers stay
  inside the **Durable invariants** above — gated, budgeted, and never extending to
  auto-merge or auto-deploy. Update this section when that lands.
- **Humans own approval.** A PASS verdict is a release *signal*, not a merge order.
  Merge and deploy are human-gated. No auto-merge.

---

## Branching & PRs

- **Never push to `main`.** Merges happen via PR after CI passes.
- One branch per task, owner-prefixed: `codex/<task>` or `claude/<task>`
  (e.g. `claude/monitor-agent-attribution`). Branch from fresh `origin/main`:
  `git fetch origin main && git checkout -b claude/<task> origin/main`. A worktree
  (`git worktree add`) is recommended so the primary checkout stays free.
- **Keep PRs narrow.** Split unrelated MCP, monitor, ops, and docs work into
  separate PRs. Rebase onto `origin/main` before marking ready if others landed
  nearby changes.
- Every PR includes:
  - **What changed** and why.
  - **Which checks ran** locally (`typecheck`, `test`, docker checks).
  - **Affected surfaces:** MCP servers, monitor, slack-operator, runners, ops/compose,
    Hermes config, migrations, secrets/config, docs, tests.
  - **Rollout/rollback notes** when ops, compose, migrations, the Hermes pin, or
    secret/config surfaces change.
  - **Known limits / skipped checks / follow-ups.**

Green CI is necessary but not sufficient — the Hermes handoff (per
CODEX_HANDOFF_PROTOCOL) is a separate release signal.

---

## Required checks (the CI gate)

`.github/workflows/ci.yml` is the merge gate. It runs:

1. **Typecheck + unit tests** on Node 22 (`npm ci` → `npm run typecheck` → `npm test`).
2. **Docker build** of `ops/Dockerfile.node` (also builds the in-image Vite SPA) +
   **compose config validation**. On `main` it also pushes the runtime image to GHCR.

Run the smallest relevant subset locally before opening a PR. **Do not bypass
failing checks.**

---

## Generated & build output — never commit it

`.gitignore` excludes `node_modules/`, `dist/`, `coverage/`, `data/`, `reports/`,
`*.tsbuildinfo`, `.env`, `.env.prod`. Don't commit any of them.

- The monitor SPA (`packages/monitor-ui`) is built **inside the Docker image**, not
  committed. Don't check in built assets.
- Local `data/` (task queue JSON, handoff events, Hermes memory) and `reports/` are
  runtime state — never commit them.

---

## Secrets, wallet & kill switch

This repo handles live credentials and an on-chain wallet — treat it as the most
security-sensitive surface.

- **Never commit or print secrets** — `.env.prod` (chmod 600), `OLLAMA_API_KEY`,
  `DATABASE_URL`, `AGENT_WALLET_PRIVATE_KEY`, gateway/API keys, SSH keys. Output is
  scrubbed for keys/tokens in some paths, but **never rely on sanitization** — don't
  emit secrets in the first place.
- **The agent wallet is testnet-only.** Never configure a mainnet key here, never
  move real funds, never raise policy budgets to enable spend without explicit
  operator sign-off.
- **`HALT_FILE` is the kill switch.** Mutating MCP tools fail closed when the halt
  file exists (`assertNoKillSwitch`). Don't add code paths that bypass it.

---

## MCP & policy safety

- Distinguish **read-only** tools from **mutating** ones (`averray_claim`,
  `averray_submit`, …). Mutating tools are gated by `packages/averray-mcp/src/mutation-policy.ts`
  (run-id requirement, attempt caps, allowlists) and `hermes/config/policy.yaml`
  (allowed task types, confidence-gated approval, USD/browser-step budgets).
- **Don't add an unguarded mutation tool or a dispatch capability without a guardrail.**
  Any future Hermes-driven enqueue/dispatch needs its *own* allowlist + budget gate
  (the marketplace policy does not cover it — see
  [docs/HERMES_INTEGRATION_MAP.md](docs/HERMES_INTEGRATION_MAP.md) Q4) and must keep
  the human approval step.
- Validate tool inputs with Zod schemas (`packages/schemas`); fail closed on
  malformed input.

---

## Runtime image pin

The Hermes runtime image is **sha-pinned** in `ops/.env.example`. **Never use
`latest` in production.** To bump: test the new tag in a branch, run the smoke flow
([docs/VPS_SMOKE.md](docs/VPS_SMOKE.md)), review upstream notes, then update the pin
deliberately in its own PR with rollout/rollback notes.

---

## Deployment

- **Agents don't SSH into production unless explicitly asked.** Deploys are
  operator-run.
- Production runs via `docker compose` on the VPS using the GHCR runtime image
  (pushed on `main`). The dashboard (`:9119`) and gateway (`:8642`) are exposed only
  to VPS localhost (SSH tunnel / Tailscale), never publicly.
- If a deploy or smoke fails, report the failing command and logs — don't retry
  blindly.

---

## Supply-chain hygiene

- Adding a dependency (npm) requires PR notes: upstream repo URL, weekly downloads,
  last-publish date, and one line on what it does.
- No `postinstall` lifecycle scripts without an explicit security justification in
  the PR body.
- Don't run untrusted setup/automation scripts while an authenticated `gh`/GitHub
  session is available to the same user.

---

## GitHub credential safety

- Prefer the GitHub connector/app for PR/issue/check operations; use `gh` only when
  it can't, and keep `gh` commands narrow and non-secret.
- Never run `gh auth token`, never print/paste a token into a shell, PR, log, or
  agent transcript. Use the lowest-privilege account/token practical, and rely on
  Actions `GITHUB_TOKEN` / approved service credentials for automation — not a human
  `gh auth login`.

---

## References

- [docs/CODEX_HANDOFF_PROTOCOL.md](docs/CODEX_HANDOFF_PROTOCOL.md) — build → review → approve roles & verdicts.
- [docs/HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md](docs/HERMES_MULTI_AGENT_ORCHESTRATION_PLAN.md) — the orchestration roadmap.
- [docs/HERMES_INTEGRATION_MAP.md](docs/HERMES_INTEGRATION_MAP.md) — confirmed source map of the agent/monitor internals.
- [docs/DEPLOY.md](docs/DEPLOY.md), [docs/VPS_SMOKE.md](docs/VPS_SMOKE.md), [docs/COMMAND_CENTER.md](docs/COMMAND_CENTER.md) — deploy, smoke, command center.
- [README.md](README.md) — project shape, local setup, Hermes pin.
