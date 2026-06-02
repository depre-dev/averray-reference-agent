import { getTestbedAgentMission } from "@avg/averray-mcp/operator-testbed";

import {
  approveTestbedMissionRun,
  listTestbedMissionRuns,
  readTestbedMissionRunnerHeartbeat,
  recordTestbedMissionRunFromOperatorResult,
  summarizeTestbedMissionRunnerHeartbeat,
  testbedMissionRequesterMissionBody,
  type TestbedMissionMode,
  type TestbedMissionRequesterAgent,
  type TestbedMissionRun,
} from "./monitor-testbed-missions.js";
import {
  annotateMissionWithMutationBinding,
  resolveTestbedMutationBinding,
  testbedEnvironmentFromEnv,
  type TestbedMissionEnvironment,
} from "./testbed-mutation-binding.js";

export interface AgentTestbedMissionInput {
  targetUrl?: string;
  goal?: string;
  agentName?: string;
  freshMemory?: boolean;
  allowTestMutations?: boolean;
  maxBrowserSteps?: number;
  maxMinutes?: number;
  requester?: string;
  path?: string;
  /** Explicit environment binding; absent ⇒ infer from URL / runner env. */
  environment?: TestbedMissionEnvironment | string;
  /** Select a mission executor instead of the single-URL explore default. */
  mode?: TestbedMissionMode;
  /** T1: routes for a surface sweep (relative to the app base URL, or absolute). */
  routes?: string[];
  /** citation_repair: the Wikipedia job to repair; absent ⇒ workflow auto-selects. */
  jobId?: string;
  /** When true, create the mission as `requested` (operator must approve before a
   *  runner can claim it) rather than auto-`ready`. Used for external agent
   *  requests; operator-scheduled gold-path runs rely on the spend/safety budget
   *  instead of per-run approval. */
  requireApproval?: boolean;
}

export interface MonitorTestbedMissionPostInput {
  targetUrl?: unknown;
  goal?: unknown;
  agentName?: unknown;
  requester?: unknown;
  environment?: unknown;
  freshMemory?: unknown;
  allowTestMutations?: unknown;
  maxBrowserSteps?: unknown;
  maxMinutes?: unknown;
  mode?: unknown;
  initialStatus?: unknown;
  routes?: unknown;
  jobId?: unknown;
  path?: string;
}

export type AgentRequestedTestbedMissionMode = "fresh" | "memory";

export interface AgentRequestedTestbedMissionInput {
  requesterAgent?: unknown;
  targetUrl?: unknown;
  goal?: unknown;
  reason?: unknown;
  mode?: unknown;
  path?: string;
}

export interface AgentTestbedMissionListInput {
  limit?: number;
  activeOnly?: boolean;
  path?: string;
}

export interface AgentTestbedMissionGetInput {
  path?: string;
}

export interface AgentTestbedMissionResult {
  schemaVersion: 1;
  kind: "hermes_testbed_agent_entrypoint";
  requester: string;
  run: TestbedMissionRun;
  mission: Record<string, unknown>;
  runner: ReturnType<typeof summarizeTestbedMissionRunnerHeartbeat>;
  statusUrlHint: string;
  nextStep: string;
}

export class TestbedMissionRequestValidationError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "TestbedMissionRequestValidationError";
  }
}

export function createTestbedMissionFromAgent(
  input: AgentTestbedMissionInput = {},
  nowMs: number = Date.now()
): AgentTestbedMissionResult {
  // Only callers that explicitly ask for the external-request gate land
  // `requested`; internal/operator missions can be claimed by the runner and
  // guarded by their own budget/preflight rules.
  const initialStatus = input.requireApproval ? "requested" : "ready";
  return createTestbedMissionRecord(input, nowMs, { initialStatus });
}

export function createMonitorTestbedMissionFromPayload(
  input: MonitorTestbedMissionPostInput,
  nowMs: number = Date.now()
): AgentTestbedMissionResult {
  const mode = parseMonitorMissionMode(input.mode);
  const jobId = cleanString(input.jobId);
  // citation_repair selects a Wikipedia job (by jobId or auto), so it has no
  // page URL to test up front; default to the Wikipedia base when none is given.
  const targetUrl = mode === "citation_repair" && !cleanString(input.targetUrl)
    ? "https://en.wikipedia.org/"
    : parseHttpUrl(input.targetUrl);
  const initialStatus = cleanString(input.initialStatus);
  const missionInput: AgentTestbedMissionInput = {
    targetUrl,
    ...(jobId ? { jobId } : {}),
    ...(cleanString(input.goal) ? { goal: cleanString(input.goal) } : {}),
    ...(cleanString(input.agentName) ? { agentName: cleanString(input.agentName) } : {}),
    ...(cleanString(input.requester) ? { requester: cleanString(input.requester) } : {}),
    ...(cleanString(input.environment) ? { environment: cleanString(input.environment) } : {}),
    ...(parseOptionalBoolean(input.freshMemory) !== undefined ? { freshMemory: parseOptionalBoolean(input.freshMemory) } : {}),
    ...(parseOptionalNumber(input.maxBrowserSteps) !== undefined ? { maxBrowserSteps: parseOptionalNumber(input.maxBrowserSteps) } : {}),
    ...(parseOptionalNumber(input.maxMinutes) !== undefined ? { maxMinutes: parseOptionalNumber(input.maxMinutes) } : {}),
    ...(mode ? { mode } : {}),
    ...(parseStringArray(input.routes).length > 0 ? { routes: parseStringArray(input.routes) } : {}),
    ...(initialStatus === "requested" ? { requireApproval: true } : {}),
    ...(input.path ? { path: input.path } : {}),
    allowTestMutations: mode === "gold_path",
  };
  // Deliberately ignore input.allowTestMutations. The monitor board launcher
  // never sends it; if a client forges it, mutation posture is still derived
  // server-side from the target, mode, and configured environment.
  return createTestbedMissionFromAgent(missionInput, nowMs);
}

export function requestTestbedMissionFromAgent(
  input: AgentRequestedTestbedMissionInput,
  nowMs: number = Date.now()
): AgentTestbedMissionResult {
  const request = parseAgentRequestedTestbedMission(input);
  const missionInput: AgentTestbedMissionInput = {
    requester: request.requesterAgent,
    targetUrl: request.targetUrl,
    goal: request.goal,
    freshMemory: request.mode === "fresh",
    allowTestMutations: false,
  };
  if (input.path) missionInput.path = input.path;
  return createTestbedMissionRecord(
    missionInput,
    nowMs,
    {
      initialStatus: "requested",
      requesterAgent: request.requesterAgent,
      requestReason: request.reason,
    }
  );
}

export function approveRequestedTestbedMission(
  id: string,
  input: { path?: string; approvedBy?: string; now?: Date } = {}
) {
  return approveTestbedMissionRun(id, input);
}

function createTestbedMissionRecord(
  input: AgentTestbedMissionInput,
  nowMs: number,
  options: {
    initialStatus: "ready" | "requested";
    requesterAgent?: TestbedMissionRequesterAgent;
    requestReason?: string;
  }
): AgentTestbedMissionResult {
  const binding = resolveTestbedMutationBinding({
    targetUrl: input.targetUrl,
    mode: input.mode,
    requestedAllowTestMutations: input.allowTestMutations === true,
    configuredEnvironment: input.environment ?? testbedEnvironmentFromEnv(),
  });
  const mission = annotateMissionWithMutationBinding(
    getTestbedAgentMission({ ...input, allowTestMutations: binding.allowTestMutations }) as Record<string, unknown>,
    binding
  );
  // Carry executor selection onto the mission packet's target so the recorded
  // run picks up `mode` / `routes` (the averray-mcp packet generator is
  // deliberately agnostic to monitor-local executors).
  if (input.mode || (input.routes && input.routes.length > 0) || input.jobId) {
    const target =
      mission.target && typeof mission.target === "object" && !Array.isArray(mission.target)
        ? (mission.target as Record<string, unknown>)
        : {};
    if (input.mode) target.mode = input.mode;
    if (input.routes && input.routes.length > 0) target.routes = input.routes;
    if (input.jobId) target.jobId = input.jobId;
    mission.target = target;
  }
  const run = recordTestbedMissionRunFromOperatorResult(
    {
      kind: "testbed_agent_mission",
      mission,
    },
    nowMs,
    input.path,
    options
  );
  if (!run) {
    throw new Error("Hermes testbed mission could not be recorded.");
  }

  const runner = summarizeTestbedMissionRunnerHeartbeat(readTestbedMissionRunnerHeartbeat({ path: input.path }));
  const runnerReady = runner && !runner.stale && runner.status !== "disabled" && runner.status !== "misconfigured";
  return {
    schemaVersion: 1,
    kind: "hermes_testbed_agent_entrypoint",
    requester: cleanString(input.requester) ?? "agent",
    run,
    mission,
    runner,
    statusUrlHint: `/monitor/testbed-missions?limit=20`,
    nextStep: run.status === "requested"
      ? "Tester run request is board-gated; the operator must approve it before the Hermes testbed runner can claim it."
      : runnerReady
        ? "Hermes testbed runner can claim this mission; poll /monitor/testbed-missions or watch the board for the structured report."
        : "Mission is queued, but no healthy automatic runner is visible; use the mission prompt manually or start the testbed runner.",
  };
}

export function listTestbedMissionsForAgent(input: AgentTestbedMissionListInput = {}) {
  const runner = summarizeTestbedMissionRunnerHeartbeat(readTestbedMissionRunnerHeartbeat({ path: input.path }));
  return {
    schemaVersion: 1,
    kind: "hermes_testbed_agent_mission_list",
    runner,
    counts: summarizeMissionCounts(listTestbedMissionRuns({ limit: 50, path: input.path })),
    items: listTestbedMissionRuns(input),
  };
}

export function getTestbedMissionForAgent(id: string, input: AgentTestbedMissionGetInput = {}) {
  const runner = summarizeTestbedMissionRunnerHeartbeat(readTestbedMissionRunnerHeartbeat({ path: input.path }));
  const run = listTestbedMissionRuns({ limit: 50, path: input.path })
    .find((candidate) => candidate.id === id);
  if (!run) return undefined;
  const report = run.status === "completed" || run.status === "failed"
    ? testbedMissionRequesterMissionBody(run)
    : undefined;
  if (!report) {
    return {
      schemaVersion: 1,
      kind: "hermes_testbed_agent_mission_report",
      id: run.id,
      status: run.status,
      updatedAt: run.updatedAt,
      runner,
      nextStep: nextStepForRun(run, runner),
    };
  }
  return {
    schemaVersion: 1,
    kind: "hermes_testbed_agent_mission_report",
    id: run.id,
    status: run.status,
    title: run.title,
    targetUrl: run.targetUrl,
    goal: run.goal,
    ...(run.requesterAgent ? { requesterAgent: run.requesterAgent } : {}),
    ...(run.requestReason ? { requestReason: run.requestReason } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.requestedAt ? { requestedAt: run.requestedAt } : {}),
    ...(run.approvedAt ? { approvedAt: run.approvedAt } : {}),
    ...(run.claimedAt ? { claimedAt: run.claimedAt } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.failedAt ? { failedAt: run.failedAt } : {}),
    runner,
    report,
    nextStep: nextStepForRun(run, runner),
  };
}

function summarizeMissionCounts(runs: TestbedMissionRun[]) {
  return {
    total: runs.length,
    requested: runs.filter((run) => run.status === "requested").length,
    ready: runs.filter((run) => run.status === "ready").length,
    running: runs.filter((run) => run.status === "running").length,
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed").length,
  };
}

function nextStepForRun(
  run: TestbedMissionRun,
  runner: ReturnType<typeof summarizeTestbedMissionRunnerHeartbeat>
): string {
  if (run.status === "completed") {
    return "Mission completed; inspect result, evidence, and recommendations before deciding the product follow-up.";
  }
  if (run.status === "failed") {
    return "Mission failed; inspect failureReason/stdoutTail/stderrTail, then fix the runner setup or queue a smaller mission.";
  }
  if (run.status === "running") {
    return "Hermes testbed runner is working; poll this mission until it records a structured report or failure.";
  }
  if (run.status === "requested") {
    return "Tester run request is waiting for operator approval; the runner will ignore it until it moves to ready.";
  }
  const runnerReady = runner && !runner.stale && runner.status !== "disabled" && runner.status !== "misconfigured";
  return runnerReady
    ? "Mission is ready; Hermes testbed runner should claim it on its next poll."
    : "Mission is ready, but no healthy automatic runner is visible; start the runner or copy the mission prompt for manual execution.";
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function parseMonitorMissionMode(value: unknown): TestbedMissionMode | undefined {
  const mode = cleanString(value);
  if (mode === "surface_sweep" || mode === "siwe_auth" || mode === "gold_path" || mode === "citation_repair") return mode;
  return undefined;
}

function parseAgentRequestedTestbedMission(input: AgentRequestedTestbedMissionInput): {
  requesterAgent: TestbedMissionRequesterAgent;
  targetUrl: string;
  goal: string;
  reason: string;
  mode: AgentRequestedTestbedMissionMode;
} {
  const requesterAgent = parseRequesterAgent(input.requesterAgent);
  const targetUrl = parseHttpUrl(input.targetUrl);
  const goal = cleanString(input.goal);
  if (!goal) {
    throw new TestbedMissionRequestValidationError("missing_goal", "goal is required for an agent-requested tester run.");
  }
  const reason = cleanString(input.reason) ?? "Agent requested a board-gated tester run.";
  const mode = parseRequestMode(input.mode);
  return { requesterAgent, targetUrl, goal, reason, mode };
}

function parseRequesterAgent(value: unknown): TestbedMissionRequesterAgent {
  const agent = cleanString(value);
  if (agent === "codex" || agent === "claude" || agent === "test-writer" || agent === "security" || agent === "docs" || agent === "hermes" || agent === "operator") return agent;
  throw new TestbedMissionRequestValidationError(
    "invalid_requester_agent",
    "requesterAgent must be one of codex, claude, test-writer, security, docs, hermes, or operator."
  );
}

function parseRequestMode(value: unknown): AgentRequestedTestbedMissionMode {
  const mode = cleanString(value) ?? "fresh";
  if (mode === "fresh" || mode === "memory") return mode;
  throw new TestbedMissionRequestValidationError("invalid_mode", "mode must be fresh or memory.");
}

function parseHttpUrl(value: unknown): string {
  const raw = cleanString(value);
  if (!raw) {
    throw new TestbedMissionRequestValidationError("missing_target_url", "targetUrl is required.");
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    // fall through to the validation error below
  }
  throw new TestbedMissionRequestValidationError("invalid_target_url", "targetUrl must be a valid http or https URL.");
}
