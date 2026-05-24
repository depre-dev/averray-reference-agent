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

export interface TestbedAgentMissionInput {
  targetUrl?: string;
  goal?: string;
  agentName?: string;
  freshMemory?: boolean;
  allowTestMutations?: boolean;
  maxBrowserSteps?: number;
  maxMinutes?: number;
}

export function getTestbedAgentMission(input: TestbedAgentMissionInput = {}) {
  const targetUrl = cleanOptional(input.targetUrl) ?? "[TESTBED_URL]";
  const goal = cleanOptional(input.goal)
    ?? "Figure out what this page is for, complete the main user flow as far as the public UI allows, and report whether a normal outside agent can use it without private project context.";
  const agentName = cleanOptional(input.agentName) ?? "Hermes";
  const freshMemory = input.freshMemory !== false;
  const allowTestMutations = input.allowTestMutations === true;
  const maxBrowserSteps = clampInt(input.maxBrowserSteps, 20, 200, 80);
  const maxMinutes = clampInt(input.maxMinutes, 5, 60, 20);

  return {
    schemaVersion: 1,
    kind: "testbed_agent_browser_mission",
    generatedAt: new Date().toISOString(),
    mutates: false,
    headline: allowTestMutations
      ? "Fresh-agent browser mission ready: test-mode page mutation is allowed, but only inside the sandbox/testbed flow."
      : "Fresh-agent browser mission ready: test the page like a normal outside agent, not like an internal operator.",
    target: {
      url: targetUrl,
      goal,
      agentName,
      freshMemory,
      maxBrowserSteps,
      maxMinutes,
    },
    agentMode: {
      identity: "normal_out_of_box_agent",
      memoryMode: freshMemory ? "fresh_or_ignored" : "returning_agent_memory_allowed",
      browserOnly: true,
      privilegedAverrayMcpAllowed: false,
      hiddenProjectContextAllowed: false,
      humanHelpAllowed: false,
      mutationMode: allowTestMutations ? "testbed_mutation_allowed" : "stop_before_mutation",
      purpose: "Measure whether an agent with ordinary browser access can understand and use the public/testbed page.",
    },
    missionPrompt: [
      `You are ${agentName}, acting as a normal out-of-the-box agent visiting Averray for the first time.`,
      `Open ${targetUrl}.`,
      `Goal: ${goal}`,
      "",
      "Use only the browser-visible page, normal public links, and screenshots/observations from the page.",
      "Do not use private repository knowledge, databases, hidden monitor state, Averray MCP tools, Slack, GitHub, SSH, or operator memory unless the page itself gives you that information.",
      allowTestMutations
        ? "Work like a future external agent would: explain what you infer, try the main flow, and you may complete test-only submits or fake/sandbox mutations that the page itself presents as safe. Stop before real payment, real wallet signature, deploy, merge, production data change, or anything that is not clearly testbed-only."
        : "Work like a future external agent would: explain what you infer, try the main flow, note where you are uncertain, and stop before any real mutation, payment, wallet signature, submit, deploy, merge, or account-affecting action.",
      "",
      "Report with: verdict, completed path, blockers, confusing moments, evidence, screenshots or trace references, mutation boundary notes, and what would make the page easier for the next agent.",
    ].join("\n"),
    runbook: [
      "Start with a clean browser profile or explicitly ignore prior memory.",
      "Open the target URL and record the first thing the page appears to ask from a new agent.",
      "Identify the product purpose, primary user, and main task without reading private project notes.",
      "Attempt the main flow using only visible UI controls.",
      "Collect evidence: page states, URLs visited, visible copy that helped or blocked you, screenshots/trace references, and any console/network failures if available.",
      (allowTestMutations
        ? "Complete test-only page mutations when the UI clearly marks them as sandbox/fake/test; stop before real mutations or irreversible actions."
        : "Stop before real mutations or irreversible actions; describe the next required human or sandbox approval instead."),
      "Score the experience using the rubric and return the structured report.",
    ],
    allowedEvidence: [
      "browser-visible UI text and controls",
      "screenshots or trace references",
      "public documentation linked from the page",
      "client-side console or network errors if the browser exposes them",
      "the agent's own step-by-step observations",
    ],
    deniedShortcuts: [
      "private repo knowledge",
      "database queries",
      "Averray operator or workflow MCP tools after receiving this mission",
      "Slack, GitHub, monitor internals, or VPS commands",
      allowTestMutations
        ? "real wallet signatures, real payment, production submit, deploy, merge, or account mutation"
        : "wallet signatures, payment, submit, deploy, merge, or account mutation",
      "asking Pascal what to do during the mission",
    ],
    successCriteria: [
      "The agent can state what the page is for within the first screen or first natural click.",
      "The agent can identify the main task and whether it is safe to proceed.",
      allowTestMutations
        ? "The agent can complete the primary test flow, including safe sandbox/test-only actions when clearly labeled."
        : "The agent can complete or reach a clear sandbox stop point in the primary flow.",
      "Any blocker is explained with visible evidence, not private assumptions.",
      "The final report is useful enough for another agent to reproduce the run.",
    ],
    scoringRubric: [
      score("orientation", "Could the agent understand purpose and audience from the page itself?"),
      score("navigation", "Could the agent find the main path without private instructions?"),
      score("taskCompletion", "Could the agent complete the intended flow or reach a legitimate sandbox stop?"),
      score("trustAndSafety", "Did the page make mutation boundaries, wallet/signature risk, and data use clear?"),
      score("recoverability", "Could the agent recover from errors, empty states, or missing context?"),
      score("evidenceQuality", "Did the agent return enough trace/screenshot/detail for a reviewer to verify the verdict?"),
    ],
    reportSchema: {
      verdict: "pass | partial | fail",
      confidence: "0.0-1.0",
      targetUrl: "string",
      goal: "string",
      memoryMode: "fresh_or_ignored | returning_agent_memory_allowed",
      completedPath: ["ordered browser actions the agent took"],
      blockers: ["visible blocker or empty array"],
      confusingMoments: ["where the page required guessing"],
      evidence: [
        {
          type: "screenshot | url | visible_text | console | network | observation",
          value: "bounded evidence reference",
        },
      ],
      scores: {
        orientation: "0-5",
        navigation: "0-5",
        taskCompletion: "0-5",
        trustAndSafety: "0-5",
        recoverability: "0-5",
        evidenceQuality: "0-5",
      },
      recommendations: ["smallest page/product changes that would help the next outside agent"],
      mutationMode: allowTestMutations ? "testbed_mutation_allowed" : "stop_before_mutation",
      mutationsAttempted: ["test-only actions submitted, or empty array"],
      stoppedBeforeMutation: "boolean",
    },
    nextSteps: [
      "Run this once with fresh memory to measure first-contact usability.",
      "Run it again with returning-agent memory to measure whether memory improves the agent without hiding page gaps.",
      "Compare Hermes against other agents with the same mission prompt and rubric.",
    ],
    safety: {
      missionGeneratorMutates: false,
      browserMissionShouldMutate: allowTestMutations,
      allowedMutationScope: allowTestMutations
        ? "testbed-only page actions that are visibly fake, sandbox, or non-production"
        : "none; stop at mutation boundary",
      freshAgentDefault: true,
      requiresEvidence: true,
      comparesAcrossAgents: true,
    },
  };
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

function score(id: string, question: string) {
  return { id, scale: "0-5", question };
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
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
