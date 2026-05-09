import type { WorkflowDeps } from "./job-workflows.js";
import { runWikipediaCitationRepairWorkflow } from "./job-workflows.js";
import { getLastWikipediaCitationRepairStatus } from "./operator-commands.js";
import { getGithubOperatorStatus } from "./operator-github.js";
import { getBusinessLedger, getOpsHealth } from "./operator-insights.js";
import type { OperatorStatusDeps } from "./operator-status.js";
import { getDailyOperatorBrief, getOperatorStatus, getSafeWorkReport } from "./operator-status.js";

export interface TestbedE2eSuiteDeps extends OperatorStatusDeps {
  env?: Record<string, string | undefined>;
}

export interface TestbedE2eReadOnlyRunDeps {
  query: OperatorStatusDeps["query"];
  workflowDeps: WorkflowDeps;
  env?: Record<string, string | undefined>;
}

export interface TestbedE2eReadOnlyRunOptions {
  testCaseIds?: string[];
}

export async function getTestbedE2eSuite(deps: TestbedE2eSuiteDeps) {
  const [status, safeWork] = await Promise.all([
    getOperatorStatus(deps),
    getSafeWorkReport(deps),
  ]);
  const env = deps.env ?? process.env;
  const githubConfigured = hasAny(env, ["GITHUB_TOKEN", "GITHUB_OWNER_TOKENS", "GITHUB_REPO_TOKENS"])
    && hasAny(env, ["GITHUB_DEFAULT_REPO", "GITHUB_HELPER_REPOS"]);

  const budgetRemaining = status.policy.budget.todayUsdRemaining;
  const blockers = [
    ...(status.agent.walletReady ? [] : ["wallet_not_ready"]),
    ...(budgetRemaining > 0 ? [] : ["budget_depleted"]),
    ...(status.workflows.wikipediaCitationRepair.openJobs > 0 ? [] : ["no_open_wikipedia_citation_repair_jobs"]),
  ];
  const warnings = [
    ...(githubConfigured ? [] : ["github_helper_not_fully_configured"]),
    ...(status.errors ?? []).map((entry) => `operator_status_warning:${entry}`),
    ...(safeWork.errors ?? []).map((entry) => `safe_work_warning:${entry}`),
  ];
  const canRunDryRun = status.agent.walletReady && status.workflows.wikipediaCitationRepair.openJobs > 0;
  const canRunGuardedLive = blockers.length === 0;

  return {
    schemaVersion: 1,
    kind: "testbed_e2e_suite",
    generatedAt: status.generatedAt,
    mutates: false,
    headline: canRunDryRun
      ? "Platform testbed is ready for read-only and dry-run E2E checks."
      : "Platform testbed can run read-only checks, but workflow E2E has blockers.",
    readiness: {
      overall: blockers.length === 0 ? "ready" : "blocked",
      canRunReadOnly: true,
      canRunDryRun,
      canRunGuardedLive,
      blockers,
      warnings,
    },
    context: {
      wallet: {
        ready: status.agent.walletReady,
        address: status.agent.walletAddress,
        network: status.agent.network,
      },
      budget: status.policy.budget,
      openWikipediaCitationRepairJobs: status.workflows.wikipediaCitationRepair.openJobs,
      latestWikipediaCitationRepair: status.workflows.wikipediaCitationRepair.latestRun,
      githubConfigured,
    },
    recommendedRunOrder: [
      "TBE2E-001",
      "TBE2E-002",
      "TBE2E-003",
      "TBE2E-004",
      "TBE2E-005",
      "TBE2E-006",
      "TBE2E-007",
      "TBE2E-008",
      "TBE2E-009",
      "TBE2E-010",
      "TBE2E-011",
    ],
    testCases: [
      testCase({
        id: "TBE2E-001",
        phase: "readiness",
        name: "Operator readiness",
        command: "operator status",
        mcpTool: "averray_operator_status",
        status: "ready",
        expectedEvidence: ["wallet readiness", "budget state", "open job count", "latest run summary"],
        successCriteria: ["response mutates=false", "safe commands are present", "no broad admin permissions are implied"],
      }),
      testCase({
        id: "TBE2E-002",
        phase: "briefing",
        name: "Daily operator brief",
        command: "daily operator brief",
        mcpTool: "averray_daily_operator_brief",
        status: "ready",
        expectedEvidence: ["readiness headline", "recommended next action", "candidate jobs if available"],
        successCriteria: ["brief is read-only", "operators can decide dry-run vs live workflow"],
      }),
      testCase({
        id: "TBE2E-003",
        phase: "discovery",
        name: "Safe work discovery",
        command: "find safe work",
        mcpTool: "averray_find_safe_work",
        status: safeWork.available ? "ready" : "blocked",
        blockers: safeWork.blockers,
        expectedEvidence: ["available flag", "dry-run command", "guarded mutation command"],
        successCriteria: ["no claim or submit attempted", "each work item exposes the exact dry-run command"],
      }),
      testCase({
        id: "TBE2E-004",
        phase: "dry_run",
        name: "Wikipedia citation repair dry run",
        command: "run one wikipedia citation repair dry run only",
        mcpTool: "averray_run_wikipedia_citation_repair",
        status: canRunDryRun ? "ready" : "blocked",
        blockers: canRunDryRun ? [] : blockers,
        expectedEvidence: ["selected job", "read-only source checks", "draft/proposal summary", "validation result"],
        successCriteria: ["dryRun=true", "no claim", "no submit", "no Wikipedia edit"],
      }),
      testCase({
        id: "TBE2E-005",
        phase: "guarded_mutation",
        name: "Guarded live Wikipedia citation repair",
        command: "run one wikipedia citation repair if safe",
        mcpTool: "averray_run_wikipedia_citation_repair",
        status: canRunGuardedLive ? "manual" : "blocked",
        blockers: canRunGuardedLive ? [] : blockers,
        mutates: true,
        mutationScope: "averray_claim_draft_validate_submit_only",
        expectedEvidence: ["claim policy pass", "draftId", "validation pass", "submit or confidence-held report"],
        successCriteria: ["explicit command only", "draft saved before validation", "submit only if validation passes and confidence threshold is met"],
      }),
      testCase({
        id: "TBE2E-006",
        phase: "verification",
        name: "Latest workflow status verification",
        command: "status last wikipedia citation repair details",
        mcpTool: "averray_status_last_wikipedia_citation_repair",
        status: "ready",
        expectedEvidence: ["runId", "jobId", "sessionId", "draftId", "submit_succeeded flag"],
        successCriteria: ["status is read-only", "submitted, failed, or held state is explicit"],
      }),
      testCase({
        id: "TBE2E-007",
        phase: "business",
        name: "Business ledger",
        command: "business ledger",
        mcpTool: "averray_business_ledger",
        status: "ready",
        expectedEvidence: ["recent submissions", "draft counts", "budget snapshot", "operator activity"],
        successCriteria: ["ledger is read-only", "latest run and open work agree with operator status"],
      }),
      testCase({
        id: "TBE2E-008",
        phase: "ops",
        name: "Control-plane ops health",
        command: "ops health",
        mcpTool: "averray_ops_health",
        status: "ready",
        expectedEvidence: ["wallet/budget", "table counts", "recent errors", "recent operator events"],
        successCriteria: ["recent errors are reported clearly", "host-level checks are identified as outside MCP if needed"],
      }),
      testCase({
        id: "TBE2E-009",
        phase: "github",
        name: "GitHub repo status",
        command: "github status",
        mcpTool: "averray_github_status",
        status: githubConfigured ? "ready" : "optional",
        blockers: githubConfigured ? [] : ["github_env_missing_or_partial"],
        expectedEvidence: ["open PRs", "open issues", "CI failures", "active workflow runs"],
        successCriteria: ["GitHub is read-only", "no PR merge, issue edit, or workflow rerun is attempted"],
      }),
      testCase({
        id: "TBE2E-010",
        phase: "github",
        name: "GitHub delta brief",
        command: "github brief",
        mcpTool: "averray_github_brief",
        status: githubConfigured ? "ready" : "optional",
        blockers: githubConfigured ? [] : ["github_env_missing_or_partial"],
        mutates: true,
        mutationScope: "local_brief_checkpoint_only",
        expectedEvidence: ["what changed", "what merged", "what deployed", "what failed", "what needs attention"],
        successCriteria: ["GitHub is not mutated", "local checkpoint behavior is disclosed"],
      }),
      testCase({
        id: "TBE2E-011",
        phase: "surface_parity",
        name: "Surface parity smoke",
        command: "operator status",
        mcpTool: "averray_handle_operator_command",
        status: "manual",
        expectedEvidence: ["same command works through MCP", "same command works through Slack", "same command works through Command Center"],
        successCriteria: ["outputs agree on wallet, budget, open jobs, and latest run", "Slack may compact IDs but details mode exposes full audit IDs"],
      }),
    ],
    safety: {
      suiteGeneratorMutates: false,
      readOnlyExternalSystemsMutated: false,
      githubBriefWritesLocalCheckpoint: true,
      guardedLiveCaseMutates: true,
      editsWikipedia: false,
      requiresExplicitMutationCommand: true,
      validationRequiredBeforeSubmit: true,
      confidenceThreshold: status.policy.submitConfidenceThreshold,
    },
    nextCommands: {
      readOnly: "testbed e2e suite",
      dryRun: "run one wikipedia citation repair dry run only",
      guardedLive: "run one wikipedia citation repair if safe",
      verify: "status last wikipedia citation repair details",
    },
  };
}

export async function runTestbedE2eReadOnly(
  deps: TestbedE2eReadOnlyRunDeps,
  options: TestbedE2eReadOnlyRunOptions = {}
) {
  const suite = await getTestbedE2eSuite(deps);
  const requestedIds = normalizeTestCaseIds(options.testCaseIds);
  const selectedCases = requestedIds.length > 0
    ? suite.testCases.filter((entry) => requestedIds.includes(entry.id))
    : suite.testCases;
  const unknownCases = requestedIds
    .filter((id) => !suite.testCases.some((entry) => entry.id === id))
    .map((id) => unknownSkippedCase(id));
  const runnable = selectedCases.filter(isReadOnlyRunnableCase);
  const skipped = selectedCases
    .filter((entry) => !isReadOnlyRunnableCase(entry))
    .map((entry) => skippedCase(entry, skipReason(entry)))
    .concat(unknownCases);
  const startedAt = new Date();
  const executed = [];

  for (const test of runnable) {
    executed.push(await runReadOnlyCase(test, deps));
  }

  const cases = [...executed, ...skipped];
  const failed = executed.filter((entry) => entry.status === "failed").length;
  const passed = executed.filter((entry) => entry.status === "passed").length;
  return {
    schemaVersion: 1,
    kind: "testbed_e2e_read_only_run",
    generatedAt: new Date().toISOString(),
    mutates: false,
    status: failed === 0 ? "passed" : "failed",
    suiteGeneratedAt: suite.generatedAt,
    requestedCaseIds: requestedIds,
    summary: {
      totalCases: selectedCases.length + unknownCases.length,
      executed: executed.length,
      passed,
      failed,
      skipped: skipped.length,
    },
    cases,
    skippedMutationBoundaries: skipped
      .filter((entry) => entry.mutationScope)
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        mutationScope: entry.mutationScope,
        reason: entry.reason,
      })),
    safety: {
      mutates: false,
      skippedGuardedLiveWorkflow: true,
      skippedGithubBriefCheckpoint: true,
      skippedManualSurfaceParity: true,
      dryRunWorkflowAllowed: true,
      editsWikipedia: false,
    },
    durationMs: Date.now() - startedAt.getTime(),
  };
}

function testCase(input: {
  id: string;
  phase: string;
  name: string;
  command: string;
  mcpTool: string;
  status: "ready" | "blocked" | "optional" | "manual";
  mutates?: boolean;
  mutationScope?: string;
  blockers?: string[];
  expectedEvidence: string[];
  successCriteria: string[];
}) {
  return {
    id: input.id,
    phase: input.phase,
    name: input.name,
    status: input.status,
    mutates: input.mutates === true,
    ...(input.mutationScope ? { mutationScope: input.mutationScope } : {}),
    ...(input.blockers && input.blockers.length > 0 ? { blockers: input.blockers } : {}),
    surfaces: {
      mcpTool: input.mcpTool,
      operatorCommand: input.command,
      slackExample: `@Averray Reference Agent ${input.command}`,
      commandCenterPrompt: input.command,
    },
    expectedEvidence: input.expectedEvidence,
    successCriteria: input.successCriteria,
  };
}

type TestbedCase = ReturnType<typeof testCase>;

async function runReadOnlyCase(test: TestbedCase, deps: TestbedE2eReadOnlyRunDeps) {
  const startedAt = Date.now();
  try {
    const evidence = await evidenceForCase(test.id, deps);
    return {
      id: test.id,
      phase: test.phase,
      name: test.name,
      command: test.surfaces.operatorCommand,
      status: "passed" as const,
      mutates: false,
      evidence,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      id: test.id,
      phase: test.phase,
      name: test.name,
      command: test.surfaces.operatorCommand,
      status: "failed" as const,
      mutates: false,
      error: errorMessage(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

async function evidenceForCase(id: string, deps: TestbedE2eReadOnlyRunDeps) {
  if (id === "TBE2E-001") {
    const status = await getOperatorStatus(deps);
    assertFalse(status.mutates, "operator status must not mutate");
    return {
      walletReady: status.agent.walletReady,
      openJobs: status.workflows.wikipediaCitationRepair.openJobs,
      latestRunStatus: status.workflows.wikipediaCitationRepair.latestRun.found
        ? status.workflows.wikipediaCitationRepair.latestRun.status ?? "none"
        : "none",
    };
  }
  if (id === "TBE2E-002") {
    const brief = await getDailyOperatorBrief(deps);
    assertFalse(brief.mutates, "daily operator brief must not mutate");
    return {
      headline: brief.headline,
      openJobs: brief.openWikipediaCitationRepairJobs,
      suggestedCommands: brief.suggestedCommands.length,
    };
  }
  if (id === "TBE2E-003") {
    const safeWork = await getSafeWorkReport(deps);
    assertFalse(safeWork.mutates, "safe work report must not mutate");
    return {
      available: safeWork.available,
      blockers: safeWork.blockers,
      safeWorkItems: safeWork.safeWorkItems.length,
      recommendedCommand: safeWork.recommendedCommand,
    };
  }
  if (id === "TBE2E-004") {
    const result = await runWikipediaCitationRepairWorkflow(
      { dryRun: true, maxEvidenceUrls: 5, confidenceThreshold: 0.7 },
      deps.workflowDeps
    );
    const resultRecord: Record<string, unknown> = isRecord(result) ? result : {};
    const validation = isRecord(resultRecord.validation) ? resultRecord.validation : {};
    const evidenceSummary = isRecord(resultRecord.evidenceSummary) ? resultRecord.evidenceSummary : {};
    const proposalSummary = isRecord(resultRecord.proposalSummary) ? resultRecord.proposalSummary : {};
    assertFalse(result.dryRun === false, "citation repair preview must be dryRun=true");
    return {
      status: result.status,
      runId: result.runId,
      jobId: result.jobId,
      confidence: numberField(resultRecord, "confidence") ?? null,
      validation: validation.valid === true ? "valid" : validation.valid === false ? "invalid" : "n/a",
      citationsReviewed: numberField(evidenceSummary, "totalCitations") ?? null,
      proposedFindings: numberField(proposalSummary, "citationFindings") ?? null,
    };
  }
  if (id === "TBE2E-006") {
    const status = await getLastWikipediaCitationRepairStatus(deps.query);
    return {
      found: status.found,
      runId: status.runId ?? null,
      jobId: status.jobId ?? null,
      status: status.status ?? "none",
      draftId: status.draftId ?? null,
      submitSucceeded: status.submitSucceeded,
    };
  }
  if (id === "TBE2E-007") {
    const ledger = await getBusinessLedger(deps);
    assertFalse(ledger.mutates, "business ledger must not mutate");
    return {
      openJobs: ledger.summary.openWikipediaCitationRepairJobs,
      submissions7d: ledger.summary.sevenDaySubmissions.total,
      drafts7d: ledger.summary.sevenDayDrafts.total,
      operatorCommands7d: ledger.summary.sevenDayOperatorCommands.total,
    };
  }
  if (id === "TBE2E-008") {
    const health = await getOpsHealth(deps);
    assertFalse(health.mutates, "ops health must not mutate");
    return {
      health: health.health,
      walletReady: health.wallet.walletReady,
      recentErrors: health.controlPlane.recentErrors.length,
      operatorEvents: health.controlPlane.tables.operatorEvents,
    };
  }
  if (id === "TBE2E-009") {
    const github = await getGithubOperatorStatus({ env: deps.env as NodeJS.ProcessEnv | undefined });
    assertFalse(github.mutates, "GitHub status must not mutate");
    return {
      configured: github.configured,
      health: github.health,
      repos: github.repoCount,
      openPullRequests: github.totals.openPullRequests,
      openIssues: github.totals.openIssues,
      failingWorkflowRuns: github.totals.failingWorkflowRuns,
      activeWorkflowRuns: github.totals.activeWorkflowRuns,
      warnings: github.warnings.map((entry) => entry.code),
    };
  }
  throw new Error(`No read-only runner registered for ${id}`);
}

function isReadOnlyRunnableCase(test: TestbedCase): boolean {
  return test.status !== "manual"
    && test.mutates !== true
    && test.mutationScope !== "local_brief_checkpoint_only";
}

function skippedCase(test: TestbedCase, reason: string) {
  return {
    id: test.id,
    phase: test.phase,
    name: test.name,
    command: test.surfaces.operatorCommand,
    status: "skipped" as const,
    mutates: test.mutates,
    ...(test.mutationScope ? { mutationScope: test.mutationScope } : {}),
    reason,
  };
}

function unknownSkippedCase(id: string) {
  return {
    id,
    phase: "unknown",
    name: "Unknown testbed case",
    command: "",
    status: "skipped" as const,
    mutates: false,
    reason: "unknown_test_case",
  };
}

function skipReason(test: TestbedCase): string {
  if (test.mutationScope === "local_brief_checkpoint_only") return "writes_local_github_brief_checkpoint";
  if (test.mutates) return "requires_explicit_mutation_command";
  if (test.status === "manual") return "requires_manual_surface_or_human_action";
  return "not_read_only_runnable";
}

function normalizeTestCaseIds(ids: string[] | undefined): string[] {
  return Array.from(new Set((ids ?? [])
    .map((id) => id.trim().toUpperCase())
    .filter(Boolean)));
}

function assertFalse(value: boolean | undefined, message: string) {
  if (value === true) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAny(env: Record<string, string | undefined>, keys: string[]): boolean {
  return keys.some((key) => typeof env[key] === "string" && env[key]!.trim().length > 0);
}
