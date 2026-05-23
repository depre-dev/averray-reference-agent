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

export interface MissionReportInput {
  relatedCorrelationId?: string;
  text?: string;
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

export function recordTestbedMissionReportFromMessage(
  input: MissionReportInput,
  nowMs: number = Date.now()
): TestbedMissionRun | undefined {
  const report = parseMissionReport(input.text ?? "");
  if (!report) return undefined;
  const missionId = missionIdFromReportInput(input, report);
  const run = missionId
    ? missionRuns.find((candidate) => candidate.id === missionId)
    : onlyActiveMissionRun();
  if (!run) return undefined;

  const verdict = normalizeVerdict(report.verdict);
  const stoppedBeforeMutation = report.stoppedBeforeMutation !== false;
  const completed = verdict === "pass" && stoppedBeforeMutation;
  const failed = !verdict || verdict === "fail" || verdict === "partial" || !stoppedBeforeMutation;
  const status: TestbedMissionStatus = completed ? "completed" : failed ? "failed" : "completed";
  const updatedAt = new Date(nowMs).toISOString();
  run.result = {
    ...report,
    ingestedAt: updatedAt,
  };
  run.status = status;
  run.updatedAt = updatedAt;
  run.statusReason = missionReportStatusReason(report, status, stoppedBeforeMutation);
  return cloneRun(run);
}

export function testbedMissionRunToMonitorItem(run: TestbedMissionRun): Record<string, unknown> {
  const active = run.status === "ready" || run.status === "running";
  const terminalStatus = run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "running";
  const verdict = run.status === "completed" ? "pass" : run.status === "failed" ? "failed" : "running";
  const reportAttached = Boolean(run.result);
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
        testSignals: [
          "browser mission packet ready",
          ...(reportAttached ? ["browser agent report attached"] : []),
        ],
        missingTestSignals: reportAttached ? [] : ["browser agent report"],
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

function onlyActiveMissionRun(): TestbedMissionRun | undefined {
  const activeRuns = missionRuns
    .filter((run) => run.status === "ready" || run.status === "running")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return activeRuns.length === 1 ? activeRuns[0] : undefined;
}

function cloneRun(run: TestbedMissionRun): TestbedMissionRun {
  return {
    ...run,
    mission: { ...run.mission },
    ...(run.result ? { result: { ...run.result } } : {}),
  };
}

function missionIdFromReportInput(
  input: MissionReportInput,
  report: Record<string, unknown>
): string | undefined {
  const related = input.relatedCorrelationId?.trim();
  if (related && related.startsWith("testbed-mission-")) return related;
  const reportMissionId = stringField(report, "missionId");
  if (reportMissionId && reportMissionId.startsWith("testbed-mission-")) return reportMissionId;
  const textMissionId = input.text?.match(/\b(testbed-mission-[A-Za-z0-9-]+)\b/)?.[1];
  return textMissionId;
}

function parseMissionReport(text: string): Record<string, unknown> | undefined {
  const normalized = text.trim();
  if (!normalized) return undefined;
  const jsonText = extractJsonObject(normalized);
  if (!jsonText) return undefined;
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (parsed.kind === "testbed_mission_report" && isRecord(parsed.report)) {
      return parsed.report;
    }
    if (isRecord(parsed.testbedMissionReport)) {
      return parsed.testbedMissionReport;
    }
    if (isRecord(parsed.report) && looksLikeMissionReport(parsed.report)) {
      return parsed.report;
    }
    return looksLikeMissionReport(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced ? fenced[1]?.trim() ?? "" : text;
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first < 0 || last <= first) return undefined;
  return source.slice(first, last + 1);
}

function looksLikeMissionReport(value: Record<string, unknown>): boolean {
  if (normalizeVerdict(value.verdict)) return true;
  if (Array.isArray(value.completedPath) || Array.isArray(value.blockers) || isRecord(value.scores)) return true;
  return false;
}

function normalizeVerdict(value: unknown): "pass" | "partial" | "fail" | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "passed" || normalized === "success" || normalized === "ok") return "pass";
  if (normalized === "partial" || normalized === "mixed") return "partial";
  if (normalized === "failed" || normalized === "failure" || normalized === "blocked") return "fail";
  if (normalized === "pass" || normalized === "fail") return normalized;
  return undefined;
}

function missionReportStatusReason(
  report: Record<string, unknown>,
  status: TestbedMissionStatus,
  stoppedBeforeMutation: boolean
): string {
  const verdict = normalizeVerdict(report.verdict) ?? "reported";
  const blockers = Array.isArray(report.blockers)
    ? report.blockers.map(String).filter(Boolean)
    : [];
  if (!stoppedBeforeMutation) {
    return "Browser-agent report says the mission crossed or attempted a mutation boundary.";
  }
  if (status === "completed") {
    return "Browser-agent report passed; Hermes has structured evidence for this testbed mission.";
  }
  if (blockers.length > 0) {
    return `Browser-agent report returned ${verdict}; blocker: ${blockers[0]}`;
  }
  if (!normalizeVerdict(report.verdict)) {
    return "Browser-agent report was attached but did not include a clear verdict; inspect it before Hermes can close the mission.";
  }
  return `Browser-agent report returned ${verdict}; inspect the attached evidence before changing the page or mission prompt.`;
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
