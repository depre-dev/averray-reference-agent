import { getTestbedAgentMission, type TestbedAgentMissionInput } from "@avg/averray-mcp/operator-testbed";

import {
  listTestbedMissionRuns,
  readTestbedMissionRunnerHeartbeat,
  recordTestbedMissionRunFromOperatorResult,
  summarizeTestbedMissionRunnerHeartbeat,
  type TestbedMissionMode,
  type TestbedMissionRun,
} from "./monitor-testbed-missions.js";

export interface AgentTestbedMissionInput extends TestbedAgentMissionInput {
  requester?: string;
  path?: string;
  /** Select a mission executor instead of the single-URL explore default. */
  mode?: TestbedMissionMode;
  /** T1: routes for a surface sweep (relative to the app base URL, or absolute). */
  routes?: string[];
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

export function createTestbedMissionFromAgent(
  input: AgentTestbedMissionInput = {},
  nowMs: number = Date.now()
): AgentTestbedMissionResult {
  const mission = getTestbedAgentMission(input) as Record<string, unknown>;
  // Carry executor selection onto the mission packet's target so the recorded
  // run picks up `mode` / `routes` (the averray-mcp packet generator is
  // deliberately agnostic to monitor-local executors).
  if (input.mode || (input.routes && input.routes.length > 0)) {
    const target =
      mission.target && typeof mission.target === "object" && !Array.isArray(mission.target)
        ? (mission.target as Record<string, unknown>)
        : {};
    if (input.mode) target.mode = input.mode;
    if (input.routes && input.routes.length > 0) target.routes = input.routes;
    mission.target = target;
  }
  const run = recordTestbedMissionRunFromOperatorResult(
    {
      kind: "testbed_agent_mission",
      mission,
    },
    nowMs,
    input.path
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
    nextStep: runnerReady
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
  return {
    schemaVersion: 1,
    kind: "hermes_testbed_agent_mission",
    runner,
    run,
    mission: run.mission,
    nextStep: nextStepForRun(run, runner),
  };
}

function summarizeMissionCounts(runs: TestbedMissionRun[]) {
  return {
    total: runs.length,
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
  const runnerReady = runner && !runner.stale && runner.status !== "disabled" && runner.status !== "misconfigured";
  return runnerReady
    ? "Mission is ready; Hermes testbed runner should claim it on its next poll."
    : "Mission is ready, but no healthy automatic runner is visible; start the runner or copy the mission prompt for manual execution.";
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
