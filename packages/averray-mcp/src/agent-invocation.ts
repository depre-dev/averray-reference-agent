import type { WorkflowDeps } from "./job-workflows.js";
import {
  parseOperatorCommand,
  type OperatorQueryFn,
  type ParsedOperatorCommand,
} from "./operator-commands.js";
import { getGithubPullRequestReview } from "./operator-github.js";
import { handleOperatorCommandText } from "./operator-handler.js";
import { runTestbedE2eReadOnly } from "./operator-testbed.js";
import {
  recordHandoffEvent,
  summarizeHandoffError,
  summarizeHandoffResult,
  type HandoffEventInput,
} from "./handoff-events.js";

export type AgentInvocationIntent =
  | "operator_command"
  | "testbed_e2e_read_only"
  | "testbed_suite"
  | "testbed_case"
  | "pr_handoff";

export interface AgentInvocationInput {
  requester: string;
  intent?: AgentInvocationIntent;
  command?: string;
  testCaseId?: string;
  testCaseIds?: string[];
  runReadOnlySuite?: boolean;
  postReviewCommand?: string;
  repo?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  correlationId?: string;
  reason?: string;
  allowMutations?: boolean;
  allowLocalCheckpoint?: boolean;
  expectedWallet?: string;
  defaultDryRun?: boolean;
  maxEvidenceUrls?: number;
  confidenceThreshold?: number;
}

export interface AgentInvocationDeps {
  query: OperatorQueryFn;
  workflowDeps: WorkflowDeps;
  githubEnv?: NodeJS.ProcessEnv;
  githubFetchFn?: typeof fetch;
  handoffEventRecorder?: (event: HandoffEventInput) => Promise<unknown>;
  now?: Date;
}

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
    return completedInvocation(invocation, startedAt, {
      schemaVersion: 1,
      kind: "agent_pr_handoff",
      status: "blocked",
      github: review,
      requestedActions,
      tests: [],
      finalVerdict: "hold",
      finalReason: "github_pr_review_unavailable",
      safety: prHandoffSafety(false, false),
    }, { mutates: false, localCheckpoint: false });
  }

  if (review.mergeRecommendation === "hold") {
    return completedInvocation(invocation, startedAt, {
      schemaVersion: 1,
      kind: "agent_pr_handoff",
      status: "completed",
      github: review,
      requestedActions,
      tests: [],
      finalVerdict: "hold",
      finalReason: "pr_review_hold",
      safety: prHandoffSafety(false, false),
    }, { mutates: false, localCheckpoint: false });
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

  return completedInvocation(invocation, startedAt, {
    schemaVersion: 1,
    kind: "agent_pr_handoff",
    status: "completed",
    github: review,
    requestedActions,
    tests,
    finalVerdict,
    finalReason: failedTests > 0 ? "requested_tests_failed_or_blocked" : `github_${review.mergeRecommendation}`,
    safety: prHandoffSafety(wouldMutate, wouldWriteLocalCheckpoint),
  }, { mutates: wouldMutate, localCheckpoint: wouldWriteLocalCheckpoint });
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
