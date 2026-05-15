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
  localhost. The same service can optionally post a daily operator brief,
  scheduled GitHub brief, ops-health check, and safe-work availability notices
  to Slack. See
  [docs/VPS_SMOKE.md](docs/VPS_SMOKE.md#slack-operator-commands).
- Optional public command-center access can be enabled with Cloudflare Access
  and the `cloudflared` overlay. This keeps Workspace and Hermes gateway ports
  private while publishing an Access-protected HTTPS hostname. See
  [docs/COMMAND_CENTER_PUBLIC_ACCESS.md](docs/COMMAND_CENTER_PUBLIC_ACCESS.md).
- Slack and command-center operators can route short commands through
  `averray_handle_operator_command` instead of a free-form Hermes prompt. It
  recognizes `what can you do for us`, `project memory`, `known projects`,
  `how do we deploy averray-agent/agent`, `admin readiness`, `admin proposal`,
  `propose merge for averray-agent/agent#123`,
  `propose deploy for averray-agent/agent sha abc1234`,
  `runbook for deploy averray-agent/agent`,
  `merge runbook for averray-agent/agent`, `secret rotation runbook`,
  `business ledger`,
  `ops health`, `github status`, `github open prs`, `github ci failures`,
  `github issue digest`, `github brief`, `daily github brief`,
  `what changed since last time`, `testbed e2e suite`,
  `platform e2e suite`, `run testbed e2e read-only`,
  `daily operator brief`, `find safe work`,
  `operator status`, `operator status details`,
  `run one wikipedia citation repair if safe`, and
  `status last wikipedia citation repair`. GitHub commands call
  `averray_github_status`, a read-only helper configured with `GITHUB_TOKEN`
  plus `GITHUB_DEFAULT_REPO` or `GITHUB_HELPER_REPOS`; it summarizes open PRs,
  open issues, and recent CI failures without mutating GitHub. `github brief`
  and `daily github brief` call `averray_github_brief`, which answers what
  changed since the last brief, what merged, what deployed, what failed, and
  what needs attention. It mutates no GitHub state; it only stores a local
  checkpoint timestamp so the next brief can compare against it. When configured
  repositories live under different GitHub owners, use `GITHUB_OWNER_TOKENS` or
  `GITHUB_REPO_TOKENS` for owner/repo-specific read-only tokens. `project memory`
  and `known projects` call `averray_project_memory`, a read-only curated memory
  of known projects, repos, deploy surfaces, useful commands, handoff
  expectations, safety notes, and open questions. It stores no secrets and does
  not merge, deploy, SSH, edit GitHub, edit Wikipedia, or mutate Averray state.
  Project runbook commands call `averray_project_runbook`, a read-only
  project-admin checklist for merge, deploy, rollback, restart, and
  secret-rotation work. It returns required evidence, operator steps, stop
  conditions, verification, rollback notes, and suggested Hermes commands. It
  never approves, merges, deploys, restarts, rotates secrets, SSHes, or mutates
  GitHub.
  `what can you do for us` calls the
  read-only `averray_agent_usefulness_plan` MCP tool and explains the useful
  surfaces and use cases across Slack, Command Center/mobile, MCP clients,
  GitHub-helper planning, ops care, Averray business tracking, and durable
  memory. `admin readiness` calls `averray_admin_readiness`, a read-only staged
  plan for growing from operator copilot to approval-gated project admin without
  granting broad mutation powers by default. Admin proposal commands call
  `averray_admin_action_proposal`, which can recommend whether a merge, deploy,
  rollback, restart, or secret rotation is ready for human approval. It never
  records approval, merges, deploys, restarts, rotates secrets, SSHes, or
  mutates GitHub. `business ledger` calls
  `averray_business_ledger` for recent submissions, drafts, operator commands,
  budget, and open work. `ops health` calls `averray_ops_health` for
  wallet/budget readiness, latest-run state, and Postgres control-plane counts.
  `daily operator brief` and `find safe work` are read-only summaries that turn
  the current wallet, budget, latest-run, and open-job state into practical next
  actions for any MCP client, not just Slack or Hermes Workspace.
  `testbed e2e suite` and `platform e2e suite` call
  `averray_testbed_e2e_suite`, a read-only E2E checklist for backend agents,
  Slack, Command Center, and MCP clients. It returns ordered test cases,
  commands, expected evidence, readiness blockers, and mutation boundaries for
  exercising the platform like a normal operator without accidentally claiming,
  submitting, deploying, editing GitHub, or editing Wikipedia.
  `run testbed e2e read-only` calls `averray_run_testbed_e2e_read_only` and
  executes the automatable non-mutating cases in order: status, daily brief,
  safe-work discovery, one citation-repair dry run, latest-run verification,
  business ledger, ops health, and GitHub status. It intentionally skips the
  guarded live repair case, the local GitHub brief checkpoint, and manual
  surface parity checks.
  Other trusted agents and deploy scripts should call `averray_invoke_agent_task`
  when they need Hermes/Averray to run a post-deploy smoke or E2E check. The
  hook accepts structured requester metadata, an optional `correlationId`, and
  either a safe operator command, the full read-only E2E suite, a single
  testcase ID, a read-only PR code-review verifier, or a PR handoff workflow.
  `pr_code_review` is the narrow independent-verifier lane: it inspects PR
  metadata, changed files, check status, rollout notes, and test signals, then
  returns an `ok_to_merge`, `needs_review`, or `hold` recommendation without
  mutating GitHub. PR handoff is the normal path for an agent that has opened a
  PR and wants Hermes to review it, recommend whether it is merge-ready, run the
  requested testbed checks, and report the result back to the calling agent.

  ```json
  {"requester":"codex","intent":"testbed_e2e_read_only","correlationId":"deploy-20260509","reason":"post-deploy smoke"}
  ```

  ```json
  {"requester":"backend-agent","intent":"testbed_case","testCaseId":"TBE2E-004","correlationId":"ci-123"}
  ```

  ```json
  {"requester":"deploy-agent","intent":"pr_handoff","repo":"averray-agent/agent","pullRequestNumber":185,"testCaseIds":["TBE2E-004"],"correlationId":"deploy-20260509","reason":"pre-merge smoke"}
  ```

  ```json
  {"requester":"codex","intent":"pr_code_review","repo":"averray-agent/agent","pullRequestNumber":185,"correlationId":"review-20260509","reason":"independent verifier lane"}
  ```

  ```json
  {"requester":"codex","intent":"pr_handoff","pullRequestUrl":"https://github.com/averray-agent/agent/pull/185","runReadOnlySuite":true,"postReviewCommand":"github status","correlationId":"handoff-123"}
  ```

  ```json
  {"requester":"codex","command":"operator status","correlationId":"deploy-20260509"}
  ```

  The hook uses structured MCP/operator workflows instead of a free-form Hermes
  prompt. Unknown commands are blocked. Live repair cases require
  `allowMutations: true`; `github brief` and testcase `TBE2E-010` require
  `allowLocalCheckpoint: true` because they write the local comparison
  checkpoint. PR handoff reads GitHub PR metadata, changed-file summaries, and
  check-run state, then returns `mergeRecommendation` and `finalVerdict`
  (`ok_to_merge`, `needs_review`, or `hold`). It never merges the PR, pushes
  commits, reruns workflows, deploys, edits GitHub, or edits Wikipedia; the
  recommendation is evidence for the upstream agent or human operator to act
  on. The response always reports whether free-form prompts were avoided and
  whether the requested action would mutate Averray or write a local checkpoint.
  `operator status` calls the canonical read-only
  `averray_operator_status` MCP tool and returns wallet, budget, open-job,
  latest-run, safety, and safe-command metadata. Human surfaces can show
  compact identifiers by default while keeping full identifiers in the
  structured MCP JSON; add `details`, `full`, or `audit` to a status command
  when an operator needs the full run/session/draft audit trail. Repair
  commands call the Wikipedia workflow tool directly; latest-run status returns
  the current run/session/draft/submit state, including persisted Slack context
  when available, without mutating anything.
