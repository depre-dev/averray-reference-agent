import type { WorkflowDeps } from "./job-workflows.js";
import {
  parseOperatorCommand,
  type OperatorQueryFn,
  type ParsedOperatorCommand,
} from "./operator-commands.js";
import {
  getGithubOperatorStatus,
  getGithubPullRequestReview,
  upsertGithubPullRequestComment,
  type GithubPullRequestMergeRecommendation,
  type GithubPullRequestReview,
  type GithubPullRequestTouchedArea,
} from "./operator-github.js";
import { handleOperatorCommandText } from "./operator-handler.js";
import { runTestbedE2eReadOnly } from "./operator-testbed.js";
import {
  recordHandoffEvent,
  summarizeHandoffError,
  summarizeHandoffResult,
  type HandoffEventInput,
} from "./handoff-events.js";
import { assertNoKillSwitch } from "@avg/mcp-common";
import {
  loadDispatchPolicyConfig,
  evaluateDispatchPolicy,
  type DispatchPolicyConfig,
} from "./dispatch-policy.js";
import { classifyTask, type RiskTier } from "./dispatch-routing.js";
import { getAgentScorecard } from "./agent-scorecard.js";
import {
  applyLearnedRouting,
  parseLearnedRoutingConfig,
  type LearnedRoutingConfig,
} from "./learned-routing.js";
import {
  createHermesDecisionRecord,
  extendHermesDecisionRecord,
  type HermesDecisionRecord,
} from "./decision-records.js";

export type AgentInvocationIntent =
  | "operator_command"
  | "testbed_e2e_read_only"
  | "testbed_suite"
  | "testbed_case"
  | "pr_code_review"
  | "pr_handoff"
  | "post_deploy_verification"
  | "enqueue_agent_task";

/** A task Hermes proposed (O4). Proposes-only: status is "proposed", never approved. */
export interface ProposedAgentTask {
  repo: string;
  agent: "codex" | "claude";
  prompt: string;
  requester: string;
  pullRequestNumber?: number;
  reason?: string;
  /** O4-PR2 routing: persisted risk tier (PR3's autopilot reads it) + why. */
  riskTier?: RiskTier;
  routingReason?: string;
  /** D2: durable explanation for the Hermes routing decision. */
  decisionRecord?: HermesDecisionRecord;
}

/** A queued task, as returned by GET /monitor/codex-tasks (for the daily budget). */
export interface QueuedTaskSummary {
  requester?: string;
  createdAt?: string;
  repo?: string;
}

export interface AgentInvocationInput {
  requester: string;
  intent?: AgentInvocationIntent;
  command?: string;
  testCaseId?: string;
  testCaseIds?: string[];
  runReadOnlySuite?: boolean;
  postReviewCommand?: string;
  repo?: string;
  sha?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  correlationId?: string;
  reason?: string;
  healthUrls?: string[];
  allowMutations?: boolean;
  allowLocalCheckpoint?: boolean;
  expectedWallet?: string;
  defaultDryRun?: boolean;
  maxEvidenceUrls?: number;
  confidenceThreshold?: number;
  /** enqueue_agent_task: the task prompt + which agent to propose it to. */
  prompt?: string;
  /** Explicit agent; when omitted it's DERIVED from the routing taxonomy (overridable). */
  agent?: "codex" | "claude";
  /** Optional surface hint for routing (e.g. "contracts", "ui"). */
  area?: string;
}

export interface AgentInvocationDeps {
  query: OperatorQueryFn;
  workflowDeps: WorkflowDeps;
  githubEnv?: NodeJS.ProcessEnv;
  githubFetchFn?: typeof fetch;
  healthFetchFn?: typeof fetch;
  handoffEventRecorder?: (event: HandoffEventInput) => Promise<unknown>;
  now?: Date;
  // ── enqueue_agent_task (O4) — all injectable for tests (no network). ──
  /** Dispatch guardrail config; defaults to loadDispatchPolicyConfig(env). */
  dispatchPolicyConfig?: DispatchPolicyConfig;
  /** POST a PROPOSED task to the queue; defaults to the slack-operator endpoint. */
  proposeTaskFn?: (task: ProposedAgentTask) => Promise<{ id?: string }>;
  /** List queued tasks for the daily budget; defaults to GET the queue endpoint. */
  listQueuedTasksFn?: () => Promise<QueuedTaskSummary[]>;
  /** HALT kill-switch check; defaults to assertNoKillSwitch. */
  assertNoKillSwitchFn?: (toolName: string) => Promise<void>;
  /** A1 scorecard source for A2 learned routing; defaults to getAgentScorecard. */
  agentScorecardFn?: () => Promise<unknown>;
  /** A2 learned routing config override; defaults to env + conservative defaults. */
  learnedRoutingConfig?: Partial<LearnedRoutingConfig>;
  /** Injectable RNG for deterministic A2 exploration tests. */
  routingRandomFn?: () => number;
  /** Env for the default enqueue transport + policy load. */
  enqueueEnv?: NodeJS.ProcessEnv;
}

const POST_DEPLOY_TEST_CASES = [
  "TBE2E-001",
  "TBE2E-002",
  "TBE2E-003",
  "TBE2E-006",
  "TBE2E-007",
  "TBE2E-008",
  "TBE2E-009",
  "TBE2E-010",
];

const READ_ONLY_TEST_CASES = new Set([
  "TBE2E-001",
  "TBE2E-002",
  "TBE2E-003",
  "TBE2E-004",
  "TBE2E-006",
  "TBE2E-007",
  "TBE2E-008",
  "TBE2E-009",
]);

export async function invokeAgentTask(input: AgentInvocationInput, deps: AgentInvocationDeps): Promise<unknown> {
  const startedAt = new Date();
  const intent = input.intent ?? (input.testCaseId ? "testbed_case" : "operator_command");
  const normalizedTestCaseIds = normalizeTestCaseIds(input.testCaseIds ?? []);
  const invocation = {
    requester: input.requester,
    intent,
    ...(input.command ? { command: input.command } : {}),
    ...(input.testCaseId ? { testCaseId: normalizeTestCaseId(input.testCaseId) } : {}),
    ...(normalizedTestCaseIds.length ? { testCaseIds: normalizedTestCaseIds } : {}),
    ...(input.runReadOnlySuite ? { runReadOnlySuite: true } : {}),
    ...(input.postReviewCommand ? { postReviewCommand: input.postReviewCommand } : {}),
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.sha ? { sha: input.sha } : {}),
    ...(input.pullRequestNumber ? { pullRequestNumber: input.pullRequestNumber } : {}),
    ...(input.pullRequestUrl ? { pullRequestUrl: input.pullRequestUrl } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  const correlationId = input.correlationId?.trim() || localCorrelationId(startedAt, input.requester, intent);
  await recordInvocationEvent(deps, input, invocation, correlationId, {
    phase: "started",
    status: "running",
    summary: {
      requestedCaseIds: normalizedTestCaseIds,
      ...(input.testCaseId ? { requestedCaseId: normalizeTestCaseId(input.testCaseId) } : {}),
    },
  });

  try {
    const result = await invokeAgentTaskInner(input, deps, invocation, startedAt, intent);
    const resultRecord = isRecord(result) ? result : {};
    await recordInvocationEvent(deps, input, invocation, correlationId, {
      phase: resultRecord.status === "blocked" ? "blocked" : "completed",
      status: resultRecord.status === "blocked" ? "blocked" : "completed",
      summary: summarizeHandoffResult(result),
      safety: isRecord(resultRecord.safety) ? resultRecord.safety : undefined,
    });
    return result;
  } catch (error) {
    await recordInvocationEvent(deps, input, invocation, correlationId, {
      phase: "failed",
      status: "failed",
      summary: summarizeHandoffError(error),
    });
    throw error;
  }
}

async function invokeAgentTaskInner(
  input: AgentInvocationInput,
  deps: AgentInvocationDeps,
  invocation: Record<string, unknown>,
  startedAt: Date,
  intent: AgentInvocationIntent
): Promise<unknown> {
  if (!input.requester.trim()) {
    return blockedInvocation(invocation, startedAt, "requester_required");
  }

  if (intent === "testbed_e2e_read_only" || intent === "testbed_suite") {
    const testCaseIds = normalizeTestCaseIds(input.testCaseIds ?? []);
    const run = await runTestbedE2eReadOnly(
      deps,
      testCaseIds.length > 0 ? { testCaseIds } : {}
    );
    return completedInvocation(invocation, startedAt, run, {
      mutates: false,
      localCheckpoint: false,
    });
  }

  if (intent === "pr_handoff") {
    return invokePullRequestHandoff(input, deps, invocation, startedAt);
  }

  if (intent === "pr_code_review") {
    return invokePullRequestCodeReview(input, deps, invocation, startedAt);
  }

  if (intent === "post_deploy_verification") {
    return invokePostDeployVerification(input, deps, invocation, startedAt);
  }

  if (intent === "enqueue_agent_task") {
    return invokeEnqueueAgentTask(input, deps, invocation, startedAt);
  }

  if (intent === "testbed_case") {
    const testCaseId = normalizeTestCaseId(input.testCaseId ?? "");
    if (!testCaseId) return blockedInvocation(invocation, startedAt, "test_case_id_required");
    if (READ_ONLY_TEST_CASES.has(testCaseId)) {
      const run = await runTestbedE2eReadOnly(deps, { testCaseIds: [testCaseId] });
      return completedInvocation(invocation, startedAt, run, {
        mutates: false,
        localCheckpoint: false,
      });
    }
    if (testCaseId === "TBE2E-005") {
      if (!input.allowMutations) {
        return blockedInvocation(invocation, startedAt, "mutation_case_requires_allow_mutations");
      }
      return invokeOperatorCommand("run one wikipedia citation repair if safe", input, deps, invocation, startedAt);
    }
    if (testCaseId === "TBE2E-010") {
      if (!input.allowLocalCheckpoint) {
        return blockedInvocation(invocation, startedAt, "local_checkpoint_case_requires_allow_local_checkpoint");
      }
      return invokeOperatorCommand("github brief", input, deps, invocation, startedAt);
    }
    if (testCaseId === "TBE2E-011") {
      return blockedInvocation(invocation, startedAt, "manual_surface_parity_case");
    }
    return blockedInvocation(invocation, startedAt, "unknown_test_case");
  }

  const command = input.command?.trim();
  if (!command) return blockedInvocation(invocation, startedAt, "command_required");
  return invokeOperatorCommand(command, input, deps, invocation, startedAt);
}

async function invokePostDeployVerification(
  input: AgentInvocationInput,
  deps: AgentInvocationDeps,
  invocation: Record<string, unknown>,
  startedAt: Date
): Promise<unknown> {
  const requestedTestCaseIds = normalizeTestCaseIds(
    input.testCaseIds && input.testCaseIds.length > 0 ? input.testCaseIds : POST_DEPLOY_TEST_CASES
  );
  const [suiteRun, github, hostedHealth] = await Promise.all([
    runTestbedE2eReadOnly(deps, { testCaseIds: requestedTestCaseIds }),
    getGithubOperatorStatus({
      view: "ci",
      env: githubEnvForInvocation(input, deps.githubEnv),
      ...(deps.githubFetchFn ? { fetchFn: deps.githubFetchFn } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }),
    checkHostedHealth({
      urls: input.healthUrls ?? configuredHealthUrls(deps.githubEnv ?? process.env),
      fetchFn: deps.healthFetchFn ?? fetch,
    }),
  ]);
  const suiteSummary = suiteSummaryRecord(suiteRun);
  const opsSignals = opsSignalsFromSuite(suiteRun);
  const failedSuiteCases = typeof suiteSummary.failed === "number" ? suiteSummary.failed : 0;
  const hostedFailures = hostedHealth.checks.filter((check) => check.status === "failed").length;
  const githubFailures = github.totals.failingWorkflowRuns;
  const finalVerdict = failedSuiteCases > 0 || hostedFailures > 0 || githubFailures > 0
    ? "block"
    : "pass";
  const finalReason = finalVerdict === "block"
    ? firstPresent([
      failedSuiteCases > 0 ? "testbed_cases_failed" : undefined,
      hostedFailures > 0 ? "hosted_health_failed" : undefined,
      githubFailures > 0 ? "github_workflow_failed" : undefined,
    ]) ?? "post_deploy_attention"
    : "post_deploy_healthy";

  return completedInvocation(invocation, startedAt, {
    schemaVersion: 1,
    kind: "agent_post_deploy_verification",
    status: "completed",
    repo: input.repo ?? null,
    sha: input.sha ?? null,
    requestedCaseIds: requestedTestCaseIds,
    suite: suiteRun,
    deploymentHealth: {
      finalVerdict,
      finalReason,
      suite: suiteSummary,
      hosted: hostedHealth,
      github: {
        configured: github.configured,
        health: github.health,
        totals: github.totals,
        failingWorkflowRuns: github.views.ci
          .filter((run) => run.conclusion === "failure" || run.conclusion === "cancelled")
          .slice(0, 5),
        activeWorkflowRuns: github.views.ci
          .filter((run) => run.status !== "completed")
          .slice(0, 5),
      },
      ops: opsSignals,
    },
    finalVerdict,
    finalReason,
    safety: {
      source: "agent",
      wouldMutate: false,
      wouldWriteLocalCheckpoint: false,
      freeFormHermesPromptUsed: false,
    },
  }, { mutates: false, localCheckpoint: false });
}

async function invokePullRequestCodeReview(
  input: AgentInvocationInput,
  deps: AgentInvocationDeps,
  invocation: Record<string, unknown>,
  startedAt: Date
): Promise<unknown> {
  const review = await getGithubPullRequestReview({
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.pullRequestNumber ? { pullRequestNumber: input.pullRequestNumber } : {}),
    ...(input.pullRequestUrl ? { pullRequestUrl: input.pullRequestUrl } : {}),
    ...(deps.githubEnv ? { env: deps.githubEnv } : {}),
    ...(deps.githubFetchFn ? { fetchFn: deps.githubFetchFn } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const codeReview = buildPullRequestCodeReview(review);

  return completedInvocation(invocation, startedAt, {
    schemaVersion: 1,
    kind: "agent_pr_code_review",
    status: review.configured && review.health !== "degraded" ? "completed" : "blocked",
    repo: review.repo ?? input.repo ?? null,
    pullRequestNumber: review.pullRequestNumber ?? input.pullRequestNumber ?? null,
    pullRequestUrl: review.pullRequest?.url ?? input.pullRequestUrl ?? null,
    github: review,
    codeReview,
    finalVerdict: codeReview.finalVerdict,
    finalReason: codeReview.finalReason,
    mergeRecommendation: codeReview.mergeRecommendation,
    safety: prHandoffSafety(false, false),
  }, { mutates: false, localCheckpoint: false });
}

async function invokePullRequestHandoff(
  input: AgentInvocationInput,
  deps: AgentInvocationDeps,
  invocation: Record<string, unknown>,
  startedAt: Date
): Promise<unknown> {
  const review = await getGithubPullRequestReview({
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.pullRequestNumber ? { pullRequestNumber: input.pullRequestNumber } : {}),
    ...(input.pullRequestUrl ? { pullRequestUrl: input.pullRequestUrl } : {}),
    ...(deps.githubEnv ? { env: deps.githubEnv } : {}),
    ...(deps.githubFetchFn ? { fetchFn: deps.githubFetchFn } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  const codeReview = buildPullRequestCodeReview(review);
  const requestedTestCaseIds = normalizeTestCaseIds([
    ...(input.testCaseId ? [input.testCaseId] : []),
    ...(input.testCaseIds ?? []),
  ]);
  const requestedActions = {
    runReadOnlySuite: input.runReadOnlySuite === true,
    testCaseIds: requestedTestCaseIds,
    ...(input.postReviewCommand ? { postReviewCommand: input.postReviewCommand } : {}),
  };

  if (!review.configured || review.health === "degraded") {
    const handoff = {
      schemaVersion: 1,
      kind: "agent_pr_handoff",
      status: "blocked",
      repo: review.repo ?? input.repo ?? null,
      pullRequestNumber: review.pullRequestNumber ?? input.pullRequestNumber ?? null,
      pullRequestUrl: review.pullRequest?.url ?? input.pullRequestUrl ?? null,
      github: review,
      codeReview,
      requestedActions,
      tests: [],
      finalVerdict: "hold",
      finalReason: "github_pr_review_unavailable",
      safety: prHandoffSafety(false, false),
    };
    const prComment = await maybePostPrHandoffComment(input, deps, handoff);
    return completedInvocation(invocation, startedAt, withOptionalPrComment(handoff, prComment), {
      mutates: prComment?.mutatesGithub === true,
      localCheckpoint: false,
    });
  }

  if (review.mergeRecommendation === "hold") {
    const handoff = {
      schemaVersion: 1,
      kind: "agent_pr_handoff",
      status: "completed",
      repo: review.repo ?? input.repo ?? null,
      pullRequestNumber: review.pullRequestNumber ?? input.pullRequestNumber ?? null,
      pullRequestUrl: review.pullRequest?.url ?? input.pullRequestUrl ?? null,
      github: review,
      codeReview,
      requestedActions,
      tests: [],
      finalVerdict: "hold",
      finalReason: "pr_review_hold",
      safety: prHandoffSafety(false, false),
    };
    const prComment = await maybePostPrHandoffComment(input, deps, handoff);
    return completedInvocation(invocation, startedAt, withOptionalPrComment(handoff, prComment), {
      mutates: prComment?.mutatesGithub === true,
      localCheckpoint: false,
    });
  }

  const tests: unknown[] = [];
  let wouldMutate = false;
  let wouldWriteLocalCheckpoint = false;

  if (input.runReadOnlySuite) {
    const run = await runTestbedE2eReadOnly(deps);
    tests.push(run);
  }

  for (const testCaseId of requestedTestCaseIds) {
    const {
      command: _command,
      testCaseIds: _testCaseIds,
      runReadOnlySuite: _runReadOnlySuite,
      postReviewCommand: _postReviewCommand,
      ...nestedInput
    } = input;
    const result: unknown = await invokeAgentTask(
      {
        ...nestedInput,
        intent: "testbed_case",
        testCaseId,
      },
      deps
    );
    tests.push(result);
    const safety: Record<string, unknown> = isRecord(result) && isRecord(result.safety) ? result.safety : {};
    wouldMutate = wouldMutate || safety.wouldMutate === true;
    wouldWriteLocalCheckpoint = wouldWriteLocalCheckpoint || safety.wouldWriteLocalCheckpoint === true;
  }

  if (input.postReviewCommand) {
    const result: unknown = await invokeOperatorCommand(input.postReviewCommand, input, deps, invocation, startedAt);
    tests.push(result);
    const safety: Record<string, unknown> = isRecord(result) && isRecord(result.safety) ? result.safety : {};
    wouldMutate = wouldMutate || safety.wouldMutate === true;
    wouldWriteLocalCheckpoint = wouldWriteLocalCheckpoint || safety.wouldWriteLocalCheckpoint === true;
  }

  const failedTests = tests.filter(testFailed).length;
  const finalVerdict = failedTests > 0
    ? "hold"
    : review.mergeRecommendation === "ok_to_merge"
      ? "ok_to_merge"
      : "needs_review";

  const handoff = {
    schemaVersion: 1,
    kind: "agent_pr_handoff",
    status: "completed",
    repo: review.repo ?? input.repo ?? null,
    pullRequestNumber: review.pullRequestNumber ?? input.pullRequestNumber ?? null,
    pullRequestUrl: review.pullRequest?.url ?? input.pullRequestUrl ?? null,
    github: review,
    codeReview,
    requestedActions,
    tests,
    finalVerdict,
    finalReason: failedTests > 0 ? "requested_tests_failed_or_blocked" : `github_${review.mergeRecommendation}`,
    safety: prHandoffSafety(wouldMutate, wouldWriteLocalCheckpoint),
  };
  const prComment = await maybePostPrHandoffComment(input, deps, handoff);
  return completedInvocation(invocation, startedAt, withOptionalPrComment(handoff, prComment), {
    mutates: wouldMutate || prComment?.mutatesGithub === true,
    localCheckpoint: wouldWriteLocalCheckpoint,
  });
}

function buildPullRequestCodeReview(review: GithubPullRequestReview) {
  const finalVerdict: GithubPullRequestMergeRecommendation = !review.configured || review.health === "degraded"
    ? "hold"
    : review.mergeRecommendation;
  const finalReason = !review.configured || review.health === "degraded"
    ? "github_pr_review_unavailable"
    : `github_${review.mergeRecommendation}`;
  const riskCategory = classifyPullRequestRiskCategory(review.review.touchedAreas);
  const highestRisk = review.riskFindings.some((finding) => finding.severity === "high")
    ? "high"
    : review.riskFindings.some((finding) => finding.severity === "medium")
      ? "medium"
      : "low";
  const why = review.riskFindings[0]?.message
    ?? (finalVerdict === "ok_to_merge"
      ? "PR metadata, changed files, and checks look merge-ready."
      : "PR needs operator review before merge.");

  return {
    schemaVersion: 1,
    kind: "agent_pr_code_review",
    mode: "read_only_recommendation",
    verifierLane: {
      purpose: "independent_pr_verification",
      currentRuntime: "structured_github_review",
      plannedRuntime: "codex_app_server",
      codexRuntimeUsed: false,
    },
    finalVerdict,
    finalReason,
    mergeRecommendation: finalVerdict,
    riskCategory,
    highestRisk,
    why,
    changedFiles: review.files.total,
    touchedAreas: review.review.touchedAreas,
    highRiskFiles: review.files.highRisk,
    checks: {
      total: review.checks.total,
      failed: review.checks.failed,
      active: review.checks.active,
      passed: review.checks.passed,
    },
    tests: {
      matchedTouchedAreas: review.review.missingTestSignals.length === 0,
      testFilesChanged: review.review.testFilesChanged,
      testSignals: review.review.testSignals,
      missingTestSignals: review.review.missingTestSignals,
    },
    rollout: {
      notesRequired: review.review.rolloutNotesRequired,
      notesPresent: review.review.rolloutNotesPresent,
    },
    reasons: review.riskFindings,
    recommendations: review.recommendations,
    safety: {
      source: "agent",
      readOnly: true,
      githubMutated: false,
      mergePerformed: false,
      deployTriggered: false,
      freeFormHermesPromptUsed: false,
      codexRuntimeUsed: false,
    },
  };
}

async function maybePostPrHandoffComment(
  input: AgentInvocationInput,
  deps: AgentInvocationDeps,
  handoff: Record<string, unknown>
) {
  const env = deps.githubEnv ?? process.env;
  if (!truthyEnv(env.GITHUB_PR_HANDOFF_COMMENTS_ENABLED)) return undefined;
  const repo = stringField(handoff, "repo") ?? input.repo;
  const pullRequestNumber = numberField(handoff, "pullRequestNumber") ?? input.pullRequestNumber;
  if (!repo || !pullRequestNumber) return undefined;
  return await upsertGithubPullRequestComment({
    repo,
    pullRequestNumber,
    body: buildPrHandoffCommentBody(input, handoff),
    env,
    ...(deps.githubFetchFn ? { fetchFn: deps.githubFetchFn } : {}),
  });
}

function withOptionalPrComment<T extends Record<string, unknown>>(handoff: T, prComment: unknown): T {
  if (!prComment) return handoff;
  const safety = isRecord(handoff.safety)
    ? { ...handoff.safety, githubMutated: isRecord(prComment) ? prComment.mutatesGithub === true : false }
    : undefined;
  return {
    ...handoff,
    prComment,
    ...(safety ? { safety } : {}),
  };
}

function buildPrHandoffCommentBody(input: AgentInvocationInput, handoff: Record<string, unknown>): string {
  const codeReview = isRecord(handoff.codeReview) ? handoff.codeReview : {};
  const checks = isRecord(codeReview.checks) ? codeReview.checks : {};
  const tests = isRecord(codeReview.tests) ? codeReview.tests : {};
  const finalVerdict = stringField(handoff, "finalVerdict") ?? stringField(codeReview, "finalVerdict") ?? "unknown";
  const finalReason = stringField(handoff, "finalReason") ?? stringField(codeReview, "finalReason") ?? "unknown";
  const mergeRecommendation = stringField(codeReview, "mergeRecommendation") ?? finalVerdict;
  const touchedAreas = arrayField(codeReview, "touchedAreas").map(String);
  const missingTestSignals = arrayField(tests, "missingTestSignals").map(String);
  const requestedActions = isRecord(handoff.requestedActions) ? handoff.requestedActions : {};
  const requestedTests = arrayField(requestedActions, "testCaseIds").map(String);
  const commentVerdict = prVerdictLabel(finalVerdict);
  const nextAction = nextCodexAction(commentVerdict);

  return [
    "<!-- averray-hermes-pr-handoff -->",
    "## Hermes PR handoff",
    "",
    `**Verdict:** ${commentVerdict}`,
    `**Reason:** ${finalReason}`,
    `**Merge recommendation:** ${mergeRecommendation}`,
    `**Next for Codex:** ${nextAction}`,
    "",
    "| Signal | Value |",
    "| --- | --- |",
    `| Checks | ${numberField(checks, "passed") ?? 0}/${numberField(checks, "total") ?? 0} passed; ${numberField(checks, "failed") ?? 0} failed; ${numberField(checks, "active") ?? 0} active |`,
    `| Touched areas | ${touchedAreas.length ? touchedAreas.join(", ") : "n/a"} |`,
    `| Requested tests | ${requestedTests.length ? requestedTests.join(", ") : "none"} |`,
    `| Missing test signal | ${missingTestSignals.length ? missingTestSignals.join(", ") : "none"} |`,
    `| Rollout notes | ${rolloutNotesValue(codeReview)} |`,
    "",
    `Correlation: \`${input.correlationId ?? "n/a"}\``,
    "",
    "_Hermes did not merge, deploy, rerun CI, or edit Wikipedia. This comment is the only GitHub mutation in this handoff._",
  ].join("\n");
}

function prVerdictLabel(value: string): "PASS" | "OPERATOR REVIEW" | "BLOCK" {
  if (value === "ok_to_merge" || value === "pass") return "PASS";
  if (value === "needs_review" || value === "human_review") return "OPERATOR REVIEW";
  return "BLOCK";
}

function nextCodexAction(verdict: "PASS" | "OPERATOR REVIEW" | "BLOCK"): string {
  if (verdict === "PASS") return "Continue normal merge queue or ask the operator for final approval.";
  if (verdict === "OPERATOR REVIEW") return "Attach the code-level pre-check evidence, then ask the operator for project/architecture sign-off.";
  return "Fix the blocking issue, push an update, and rerun CI before handing off again.";
}

function rolloutNotesValue(codeReview: Record<string, unknown>): string {
  const rollout = isRecord(codeReview.rollout) ? codeReview.rollout : {};
  if (rollout.notesRequired !== true) return "not required";
  return rollout.notesPresent === true ? "present" : "missing";
}

function classifyPullRequestRiskCategory(touchedAreas: GithubPullRequestTouchedArea[]): string {
  if (touchedAreas.length === 0) return "unknown";
  const highPriorityAreas: GithubPullRequestTouchedArea[] = [
    "contracts",
    "deploy",
    "workflow",
    "ops",
    "backend",
    "indexer",
    "frontend",
    "dependencies",
    "config",
    "tests",
    "docs",
  ];
  const matched = highPriorityAreas.filter((area) => touchedAreas.includes(area));
  if (matched.length === 0) return "mixed";
  return matched.length === 1 ? matched[0] : "mixed";
}

async function invokeOperatorCommand(
  command: string,
  input: AgentInvocationInput,
  deps: AgentInvocationDeps,
  invocation: Record<string, unknown>,
  startedAt: Date
) {
  const parsed = parseOperatorCommand(command, {
    source: "agent",
    defaultDryRun: input.defaultDryRun,
    maxEvidenceUrls: input.maxEvidenceUrls,
    confidenceThreshold: input.confidenceThreshold,
  });
  if (!parsed.handled) return blockedInvocation(invocation, startedAt, "unknown_operator_command", parsed);

  const mutation = mutationRisk(parsed);
  if (mutation.mutates && !input.allowMutations) {
    return blockedInvocation(invocation, startedAt, "mutation_requires_allow_mutations", parsed, mutation);
  }
  if (mutation.localCheckpoint && !input.allowLocalCheckpoint) {
    return blockedInvocation(invocation, startedAt, "local_checkpoint_requires_allow_local_checkpoint", parsed, mutation);
  }

  const result = await handleOperatorCommandText(
    {
      text: command,
      source: "agent",
      expectedWallet: input.expectedWallet,
      defaultDryRun: input.defaultDryRun,
      maxEvidenceUrls: input.maxEvidenceUrls,
      confidenceThreshold: input.confidenceThreshold,
    },
    deps
  );
  return completedInvocation(invocation, startedAt, result, mutation);
}

function mutationRisk(command: ParsedOperatorCommand) {
  if (!command.handled) return { mutates: false, localCheckpoint: false };
  if (command.kind === "github_brief") return { mutates: false, localCheckpoint: true };
  if (command.kind === "run_wikipedia_citation_repair") {
    return {
      mutates: command.input.dryRun !== true,
      localCheckpoint: false,
    };
  }
  return { mutates: false, localCheckpoint: false };
}

interface HostedHealthCheck {
  url: string;
  status: "ok" | "failed";
  httpStatus?: number;
  durationMs: number;
  error?: string;
}

async function checkHostedHealth(options: {
  urls: string[];
  fetchFn: typeof fetch;
}) {
  const startedAt = Date.now();
  if (options.urls.length === 0) {
    return {
      configured: false,
      status: "not_configured",
      checks: [] as HostedHealthCheck[],
      warnings: ["post_deploy_health_urls_not_configured"],
      durationMs: 0,
    };
  }
  const checks = await Promise.all(options.urls.map((url) => checkOneHealthUrl(url, options.fetchFn)));
  return {
    configured: true,
    status: checks.every((check) => check.status === "ok") ? "ok" : "failed",
    checks,
    warnings: [] as string[],
    durationMs: Date.now() - startedAt,
  };
}

async function checkOneHealthUrl(url: string, fetchFn: typeof fetch): Promise<HostedHealthCheck> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetchFn(url, { method: "GET", signal: controller.signal });
    return {
      url,
      status: response.ok ? "ok" : "failed",
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      url,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function configuredHealthUrls(env: NodeJS.ProcessEnv): string[] {
  const raw = env.AVERRAY_POST_DEPLOY_HEALTH_URLS
    ?? env.AVERRAY_HOSTED_HEALTH_URLS
    ?? "";
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function githubEnvForInvocation(
  input: AgentInvocationInput,
  env: NodeJS.ProcessEnv | undefined
): NodeJS.ProcessEnv {
  if (!input.repo) return env ?? process.env;
  return {
    ...(env ?? process.env),
    GITHUB_DEFAULT_REPO: env?.GITHUB_DEFAULT_REPO ?? input.repo,
  };
}

function suiteSummaryRecord(run: unknown): Record<string, unknown> {
  if (!isRecord(run) || !isRecord(run.summary)) return {};
  return run.summary;
}

function opsSignalsFromSuite(run: unknown) {
  if (!isRecord(run) || !Array.isArray(run.cases)) {
    return { status: "unknown", recentErrors: null, source: "testbed_suite" };
  }
  const opsCase = run.cases
    .filter(isRecord)
    .find((entry) => entry.id === "TBE2E-008");
  const evidence = isRecord(opsCase?.evidence) ? opsCase.evidence : {};
  return {
    status: stringField(evidence, "health") ?? "unknown",
    recentErrors: numberField(evidence, "recentErrors") ?? null,
    operatorEvents: numberField(evidence, "operatorEvents") ?? null,
    source: "testbed_suite",
  };
}

function firstPresent(values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

// O4 — Hermes proposes an agent task (proposes-only; never approves/runs).
// Order: HALT kill-switch → dispatch guardrail (allowlist + budget) → create a
// `proposed` task on the queue. The handoff event is recorded by the
// invokeAgentTask wrapper. The operator approval gate is untouched.
async function invokeEnqueueAgentTask(
  input: AgentInvocationInput,
  deps: AgentInvocationDeps,
  invocation: Record<string, unknown>,
  startedAt: Date
): Promise<unknown> {
  const repo = (input.repo ?? "").trim();
  const prompt = (input.prompt ?? "").trim();
  if (!repo) return blockedInvocation(invocation, startedAt, "repo_required");
  if (!prompt) return blockedInvocation(invocation, startedAt, "prompt_required");

  // Routing taxonomy (O4-PR2) + A2 learned default: explicit agent wins;
  // otherwise A2 may refine the low-risk default from the A1 scorecard. The
  // riskTier is ALWAYS computed by the static taxonomy and persisted (PR3's
  // autopilot reads it). The operator can still flip the agent at approval —
  // unchanged. No authority is granted here.
  const routingInput = { repo, prompt, ...(input.area ? { area: input.area } : {}) };
  const staticRouting = classifyTask(routingInput);
  const explicitAgent = (input.agent ?? "").trim();
  const agentExplicit = explicitAgent === "codex" || explicitAgent === "claude";

  // (a) HALT kill-switch — block cleanly rather than crash.
  const assertKill = deps.assertNoKillSwitchFn ?? assertNoKillSwitch;
  try {
    await assertKill("enqueue_agent_task");
  } catch {
    return blockedInvocation(invocation, startedAt, "halt_file_present", undefined, {
      mutates: false,
      localCheckpoint: false,
    });
  }

  const env = deps.enqueueEnv ?? process.env;
  let scorecardPromise: Promise<unknown> | undefined;
  const loadScorecard = () => {
    scorecardPromise ??= (deps.agentScorecardFn ?? (() => getAgentScorecard({ now: deps.now })))();
    return scorecardPromise;
  };
  const routing = agentExplicit
    ? {
      ...staticRouting,
      decisionRecord: createHermesDecisionRecord({
        kind: "routing",
        subject: { type: "repo", id: repo, repo },
        decision: `routed to ${explicitAgent}`,
        reasons: [
          `The request explicitly selected ${explicitAgent}.`,
          `Hermes still classified the task as ${staticRouting.riskTier}-risk for operator gates.`,
          staticRouting.reason,
        ],
        inputs: {
          riskTier: staticRouting.riskTier,
          routingReason: staticRouting.reason,
          staticDecision: staticRouting,
          explicitAgent: true,
          wouldChangeDecision: "A different explicit agent in the request would change the selected agent; the risk tier still comes from the static classifier.",
          policyGates: { dispatchEvaluated: false },
        },
        outcome: {
          summary: `${explicitAgent} selected from the explicit request; task still waits on operator gates.`,
          waitingNext: "Operator dispatch gate or the autopilot gate.",
        },
        safety: { readOnly: true, mutates: false },
        generatedAt: deps.now ?? startedAt,
      }),
    }
    : await resolveLearnedRouting(routingInput, staticRouting, deps, env, loadScorecard);
  const agent: "codex" | "claude" = agentExplicit ? explicitAgent : routing.agent;

  // (b) Dispatch guardrail — allowlist + per-day budget. Fail-closed.
  const policy = deps.dispatchPolicyConfig ?? loadDispatchPolicyConfig(env);
  const queued = await (deps.listQueuedTasksFn ?? defaultListQueuedTasks(env))().catch(
    () => [] as QueuedTaskSummary[],
  );
  const today = (deps.now ?? new Date()).toISOString().slice(0, 10);
  const hermesToday = queued.filter(
    (t) => (t.requester ?? "").toLowerCase() === "hermes" && (t.createdAt ?? "").slice(0, 10) === today,
  );
  const costBudget = policy.perDayUsdMax > 0
    ? await dispatchCostBudgetSnapshot(policy.perDayUsdMax, agent, today, loadScorecard)
    : disabledCostBudgetSnapshot();
  const decision = evaluateDispatchPolicy(policy, {
    repo,
    agent,
    todayCount: hermesToday.length,
    todayRepoCount: hermesToday.filter((t) => t.repo === repo).length,
    todayCostUsd: costBudget.todayCostUsd,
    estimatedTaskCostUsd: costBudget.estimatedTaskCostUsd,
  });
  const decisionRecord = routing.decisionRecord
    ? extendHermesDecisionRecord(routing.decisionRecord, {
      inputs: {
        policyGates: {
          dispatchEvaluated: true,
          dispatchAllowed: decision.allowed,
          dispatchReason: decision.reason,
          allowedRepos: policy.allowedRepos,
          allowedAgents: policy.allowedAgents,
        },
        budgetGates: {
          perDayMax: policy.perDayMax,
          perRepoPerDayMax: policy.perRepoPerDayMax,
          perDayUsdMax: policy.perDayUsdMax,
          todayCount: hermesToday.length,
          todayRepoCount: hermesToday.filter((t) => t.repo === repo).length,
          todayCostUsd: costBudget.todayCostUsd ?? "not_recorded",
          estimatedTaskCostUsd: costBudget.estimatedTaskCostUsd ?? "not_recorded",
          costBudgetStatus: costBudget.status,
        },
        wouldChangeDecision: decision.allowed
          ? "A dispatch policy block, exhausted count/cost budget, or explicit operator override would prevent this proposed task from moving forward."
          : "Allowlisting the repo/agent or restoring count/cost budget would let Hermes propose this task.",
      },
      outcome: {
        summary: decision.allowed
          ? `Task proposed for ${agent}; it is waiting at the dispatch gate.`
          : `Task was not proposed because the dispatch gate returned ${decision.reason}.`,
        waitingNext: decision.allowed ? "Operator dispatch gate or the autopilot gate." : "Operator policy review.",
      },
    })
    : undefined;
  if (!decision.allowed) {
    return blockedInvocation(invocation, startedAt, decision.reason, decisionRecord, {
      mutates: false,
      localCheckpoint: false,
    });
  }

  // (c) Create a PROPOSED task — never approved. The operator approves on the board.
  const proposeTask = deps.proposeTaskFn ?? defaultProposeTask(env);
  const created = await proposeTask({
    repo,
    agent,
    prompt,
    requester: "hermes",
    riskTier: routing.riskTier,
    routingReason: routing.reason,
    ...(decisionRecord ? { decisionRecord } : {}),
    ...(input.pullRequestNumber ? { pullRequestNumber: input.pullRequestNumber } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  });

  return completedInvocation(
    invocation,
    startedAt,
    {
      kind: "enqueue_agent_task",
      status: "proposed", // proposes-only — this PR never approves or runs a task
      proposedTaskId: created.id ?? null,
      repo,
      agent,
      agentExplicit,
      riskTier: routing.riskTier,
      routingReason: routing.reason,
      ...(decisionRecord ? { decisionRecord } : {}),
      requester: "hermes",
      note: "Task proposed; it lands on the board and awaits operator approval. Never auto-approved or auto-run.",
    },
    { mutates: false, localCheckpoint: false },
  );
}

async function resolveLearnedRouting(
  routingInput: { repo: string; prompt: string; area?: string },
  staticRouting: ReturnType<typeof classifyTask>,
  deps: AgentInvocationDeps,
  env: NodeJS.ProcessEnv,
  loadScorecard?: () => Promise<unknown>
): Promise<ReturnType<typeof classifyTask>> {
  const config = parseLearnedRoutingConfig(env, deps.learnedRoutingConfig);
  if (staticRouting.riskTier === "high") {
    return applyLearnedRouting(routingInput, staticRouting, {
      config,
      now: deps.now,
      ...(deps.routingRandomFn ? { rng: deps.routingRandomFn } : {}),
    });
  }

  try {
    const scorecard = await (loadScorecard ?? (() => getAgentScorecard({ now: deps.now })))();
    return applyLearnedRouting(routingInput, staticRouting, {
      scorecard,
      config,
      now: deps.now,
      ...(deps.routingRandomFn ? { rng: deps.routingRandomFn } : {}),
    });
  } catch {
    return {
      ...staticRouting,
      reason: `A2 scorecard unavailable → static default (${staticRouting.reason})`,
    };
  }
}

interface DispatchCostBudgetSnapshot {
  status: "disabled" | "recorded" | "not_recorded";
  todayCostUsd: number | null;
  estimatedTaskCostUsd: number | null;
}

function disabledCostBudgetSnapshot(): DispatchCostBudgetSnapshot {
  return { status: "disabled", todayCostUsd: null, estimatedTaskCostUsd: null };
}

async function dispatchCostBudgetSnapshot(
  capUsd: number,
  agent: "codex" | "claude",
  today: string,
  loadScorecard: () => Promise<unknown>
): Promise<DispatchCostBudgetSnapshot> {
  if (capUsd <= 0) return disabledCostBudgetSnapshot();
  try {
    const scorecard = await loadScorecard();
    const snapshot = dispatchCostBudgetSnapshotFromScorecard(scorecard, agent, today);
    return snapshot.todayCostUsd !== null && snapshot.estimatedTaskCostUsd !== null
      ? { ...snapshot, status: "recorded" }
      : snapshot;
  } catch {
    return { status: "not_recorded", todayCostUsd: null, estimatedTaskCostUsd: null };
  }
}

function dispatchCostBudgetSnapshotFromScorecard(
  scorecard: unknown,
  agent: "codex" | "claude",
  today: string
): DispatchCostBudgetSnapshot {
  if (!isRecord(scorecard)) return { status: "not_recorded", todayCostUsd: null, estimatedTaskCostUsd: null };
  const llmUsage = isRecord(scorecard.llmUsage) ? scorecard.llmUsage : {};
  const todayRollup = recordsFrom(llmUsage, "byDay").find((entry) => stringField(entry, "day") === today);
  const todayCostUsd = todayRollup && stringField(todayRollup, "costStatus") === "recorded"
    ? numberField(todayRollup, "costUsd") ?? null
    : null;
  const agentRecord = recordsFrom(scorecard, "agents").find((entry) => stringField(entry, "agent") === agent);
  const estimatedTaskCostUsd = estimatedCostForAgent(agentRecord);
  return {
    status: todayCostUsd !== null && estimatedTaskCostUsd !== null ? "recorded" : "not_recorded",
    todayCostUsd,
    estimatedTaskCostUsd,
  };
}

function estimatedCostForAgent(agentRecord: Record<string, unknown> | undefined): number | null {
  if (!agentRecord || !isRecord(agentRecord.cost)) return null;
  const cost = agentRecord.cost;
  if (stringField(cost, "status") !== "recorded") return null;
  const averageUsdPerTask = numberField(cost, "averageUsdPerTask");
  if (averageUsdPerTask !== undefined) return averageUsdPerTask;
  const totalUsd = numberField(cost, "totalUsd");
  const runs = recordsFrom(cost, "byModel").reduce((sum, entry) => sum + (numberField(entry, "runs") ?? 0), 0);
  return totalUsd !== undefined && runs > 0 ? totalUsd / runs : null;
}

// enqueue transport — POST/GET the slack-operator queue endpoint. Injected in
// tests; in prod reads the internal monitor base URL + token from env.
function monitorBase(env: NodeJS.ProcessEnv): string {
  return (env.AVERRAY_MONITOR_BASE_URL?.trim() || "http://slack-operator:8790").replace(/\/+$/, "");
}

function monitorAuthHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.SLACK_OPERATOR_MONITOR_TOKEN?.trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function defaultProposeTask(env: NodeJS.ProcessEnv): (task: ProposedAgentTask) => Promise<{ id?: string }> {
  return async (task) => {
    const res = await fetch(`${monitorBase(env)}/monitor/codex-tasks`, {
      method: "POST",
      headers: { "content-type": "application/json", ...monitorAuthHeaders(env) },
      body: JSON.stringify({ action: "propose", ...task }),
    });
    if (!res.ok) throw new Error(`enqueue_propose_failed:${res.status}`);
    const json = (await res.json().catch(() => ({}))) as { task?: { id?: string } };
    return { id: json.task?.id };
  };
}

function defaultListQueuedTasks(env: NodeJS.ProcessEnv): () => Promise<QueuedTaskSummary[]> {
  return async () => {
    const res = await fetch(`${monitorBase(env)}/monitor/codex-tasks`, { headers: monitorAuthHeaders(env) });
    if (!res.ok) return [];
    const json = (await res.json().catch(() => ({}))) as { items?: QueuedTaskSummary[] };
    return Array.isArray(json.items) ? json.items : [];
  };
}

function completedInvocation(
  invocation: Record<string, unknown>,
  startedAt: Date,
  result: unknown,
  risk: { mutates: boolean; localCheckpoint: boolean }
) {
  return {
    schemaVersion: 1,
    kind: "agent_invocation",
    status: "completed",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    invocation,
    safety: {
      source: "agent",
      wouldMutate: risk.mutates,
      wouldWriteLocalCheckpoint: risk.localCheckpoint,
      freeFormHermesPromptUsed: false,
    },
    result,
  };
}

function blockedInvocation(
  invocation: Record<string, unknown>,
  startedAt: Date,
  reason: string,
  parsed?: unknown,
  risk?: { mutates: boolean; localCheckpoint: boolean }
) {
  return {
    schemaVersion: 1,
    kind: "agent_invocation",
    status: "blocked",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    invocation,
    reason,
    mutates: false,
    safety: {
      source: "agent",
      wouldMutate: risk?.mutates === true,
      wouldWriteLocalCheckpoint: risk?.localCheckpoint === true,
      freeFormHermesPromptUsed: false,
    },
    ...(parsed ? { parsed } : {}),
  };
}

function normalizeTestCaseId(id: string): string {
  return id.trim().toUpperCase();
}

function normalizeTestCaseIds(ids: string[]): string[] {
  return [...new Set(ids.map(normalizeTestCaseId).filter(Boolean))];
}

function prHandoffSafety(wouldMutate: boolean, wouldWriteLocalCheckpoint: boolean) {
  return {
    source: "agent",
    githubMutated: false,
    mergePerformed: false,
    mergeRecommendationOnly: true,
    wouldMutate,
    wouldWriteLocalCheckpoint,
    freeFormHermesPromptUsed: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function recordsFrom(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return arrayField(record, key).filter(isRecord);
}

function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function testFailed(test: unknown): boolean {
  if (!isRecord(test)) return false;
  if (test.status === "blocked") return true;
  const summary = isRecord(test.summary)
    ? test.summary
    : isRecord(test.result) && isRecord(test.result.summary)
      ? test.result.summary
      : undefined;
  return typeof summary?.failed === "number" && summary.failed > 0;
}

async function recordInvocationEvent(
  deps: AgentInvocationDeps,
  input: AgentInvocationInput,
  invocation: Record<string, unknown>,
  correlationId: string,
  event: Pick<HandoffEventInput, "phase" | "status" | "summary" | "safety">
) {
  const recorder = deps.handoffEventRecorder ?? recordHandoffEvent;
  try {
    await recorder({
      correlationId,
      requester: input.requester,
      intent: String(invocation.intent ?? "operator_command"),
      phase: event.phase,
      status: event.status,
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.sha ? { sha: input.sha } : {}),
      ...(input.pullRequestNumber ? { pullRequestNumber: input.pullRequestNumber } : {}),
      ...(input.pullRequestUrl ? { pullRequestUrl: input.pullRequestUrl } : {}),
      ...(input.testCaseId ? { testCaseId: normalizeTestCaseId(input.testCaseId) } : {}),
      ...(Array.isArray(invocation.testCaseIds) ? { testCaseIds: invocation.testCaseIds as string[] } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.safety ? { safety: event.safety } : {}),
    });
  } catch {
    // Monitoring must never change the safety behavior of the invoked task.
  }
}

function localCorrelationId(startedAt: Date, requester: string, intent: string): string {
  const safeRequester = requester.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-") || "unknown";
  return `local-${safeRequester}-${intent}-${startedAt.toISOString().replace(/[^0-9]/g, "")}`;
}
