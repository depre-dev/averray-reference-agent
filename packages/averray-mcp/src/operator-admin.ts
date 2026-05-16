import { optionalEnv } from "@avg/mcp-common";
import type { OperatorStatusDeps } from "./operator-status.js";
import { getHandoffMonitor } from "./handoff-events.js";
import { getGithubOperatorStatus } from "./operator-github.js";
import { getOpsHealth } from "./operator-insights.js";
import { getAgentUsefulnessPlan } from "./operator-usefulness.js";

export type AdminActionKind =
  | "merge"
  | "deploy"
  | "rollback"
  | "secret_rotation"
  | "restart"
  | "unknown";

export interface AdminActionProposalInput {
  action: AdminActionKind;
  repo?: string;
  pullRequestNumber?: number;
  sha?: string;
  requester?: string;
  reason?: string;
}

export async function getAdminReadiness(deps: OperatorStatusDeps) {
  const [ops, usefulness] = await Promise.all([
    getOpsHealth(deps),
    getAgentUsefulnessPlan(deps),
  ]);
  const cloudflareAccess = optionalEnv("CLOUDFLARED_TUNNEL_TOKEN", "").length > 0;
  const slackOperator = optionalEnv("SLACK_OPERATOR_ENABLED", "0") === "1";
  const commandCenter = Boolean(optionalEnv("HERMES_WORKSPACE_IMAGE"));
  const health = ops.health;

  return {
    schemaVersion: 1,
    kind: "admin_readiness",
    generatedAt: ops.generatedAt,
    mutates: false,
    headline: "I am ready to be an operator copilot now; project-admin powers should be added in approval-gated stages.",
    currentRole: {
      level: "operator_copilot",
      canAdministerAutomatically: false,
      reason: "The agent can observe, brief, draft, and run narrow guarded Averray workflows, but broad project administration still needs explicit approval gates and per-action policies.",
    },
    readiness: {
      overall: readinessFromHealth(health),
      opsHealth: health,
      walletReady: ops.wallet.walletReady,
      budgetRemainingUsd: ops.budget.todayUsdRemaining,
      slackOperator: slackOperator ? "enabled" : "not_configured",
      commandCenter: commandCenter ? "enabled" : "not_configured",
      publicAccess: cloudflareAccess ? "cloudflare_access_configured" : "private_or_tunnel_only",
      auditTrail: auditReadiness(ops),
    },
    adminLadder: [
      {
        stage: 1,
        name: "Observe and brief",
        status: "enabled",
        examples: ["ops health", "business ledger", "daily operator brief", "status last wikipedia citation repair"],
        mutates: false,
      },
      {
        stage: 2,
        name: "Draft and recommend",
        status: "enabled",
        examples: ["find safe work", "run one wikipedia citation repair dry run only", "what can you do for us"],
        mutates: false,
      },
      {
        stage: 3,
        name: "Approval-gated execution",
        status: "partially_enabled",
        examples: ["run one wikipedia citation repair if safe"],
        mutates: true,
        requiredControls: ["explicit command", "policy check", "draft persistence", "validation", "confidence threshold", "audit event"],
      },
      {
        stage: 4,
        name: "Scoped project admin",
        status: "not_enabled",
        examples: ["merge approved PR", "restart service", "rotate non-secret config", "open incident report"],
        mutates: true,
        requiredControls: ["project allowlist", "action registry", "two-step approval", "rollback plan", "post-action receipt"],
      },
      {
        stage: 5,
        name: "Autonomous routine admin",
        status: "future",
        examples: ["auto-close stale safe alerts", "auto-run read-only health checks", "auto-draft weekly reports"],
        mutates: "limited",
        requiredControls: ["time window", "spend limit", "rate limit", "dry-run shadow period", "human override"],
      },
    ],
    canDoNow: [
      "Summarize current Averray work and budget.",
      "Find safe citation-repair candidates and dry-run them.",
      "Submit only narrow Wikipedia citation-repair proposals when policy, validation, and confidence pass.",
      "Report control-plane health from Postgres.",
      "Explain which surface to use: Slack, Command Center/mobile, or MCP.",
    ],
    shouldNotDoYet: [
      "Merge PRs or push code without a project-specific approval policy.",
      "Deploy, restart, or reconfigure production services automatically.",
      "Change DNS, Cloudflare Access, Slack app scopes, or secrets.",
      "Spend money, move funds, or change wallet configuration.",
      "Override confidence gates without a separate operator review path.",
    ],
    requiredBeforeProjectAdmin: [
      "Define a project registry with owners, environments, and allowed actions.",
      "Add an admin action policy engine with read-only, draft-only, approval-required, and denied levels.",
      "Persist every proposed/admin action with requester, channel, diff/command, approval, result, and rollback note.",
      "Add GitHub/CI read-only digest first; only then add approval-gated PR comments or merges.",
      "Add host-level ops checks for disk, logs, WAL files, and service health before allowing restarts.",
    ],
    suggestedCommands: [
      "admin readiness",
      "what can you do for us",
      "ops health",
      "business ledger",
      "find safe work",
    ],
    surfaces: usefulness.surfaces,
    safety: {
      mutatesByDefault: false,
      projectAdminEnabled: false,
      broadAdminDeniedByDefault: true,
      explicitApprovalRequiredForAdmin: true,
      editsWikipedia: false,
    },
  };
}

export async function getAdminActionProposal(
  input: AdminActionProposalInput,
  deps: OperatorStatusDeps
) {
  const generatedAt = new Date().toISOString();
  const proposalId = [
    "admin-proposal",
    input.action,
    input.repo?.replace(/[^a-zA-Z0-9]+/g, "-") ?? "no-repo",
    input.pullRequestNumber ? `pr-${input.pullRequestNumber}` : input.sha?.slice(0, 12) ?? "no-target",
    generatedAt.replace(/[^0-9]/g, "").slice(0, 14),
  ].join("-");

  const [ops, github, handoffMonitor] = await Promise.all([
    getOpsHealth(deps).catch((error) => ({
      error: `ops_health_unavailable:${errorMessage(error)}`,
    })),
    getGithubOperatorStatus({ view: "digest" }).catch((error) => ({
      error: `github_status_unavailable:${errorMessage(error)}`,
    })),
    getHandoffMonitor().catch((error) => ({
      error: `handoff_monitor_unavailable:${errorMessage(error)}`,
    })),
  ]);

  const context = buildProposalContext({ input, ops, github, handoffMonitor });
  const recommendation = recommendationForAction(input.action, context);
  const risks = risksForAction(input.action, context);

  return {
    schemaVersion: 1,
    kind: "admin_action_proposal",
    generatedAt,
    proposalId,
    mutates: false,
    action: {
      type: input.action,
      target: {
        repo: input.repo ?? null,
        pullRequestNumber: input.pullRequestNumber ?? null,
        sha: input.sha ?? null,
      },
      requester: input.requester ?? "operator",
      reason: input.reason ?? null,
    },
    recommendation,
    approval: {
      required: true,
      mode: "explicit_human_approval",
      status: "not_requested",
      canExecuteFromThisProposal: false,
      note: "This proposal is advisory only. The current agent cannot consume this as approval or execute the admin action.",
    },
    evidence: context.evidence,
    risks,
    blockedActions: blockedActionsForAction(input.action),
    nextHumanStep: nextHumanStep(input.action, recommendation),
    safety: {
      proposalOnly: true,
      mutates: false,
      githubMutated: false,
      deployTriggered: false,
      serviceRestarted: false,
      secretsChanged: false,
      approvalRecorded: false,
      freeFormHermesPromptUsed: false,
    },
  };
}

function readinessFromHealth(health: string) {
  if (health === "ready") return "ready_for_operator_copilot";
  if (health === "quiet") return "ready_but_low_activity";
  if (health === "degraded") return "needs_ops_attention";
  return "blocked";
}

function auditReadiness(ops: Awaited<ReturnType<typeof getOpsHealth>>) {
  const events = ops.controlPlane.tables.operatorEvents;
  if (events > 0) return "operator_events_recorded";
  return "no_operator_events_seen";
}

function buildProposalContext(input: {
  input: AdminActionProposalInput;
  ops: unknown;
  github: unknown;
  handoffMonitor: unknown;
}) {
  const ops = toRecord(input.ops);
  const github = toRecord(input.github);
  const githubTotals = toRecord(github.totals);
  const handoffMonitor = toRecord(input.handoffMonitor);
  const handoffCounts = toRecord(handoffMonitor.counts);
  const recentHandoffs = arrayField(handoffMonitor, "recent");
  const matchingHandoff = findMatchingHandoff(recentHandoffs, input.input);
  const matchingSummary = toRecord(matchingHandoff?.summary);

  const context = {
    targetMissing: targetMissing(input.input),
    opsUnavailable: Boolean(stringField(ops, "error")),
    opsHealth: stringField(ops, "health") ?? "unknown",
    githubUnavailable: Boolean(stringField(github, "error")),
    githubHealth: stringField(github, "health") ?? "unknown",
    openPullRequests: numberField(githubTotals, "openPullRequests"),
    openIssues: numberField(githubTotals, "openIssues"),
    failingWorkflowRuns: numberField(githubTotals, "failingWorkflowRuns"),
    activeWorkflowRuns: numberField(githubTotals, "activeWorkflowRuns"),
    handoffUnavailable: Boolean(stringField(handoffMonitor, "error")),
    activeHandoffs: numberField(handoffCounts, "active"),
    recentHandoffs: numberField(handoffCounts, "recent"),
    matchingHandoff,
    matchingVerdict: stringField(matchingSummary, "finalVerdict"),
    matchingMergeRecommendation: stringField(matchingSummary, "mergeRecommendation"),
    matchingReason: stringField(matchingSummary, "finalReason") ?? stringField(matchingSummary, "reason"),
  };

  return {
    ...context,
    evidence: [
      {
        source: "ops_health",
        status: context.opsUnavailable ? "unavailable" : context.opsHealth,
        detail: context.opsUnavailable
          ? stringField(ops, "error")
          : `operator health is ${context.opsHealth}`,
      },
      {
        source: "github",
        status: context.githubUnavailable ? "unavailable" : context.githubHealth,
        detail: context.githubUnavailable
          ? stringField(github, "error")
          : `${context.openPullRequests} open PRs, ${context.openIssues} open issues, ${context.failingWorkflowRuns} failing workflows, ${context.activeWorkflowRuns} active workflows`,
      },
      {
        source: "handoff_monitor",
        status: context.handoffUnavailable
          ? "unavailable"
          : context.matchingHandoff
            ? context.matchingVerdict ?? "seen"
            : "no_matching_handoff",
        detail: context.handoffUnavailable
          ? stringField(handoffMonitor, "error")
          : context.matchingHandoff
            ? `matching handoff verdict ${context.matchingVerdict ?? "unknown"} / merge ${context.matchingMergeRecommendation ?? "unknown"}`
            : `${context.activeHandoffs} active handoffs, ${context.recentHandoffs} recent handoffs`,
      },
    ],
  };
}

function recommendationForAction(
  action: AdminActionKind,
  context: ReturnType<typeof buildProposalContext>
) {
  if (action === "unknown") {
    return {
      status: "not_ready",
      reason: "admin_action_unknown",
      summary: "Name the admin action first: merge, deploy, rollback, restart, or secret rotation.",
    };
  }
  if (context.targetMissing) {
    return {
      status: "not_ready",
      reason: "target_missing",
      summary: "The proposal needs a concrete target before a human can approve it.",
    };
  }
  if (action === "rollback" || action === "secret_rotation" || action === "restart") {
    return {
      status: "needs_human_review",
      reason: `${action}_is_high_risk`,
      summary: "High-risk admin action. Prepare a rollback/owner note and get explicit human approval outside Hermes.",
    };
  }
  if (context.opsUnavailable || context.githubUnavailable || context.handoffUnavailable) {
    return {
      status: "needs_human_review",
      reason: "evidence_incomplete",
      summary: "One or more read-only evidence sources were unavailable. Do not execute until a human checks the missing source.",
    };
  }
  if (context.failingWorkflowRuns > 0 || isBlockingVerdict(context.matchingVerdict) || isBlockingVerdict(context.matchingMergeRecommendation)) {
    return {
      status: "not_ready",
      reason: "blocking_signal_present",
      summary: "A failing workflow or blocking handoff signal is present. Resolve that first.",
    };
  }
  if (context.activeWorkflowRuns > 0 || isNeedsReviewVerdict(context.matchingVerdict) || isNeedsReviewVerdict(context.matchingMergeRecommendation)) {
    return {
      status: "needs_human_review",
      reason: "review_signal_present",
      summary: "Read-only signals are not blocking, but a human should review before acting.",
    };
  }
  return {
    status: "ready_for_human_approval",
    reason: "read_only_signals_clear",
    summary: "Read-only signals are clear. A human may approve and execute the action manually.",
  };
}

function risksForAction(
  action: AdminActionKind,
  context: ReturnType<typeof buildProposalContext>
) {
  const risks: Array<Record<string, string>> = [];
  if (context.targetMissing) {
    risks.push({
      severity: "high",
      code: "target_missing",
      message: "No concrete repo/PR/SHA target was provided.",
    });
  }
  if (context.opsUnavailable || context.githubUnavailable || context.handoffUnavailable) {
    risks.push({
      severity: "medium",
      code: "evidence_incomplete",
      message: "One or more read-only evidence sources could not be checked.",
    });
  }
  if (context.failingWorkflowRuns > 0) {
    risks.push({
      severity: "high",
      code: "github_failing_workflows",
      message: `${context.failingWorkflowRuns} failing GitHub workflow run(s) are visible.`,
    });
  }
  if (context.activeWorkflowRuns > 0) {
    risks.push({
      severity: "medium",
      code: "github_active_workflows",
      message: `${context.activeWorkflowRuns} GitHub workflow run(s) are still active.`,
    });
  }
  if (context.matchingReason) {
    risks.push({
      severity: isBlockingVerdict(context.matchingVerdict) ? "high" : "medium",
      code: context.matchingReason,
      message: `Matching handoff reason: ${context.matchingReason}.`,
    });
  }
  if (action === "rollback" || action === "secret_rotation" || action === "restart") {
    risks.push({
      severity: "high",
      code: `${action}_requires_owner`,
      message: "This action can affect production access or availability and requires an owner-approved runbook.",
    });
  }
  if (risks.length === 0) {
    risks.push({
      severity: "low",
      code: "proposal_only",
      message: "No blocking read-only signal found; execution is still manual and approval-gated.",
    });
  }
  return risks;
}

function blockedActionsForAction(action: AdminActionKind) {
  const common = ["record_approval", "execute_admin_action"];
  if (action === "merge") return [...common, "merge_pull_request", "push_code"];
  if (action === "deploy") return [...common, "trigger_deploy", "ssh_to_production"];
  if (action === "rollback") return [...common, "trigger_rollback", "change_production_pointer"];
  if (action === "secret_rotation") return [...common, "read_or_write_secret", "rotate_secret"];
  if (action === "restart") return [...common, "restart_service", "ssh_to_production"];
  return common;
}

function nextHumanStep(action: AdminActionKind, recommendation: Record<string, string>) {
  if (recommendation.status === "not_ready") {
    return "Resolve the listed blockers, then request a fresh proposal.";
  }
  if (action === "merge") {
    return "Review the PR, CI, and handoff monitor. If you agree, merge manually in GitHub.";
  }
  if (action === "deploy") {
    return "Review deployment inputs and current GitHub/ops signals. If you agree, run the deploy workflow manually.";
  }
  if (action === "rollback") {
    return "Open an incident note, choose a known-good target, and execute rollback manually with an owner watching.";
  }
  if (action === "secret_rotation") {
    return "Rotate the secret through the owning control plane or GitHub secret UI; never paste secrets into Hermes.";
  }
  if (action === "restart") {
    return "Check host/service health and restart manually only if the owner accepts the availability impact.";
  }
  return "Pick a concrete admin action and target, then request a fresh proposal.";
}

function targetMissing(input: AdminActionProposalInput): boolean {
  if (input.action === "merge") return !input.repo || !input.pullRequestNumber;
  if (input.action === "deploy") return !input.repo || !input.sha;
  if (input.action === "rollback") return !input.repo;
  if (input.action === "secret_rotation") return !input.repo && !input.reason;
  if (input.action === "restart") return !input.repo && !input.reason;
  return false;
}

function findMatchingHandoff(
  handoffs: unknown[],
  input: AdminActionProposalInput
): Record<string, unknown> | undefined {
  return handoffs.find((handoff) => {
    const record = toRecord(handoff);
    const repoMatches = !input.repo || stringField(record, "repo") === input.repo;
    const prMatches = !input.pullRequestNumber || numberField(record, "pullRequestNumber") === input.pullRequestNumber;
    return repoMatches && prMatches;
  }) as Record<string, unknown> | undefined;
}

function isBlockingVerdict(value: string | undefined) {
  return value === "block" || value === "blocked" || value === "hold" || value === "not_ready";
}

function isNeedsReviewVerdict(value: string | undefined) {
  return value === "needs_review" || value === "needs_human_review";
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!isRecord(value)) return [];
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function numberField(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : 0;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
