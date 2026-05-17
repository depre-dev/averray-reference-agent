# Codex Handoff Protocol

This protocol keeps Averray's agent loop simple: Codex builds; Hermes reviews and operates.

## Roles

- **Codex is the builder.** Codex works in Git branches/worktrees, edits code, opens PRs, responds to review, and fixes failures.
- **Hermes is the reviewer/operator.** Hermes observes GitHub, reviews PR risk signals, runs read-only testbed checks, reports to PR comments/Slack/monitor, and proposes operator actions without broad merging or deploying by itself.
- **Humans own approval.** PASS can enter the normal merge path, HUMAN REVIEW needs a human decision, and BLOCK must be fixed or explicitly overridden outside Hermes.

## Transport

The default transport is GitHub Actions calling Averray MCP through Hermes:

1. Codex opens or updates a PR.
2. GitHub CI runs.
3. After successful CI, GitHub Actions calls `averray_invoke_agent_task` with `intent: "pr_code_review"`.
4. GitHub Actions then calls `averray_invoke_agent_task` with `intent: "pr_handoff"` and the requested testbed case, usually `TBE2E-004`.
5. Hermes writes handoff events with the same correlation family.
6. When `GITHUB_PR_HANDOFF_COMMENTS_ENABLED=1`, Hermes upserts one compact verdict comment on the PR.
7. Humans and agents inspect the PR comment, Slack, and `https://monitor.averray.com`.
8. After merge/deploy, Hermes runs post-deploy verification and records a deploy handoff.

## Required PR Notes From Codex

Every Codex-authored PR should include:

- What changed.
- Which checks were run locally.
- Affected surfaces: backend, frontend, indexer, Caddy, contracts, public site, workflows, docs, tests, or secrets/config.
- Rollout or rollback notes when deploy, workflow, ops, contract, indexer, database, or secret surfaces changed.
- Any known limits, skipped checks, or follow-up work.

Codex should not rely on green CI alone. The Hermes handoff is a separate release signal.

## What Hermes Checks

Hermes PR review is read-only and recommendation-only. It checks:

- PR metadata: state, draft flag, author, branch, mergeability, and update time.
- Changed files and risk category.
- High-risk surfaces: secrets, contracts, database migrations, deploy scripts, workflows, ops, lockfiles, and large diffs.
- CI status: failed, active, missing, skipped, neutral, and passed runs.
- Test signal coverage for touched areas.
- Rollout/rollback note presence for deploy-sensitive changes.
- Requested read-only testbed cases, especially the dry-run citation repair safety case `TBE2E-004`.

Hermes must not merge PRs, deploy, submit work, or run guarded live mutation during this handoff. The only allowed PR-handoff GitHub mutation is the optional idempotent Hermes verdict comment.

## Verdicts

- **PASS** means Hermes found no blocking or review-gated release signal. Continue through normal human/merge-queue policy.
- **HUMAN REVIEW** means nothing is necessarily broken, but the PR touched a review-gated surface or lacks enough automated proof. A human should inspect the PR before merge.
- **BLOCK** means do not merge or deploy until fixed or explicitly overridden by a human owner. Typical causes are failing/active CI, draft/closed PR, merge conflict, critical files such as contracts/secrets/migrations, or failed requested testbed checks.

## What Codex Should Do After Hermes Reports

- If **PASS**: continue normal merge queue or ask the human owner for final approval.
- If **HUMAN REVIEW**: add or update PR notes explaining the risk, tests, rollout/rollback plan, and why the change is acceptable; ask the human owner to review.
- If **BLOCK**: stop. Fix the PR, add missing tests or notes, wait for CI, then let Hermes re-run. Do not ask Hermes to override the block.
- If Hermes could not inspect the PR: treat it as HUMAN REVIEW and repair the missing token/repo/config separately.

## Monitor-to-Codex Task Queue

The monitor can now turn a PR card into a small Codex task:

1. Hermes identifies the current owner and next action.
2. The operator clicks **Propose Codex task** to persist the exact prompt and PR metadata.
3. The operator clicks **Approve Codex task** when Codex is allowed to start.
4. The optional `codex-task-runner` service claims approved tasks, marks them `running`, executes the configured command, then records `completed` or `failed`.
5. Codex pushes branch updates. CI and Hermes handoff run again through the normal GitHub Actions path.

The runner is opt-in and fail-closed. It does not start unless
`CODEX_TASK_RUNNER_ENABLED=1` and `CODEX_TASK_RUNNER_COMMAND` are configured. A
typical command can use JSON args with placeholders, for example:

```env
CODEX_TASK_RUNNER_COMMAND=codex
CODEX_TASK_RUNNER_ARGS=["exec","--full-auto","{prompt}"]
```

Task state is stored in `AVERRAY_CODEX_TASKS_PATH`, defaulting to
`/data/codex-tasks.json` in Docker so the monitor and runner share durable state.
The runner redacts common private keys, JWTs, GitHub tokens, and API keys from
captured output before persisting tails in the queue.

## Monitor GitHub-Live Fallback

The monitor has two read-only inputs:

- Hermes handoff events from the local handoff log.
- Live GitHub PR state for repos configured by `GITHUB_HELPER_REPOS`,
  `GITHUB_DEFAULT_REPO`, or `GITHUB_REPOSITORY`.

The GitHub-live layer exists so an open PR is still visible even before Hermes
has emitted a handoff event, or after the local event window expires. It fetches
open PRs, check runs, and touched files, then creates synthetic monitor cards
with `requester=github-live` and `intent=github_open_pr`. Those cards are grouped
with Hermes events by `repo#pullRequestNumber`, so the board should show one
logical card per PR rather than duplicate rows.

The default live PR scan limit is 20. Set `GITHUB_MONITOR_PR_LIMIT` if the
monitor needs a different value without changing other GitHub helper commands.

This layer never mutates GitHub. It only helps assign ownership:

- draft PRs go to Codex.
- failed PR checks go to Codex / Needs Attention.
- running PR checks go to the Codex-needed lane until CI settles.
- review-gated surfaces go to Operator only after the agent pre-check evidence
  is attached.
- green low-risk PRs go to the merge queue.

## Correlation Metadata

Use stable metadata so all surfaces connect:

- `requester`: usually `github-actions`, `codex`, or the backend agent name.
- `repo`: owner/repo, for example `averray-agent/agent`.
- `pullRequestNumber`: GitHub PR number.
- `sha`: head or deployed commit SHA when available.
- `correlationId`: `github-pr-<number>-<sha>-<workflowRunId>` for PR handoff and `github-deploy-<runId>-<sha>` for deploy verification.
- `testCaseIds`: requested read-only testbed cases.
- `reason`: short source phrase such as `post-CI PR handoff` or `post-production-deploy verification`.

The handoff monitor groups events by `correlationId`; PR comments and Slack summaries include it.

## Current Contract

PR code review:

```json
{"requester":"github-actions","intent":"pr_code_review","repo":"averray-agent/agent","pullRequestNumber":123,"correlationId":"github-pr-123-abc-456-code-review","reason":"post-CI independent PR verifier"}
```

PR handoff with read-only testbed case:

```json
{"requester":"github-actions","intent":"pr_handoff","repo":"averray-agent/agent","pullRequestNumber":123,"testCaseIds":["TBE2E-004"],"correlationId":"github-pr-123-abc-456","reason":"post-CI PR handoff"}
```

Post-deploy verification:

```json
{"requester":"github-actions","intent":"post_deploy_verification","repo":"averray-agent/agent","sha":"abc1234","correlationId":"github-deploy-456-abc1234","reason":"post-production-deploy verification"}
```

## Non-Goals

- No new chat surface just for Codex/Hermes coordination.
- No autonomous merge or deploy.
- No broad GitHub mutation from PR handoff. The verdict comment is optional, idempotent, and marked with `<!-- averray-hermes-pr-handoff -->`.
- No secret values in PRs, Slack, Hermes, or monitor output.
- No direct Wikipedia edits from the handoff path.
- No dependence on Resend/email for bootstrap self-report proof; Hermes Slack, GitHub, and monitor reports are the current proof channel.
