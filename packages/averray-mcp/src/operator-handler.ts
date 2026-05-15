import type { WorkflowDeps } from "./job-workflows.js";
import {
  getLastWikipediaCitationRepairStatus,
  parseOperatorCommand,
  type OperatorCommandSource,
  type OperatorQueryFn,
} from "./operator-commands.js";
import { getAdminActionProposal, getAdminReadiness } from "./operator-admin.js";
import { getBusinessLedger, getOpsHealth } from "./operator-insights.js";
import { getGithubMergeSteward, getGithubOperatorBrief, getGithubOperatorStatus } from "./operator-github.js";
import { getDailyOperatorBrief, getOperatorStatus, getSafeWorkReport } from "./operator-status.js";
import { getProjectMemory } from "./operator-project-memory.js";
import { getProjectRunbook } from "./operator-project-runbook.js";
import { getTestbedE2eSuite, runTestbedE2eReadOnly } from "./operator-testbed.js";
import { getAgentUsefulnessPlan } from "./operator-usefulness.js";
import { runWikipediaCitationRepairWorkflow } from "./job-workflows.js";
import { getHandoffMonitor } from "./handoff-events.js";

export interface HandleOperatorCommandInput {
  text: string;
  source?: OperatorCommandSource;
  expectedWallet?: string;
  defaultDryRun?: boolean;
  maxEvidenceUrls?: number;
  confidenceThreshold?: number;
}

export interface HandleOperatorCommandDeps {
  query: OperatorQueryFn;
  workflowDeps: WorkflowDeps;
}

export async function handleOperatorCommandText(
  input: HandleOperatorCommandInput,
  deps: HandleOperatorCommandDeps
) {
  const command = parseOperatorCommand(input.text, {
    source: input.source,
    defaultDryRun: input.defaultDryRun,
    maxEvidenceUrls: input.maxEvidenceUrls,
    confidenceThreshold: input.confidenceThreshold,
  });
  if (!command.handled) return command;
  if (command.kind === "status_last_wikipedia_citation_repair") {
    const status = await getLastWikipediaCitationRepairStatus(deps.query);
    return { ...command, status };
  }
  if (command.kind === "operator_status") {
    const status = await getOperatorStatus({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, status };
  }
  if (command.kind === "daily_operator_brief") {
    const brief = await getDailyOperatorBrief({ query: deps.query, workflowDeps: deps.workflowDeps });
    const decisionSummary = await getDailyOperatorDecisionSummary(deps, brief);
    return { ...command, brief: { ...brief, decisionSummary } };
  }
  if (command.kind === "find_safe_work") {
    const safeWork = await getSafeWorkReport({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, safeWork };
  }
  if (command.kind === "agent_usefulness_plan") {
    const plan = await getAgentUsefulnessPlan({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, plan };
  }
  if (command.kind === "project_memory") {
    const memory = getProjectMemory({ project: command.project });
    return { ...command, memory };
  }
  if (command.kind === "project_runbook") {
    const runbook = getProjectRunbook({
      action: command.action,
      project: command.project,
      query: command.query,
    });
    return { ...command, runbook };
  }
  if (command.kind === "admin_readiness") {
    const readiness = await getAdminReadiness({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, readiness };
  }
  if (command.kind === "admin_proposal") {
    const proposal = await getAdminActionProposal(command.input, { query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, proposal };
  }
  if (command.kind === "business_ledger") {
    const ledger = await getBusinessLedger({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, ledger };
  }
  if (command.kind === "ops_health") {
    const health = await getOpsHealth({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, health };
  }
  if (command.kind === "github_status") {
    const github = await getGithubOperatorStatus({ view: command.view });
    return { ...command, github };
  }
  if (command.kind === "github_brief") {
    const github = await getGithubOperatorBrief({ query: deps.query });
    return { ...command, github };
  }
  if (command.kind === "github_merge_steward") {
    const github = await getGithubMergeSteward();
    return { ...command, github };
  }
  if (command.kind === "run_testbed_e2e_read_only") {
    const run = await runTestbedE2eReadOnly({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, run };
  }
  if (command.kind === "handoff_monitor") {
    const monitor = await getHandoffMonitor();
    return { ...command, monitor };
  }
  if (command.kind === "testbed_e2e_suite") {
    const suite = await getTestbedE2eSuite({ query: deps.query, workflowDeps: deps.workflowDeps });
    return { ...command, suite };
  }
  const result = await runWikipediaCitationRepairWorkflow(
    { ...command.input, expectedWallet: input.expectedWallet },
    deps.workflowDeps
  );
  return { ...command, result };
}

async function getDailyOperatorDecisionSummary(
  deps: HandleOperatorCommandDeps,
  brief: Record<string, unknown>
) {
  const [opsHealth, github, handoffMonitor] = await Promise.all([
    getOpsHealth({ query: deps.query, workflowDeps: deps.workflowDeps }).catch((error) => ({
      error: `ops_health_unavailable:${errorMessage(error)}`,
    })),
    getGithubOperatorStatus({ view: "digest" }).catch((error) => ({
      error: `github_status_unavailable:${errorMessage(error)}`,
    })),
    getHandoffMonitor().catch((error) => ({
      error: `handoff_monitor_unavailable:${errorMessage(error)}`,
    })),
  ]);
  return buildDailyOperatorDecisionSummary({ brief, opsHealth, github, handoffMonitor });
}

function buildDailyOperatorDecisionSummary(input: {
  brief: Record<string, unknown>;
  opsHealth: unknown;
  github: unknown;
  handoffMonitor: unknown;
}) {
  const opsHealth = toRecord(input.opsHealth);
  const github = toRecord(input.github);
  const githubTotals = toRecord(github.totals);
  const handoffMonitor = toRecord(input.handoffMonitor);
  const handoffCounts = toRecord(handoffMonitor.counts);
  const budget = toRecord(input.brief.budget);
  const attentionItems: Array<Record<string, unknown>> = [];
  const suggestedActions = new Set<string>();

  addErrorAttention(attentionItems, opsHealth, "Ops health");
  addErrorAttention(attentionItems, github, "GitHub");
  addErrorAttention(attentionItems, handoffMonitor, "Handoff monitor");

  const opsState = stringField(opsHealth, "health");
  if (opsState && opsState !== "ok") {
    attentionItems.push({
      severity: opsState === "blocked" ? "high" : "medium",
      source: "ops",
      title: `Ops health is ${opsState}`,
      detail: firstString(arrayField(opsHealth, "recommendedNextActions")),
    });
    suggestedActions.add("ops health");
  }

  const githubHealth = stringField(github, "health");
  const failingWorkflowRuns = numberField(githubTotals, "failingWorkflowRuns");
  const activeWorkflowRuns = numberField(githubTotals, "activeWorkflowRuns");
  const openPullRequests = numberField(githubTotals, "openPullRequests");
  const openIssues = numberField(githubTotals, "openIssues");
  if (githubHealth && githubHealth !== "ok") {
    attentionItems.push({
      severity: githubHealth === "degraded" || failingWorkflowRuns > 0 ? "high" : "medium",
      source: "github",
      title: githubAttentionTitle({ failingWorkflowRuns, activeWorkflowRuns, openPullRequests, openIssues }),
      detail: firstString(arrayField(github, "recommendations")),
    });
    suggestedActions.add("github status");
  }

  const recentHandoffs = arrayField(handoffMonitor, "recent").filter(isReviewWorthyHandoff).slice(0, 3);
  for (const handoff of recentHandoffs) {
    const summary = toRecord(handoff.summary);
    attentionItems.push({
      severity: isBlockingVerdict(stringField(summary, "finalVerdict")) || isBlockingVerdict(stringField(summary, "mergeRecommendation")) ? "high" : "medium",
      source: "handoff",
      title: handoffTitle(handoff),
      detail: handoffDetail(handoff),
      url: stringField(handoff, "pullRequestUrl"),
    });
    suggestedActions.add("handoff monitor");
  }

  const activeHandoffs = numberField(handoffCounts, "active");
  const runningHandoffs = numberField(handoffCounts, "running");
  if (activeHandoffs > 0 || runningHandoffs > 0) {
    attentionItems.push({
      severity: "medium",
      source: "handoff",
      title: `${Math.max(activeHandoffs, runningHandoffs)} handoff${Math.max(activeHandoffs, runningHandoffs) === 1 ? "" : "s"} currently active`,
      detail: "Open the handoff monitor for live status.",
    });
    suggestedActions.add("handoff monitor");
  }

  const openJobs = numberField(input.brief, "openWikipediaCitationRepairJobs");
  const todayUsdRemaining = numberField(budget, "todayUsdRemaining");
  if (todayUsdRemaining <= 0) {
    attentionItems.push({
      severity: "high",
      source: "budget",
      title: "Daily budget is depleted",
      detail: "Wait for the next budget window before running guarded workflows.",
    });
    suggestedActions.add("business ledger");
  } else if (openJobs > 0) {
    attentionItems.push({
      severity: "low",
      source: "work",
      title: `${openJobs} claimable citation-repair job${openJobs === 1 ? "" : "s"} available`,
      detail: "Start with a dry run before any guarded mutation.",
    });
    suggestedActions.add("run one wikipedia citation repair dry run only");
  }

  const health = attentionItems.some((item) => stringField(item, "severity") === "high")
    ? "blocked"
    : attentionItems.length > 0
      ? "attention"
      : "ok";

  if (attentionItems.length === 0) suggestedActions.add("No action needed.");

  return {
    kind: "daily_operator_decision_summary",
    generatedAt: new Date().toISOString(),
    health,
    attentionItems: attentionItems.slice(0, 6),
    suggestedActions: [...suggestedActions].slice(0, 5),
    signals: {
      ops: {
        health: opsState ?? (stringField(opsHealth, "error") ? "unavailable" : "unknown"),
      },
      github: {
        health: githubHealth ?? (stringField(github, "error") ? "unavailable" : "unknown"),
        openPullRequests,
        openIssues,
        failingWorkflowRuns,
        activeWorkflowRuns,
      },
      handoffs: {
        active: activeHandoffs,
        running: runningHandoffs,
        recent: numberField(handoffCounts, "recent"),
        needsAttention: recentHandoffs.length,
      },
      work: {
        openWikipediaCitationRepairJobs: openJobs,
      },
      budget: {
        todayUsdRemaining,
        perDayUsdMax: numberField(budget, "perDayUsdMax"),
      },
    },
    safety: {
      readOnly: true,
      mutates: false,
      githubMutated: false,
      githubCheckpointWritten: false,
      editsWikipedia: false,
    },
  };
}

function addErrorAttention(items: Array<Record<string, unknown>>, record: Record<string, unknown>, source: string): void {
  const error = stringField(record, "error");
  if (!error) return;
  items.push({
    severity: "medium",
    source: source.toLowerCase().replace(/\s+/g, "_"),
    title: `${source} unavailable`,
    detail: error,
  });
}

function githubAttentionTitle(input: {
  failingWorkflowRuns: number;
  activeWorkflowRuns: number;
  openPullRequests: number;
  openIssues: number;
}): string {
  const parts = [
    input.failingWorkflowRuns > 0 ? `${input.failingWorkflowRuns} failing workflow${input.failingWorkflowRuns === 1 ? "" : "s"}` : "",
    input.activeWorkflowRuns > 0 ? `${input.activeWorkflowRuns} active workflow${input.activeWorkflowRuns === 1 ? "" : "s"}` : "",
    input.openPullRequests > 0 ? `${input.openPullRequests} open PR${input.openPullRequests === 1 ? "" : "s"}` : "",
    input.openIssues > 0 ? `${input.openIssues} open issue${input.openIssues === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "GitHub needs attention";
}

function isReviewWorthyHandoff(value: unknown): value is Record<string, unknown> {
  const record = toRecord(value);
  const summary = toRecord(record.summary);
  const status = stringField(record, "status");
  const finalVerdict = stringField(summary, "finalVerdict");
  const mergeRecommendation = stringField(summary, "mergeRecommendation");
  const reason = stringField(summary, "reason") ?? stringField(record, "reason");
  return (
    status === "failed" ||
    status === "blocked" ||
    isBlockingVerdict(finalVerdict) ||
    isBlockingVerdict(mergeRecommendation) ||
    finalVerdict === "needs_review" ||
    mergeRecommendation === "needs_review" ||
    reason === "github_needs_review" ||
    reason === "pr_review_hold"
  );
}

function isBlockingVerdict(value: string | undefined): boolean {
  return value === "block" || value === "blocked" || value === "hold" || value === "failed";
}

function handoffTitle(value: Record<string, unknown>): string {
  const repo = stringField(value, "repo") ?? "unknown repo";
  const pr = numberField(value, "pullRequestNumber");
  const intent = stringField(value, "intent") ?? "handoff";
  return `${repo}${pr > 0 ? ` #${pr}` : ""} ${intent} needs attention`;
}

function handoffDetail(value: Record<string, unknown>): string | undefined {
  const summary = toRecord(value.summary);
  return stringField(summary, "reason")
    ?? stringField(summary, "finalVerdict")
    ?? stringField(summary, "mergeRecommendation")
    ?? stringField(value, "reason");
}

function firstString(values: unknown[]): string | undefined {
  const value = values.find((entry) => typeof entry === "string" && entry.length > 0);
  return typeof value === "string" ? value : undefined;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  return Array.isArray(field) ? field : [];
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  const parsed = typeof field === "number" ? field : Number(field);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringField(value: unknown, key: string): string | undefined {
  const record = toRecord(value);
  const field = record[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
