const MAX_MISSION_RUNS = 50;

export type TestbedMissionStatus = "ready" | "running" | "completed" | "failed";

export interface TestbedMissionRun {
  schemaVersion: 1;
  kind: "testbed_mission_run";
  id: string;
  status: TestbedMissionStatus;
  title: string;
  targetUrl: string;
  goal: string;
  agentName: string;
  freshMemory: boolean;
  mission: Record<string, unknown>;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  statusReason: string;
}

export interface ListTestbedMissionRunOptions {
  limit?: number;
  activeOnly?: boolean;
}

const missionRuns: TestbedMissionRun[] = [];
let missionSeq = 0;

export function recordTestbedMissionRunFromOperatorResult(
  result: unknown,
  nowMs: number = Date.now()
): TestbedMissionRun | undefined {
  if (!isRecord(result) || result.kind !== "testbed_agent_mission") return undefined;
  const mission = isRecord(result.mission) ? result.mission : undefined;
  if (!mission || mission.kind !== "testbed_agent_browser_mission") return undefined;
  const target = isRecord(mission.target) ? mission.target : {};
  const createdAt = new Date(nowMs).toISOString();
  const run: TestbedMissionRun = {
    schemaVersion: 1,
    kind: "testbed_mission_run",
    id: nextMissionId(nowMs),
    status: "ready",
    title: "Fresh-agent browser mission",
    targetUrl: stringField(target, "url") ?? "[TESTBED_URL]",
    goal: stringField(target, "goal")
      ?? "Test whether a normal outside agent can understand and use the page.",
    agentName: stringField(target, "agentName") ?? "Hermes",
    freshMemory: target.freshMemory !== false,
    mission,
    createdAt,
    updatedAt: createdAt,
    statusReason: "Mission packet is ready; waiting for a browser-only agent run and structured report.",
  };
  missionRuns.push(run);
  while (missionRuns.length > MAX_MISSION_RUNS) missionRuns.shift();
  return run;
}

export function listTestbedMissionRuns(options: ListTestbedMissionRunOptions = {}): TestbedMissionRun[] {
  const limit = clampInt(options.limit, 1, MAX_MISSION_RUNS, 20);
  const runs = options.activeOnly
    ? missionRuns.filter((run) => run.status === "ready" || run.status === "running")
    : missionRuns.slice();
  return runs
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((run) => ({ ...run, mission: { ...run.mission }, ...(run.result ? { result: { ...run.result } } : {}) }));
}

export function testbedMissionRunToMonitorItem(run: TestbedMissionRun): Record<string, unknown> {
  const active = run.status === "ready" || run.status === "running";
  const terminalStatus = run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "running";
  const verdict = run.status === "completed" ? "pass" : run.status === "failed" ? "failed" : "running";
  return {
    correlationId: run.id,
    requester: "monitor",
    intent: "testbed_agent_mission",
    repo: "testbed/agent",
    status: terminalStatus,
    phase: "testbed_mission",
    active,
    activeState: active ? "running" : "inactive",
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    eventCount: 0,
    reason: run.statusReason,
    summary: {
      kind: "testbed_mission_run",
      title: run.title,
      status: run.status,
      finalReason: run.statusReason,
      finalVerdict: verdict,
      mergeRecommendation: "not_applicable",
      reviewSignals: {
        touchedAreas: ["testbed"],
        testSignals: ["browser mission packet ready"],
        missingTestSignals: run.status === "completed" ? [] : ["browser agent report"],
      },
      reviewReasons: run.status === "failed"
        ? [{ severity: "high", code: "testbed_mission_failed", message: run.statusReason }]
        : [],
      testbedMission: run,
    },
    safety: {
      source: "monitor",
      wouldMutate: false,
      wouldWriteLocalCheckpoint: false,
      freeFormHermesPromptUsed: false,
    },
  };
}

export function __resetTestbedMissionRunsForTests(): void {
  missionRuns.splice(0, missionRuns.length);
  missionSeq = 0;
}

function nextMissionId(nowMs: number): string {
  missionSeq += 1;
  return `testbed-mission-${nowMs.toString(36)}-${missionSeq.toString(36)}`;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
