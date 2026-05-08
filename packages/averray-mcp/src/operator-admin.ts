import { optionalEnv } from "@avg/mcp-common";
import type { OperatorStatusDeps } from "./operator-status.js";
import { getOpsHealth } from "./operator-insights.js";
import { getAgentUsefulnessPlan } from "./operator-usefulness.js";

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
      "Override confidence gates without a separate human review path.",
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
