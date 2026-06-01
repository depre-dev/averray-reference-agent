import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  annotateMissionWithMutationBinding,
  resolveTestbedMutationBinding,
  testbedEnvironmentFromEnv,
  type TestbedMissionEnvironment,
  type TestbedMissionMutationMode,
} from "./testbed-mutation-binding.js";

const MAX_MISSION_RUNS = 50;

export type TestbedMissionStatus = "requested" | "ready" | "running" | "completed" | "failed";
export type TestbedMissionVerdict = "pass" | "partial" | "fail";
export type TestbedMissionMode = "explore" | "surface_sweep" | "siwe_auth" | "gold_path";
export type TestbedMissionRequesterAgent = "codex" | "claude" | "test-writer" | "hermes" | "operator";
export type TestbedMissionRunnerHeartbeatStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "disabled"
  | "misconfigured"
  | "error";

export interface TestbedMissionHistoryEntry {
  at: string;
  status: TestbedMissionStatus;
  event: string;
  message: string;
}

export interface TestbedMissionRun {
  schemaVersion: 1;
  kind: "testbed_mission_run";
  id: string;
  status: TestbedMissionStatus;
  title: string;
  targetUrl: string;
  goal: string;
  agentName: string;
  requesterAgent?: TestbedMissionRequesterAgent;
  requestReason?: string;
  freshMemory: boolean;
  allowTestMutations: boolean;
  requestedAllowTestMutations?: boolean;
  environment?: TestbedMissionEnvironment;
  mutationMode?: TestbedMissionMutationMode;
  mutationScope?: string;
  mutationBindingReason?: string;
  /** Mission shape. "explore" (default) is the single-URL heuristic;
   *  "surface_sweep" (T1) walks routes read-only; "siwe_auth" (T3)
   *  verifies signer-sidecar role sessions and auth guards. */
  mode?: TestbedMissionMode;
  /** Routes for a surface_sweep (relative to the app base URL, or absolute).
   *  Empty/absent ⇒ the default public surface list. */
  routes?: string[];
  mission: Record<string, unknown>;
  result?: Record<string, unknown>;
  history: TestbedMissionHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  requestedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  statusReason: string;
  runnerId?: string;
  claimedAt?: string;
  completedAt?: string;
  failedAt?: string;
  failureReason?: string;
  stdoutTail?: string;
  stderrTail?: string;
  progressMessage?: string;
  progressAt?: string;
}

export interface ListTestbedMissionRunOptions {
  limit?: number;
  activeOnly?: boolean;
  path?: string;
}

export interface SelfHealingTestbedMissionFilterOptions {
  now?: Date;
  maxAgeHours?: number;
}

export interface MissionReportInput {
  relatedCorrelationId?: string;
  text?: string;
  path?: string;
}

export interface MissionReportDiagnosis {
  candidate: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  missionId?: string;
  report?: Record<string, unknown>;
}

export interface TestbedMissionStructuredReport {
  verdict: TestbedMissionVerdict;
  confidence: number;
  scores: Record<string, number>;
  blockers: string[];
  confusingMoments: string[];
  mutationBoundaryNotes: string[];
  stoppedBeforeMutation: boolean;
  mutationMode: string;
  mutationsAttempted: string[];
  completedPath: string[];
  recommendations: string[];
  evidence: string[];
  summary: string;
}

export interface TestbedMissionBaselineComparison {
  baselineRunId: string;
  baselineCompletedAt?: string;
  verdictChanged: boolean;
  blockerChanged: boolean;
  scoreDeltas: Record<string, number>;
  summary: string;
}

export interface TestbedMissionFixBrief {
  primaryBlocker: string;
  suspectedUxGap: string;
  smallestProductMove: string;
  rerunProof: string;
  evidence: string[];
}

export interface TestbedMissionStoreDeps {
  path?: string;
  now?: Date;
}

export interface RecordTestbedMissionRunOptions {
  initialStatus?: "ready" | "requested";
  requesterAgent?: TestbedMissionRequesterAgent;
  requestReason?: string;
}

export type ApproveTestbedMissionRunResult =
  | { ok: true; run: TestbedMissionRun }
  | { ok: false; error: "not_found" | "not_requested"; run?: TestbedMissionRun };

export interface TestbedMissionRunnerHeartbeat {
  schemaVersion: 1;
  kind: "testbed_mission_runner_heartbeat";
  runnerId: string;
  status: TestbedMissionRunnerHeartbeatStatus;
  message: string;
  updatedAt: string;
  activeMissionId?: string;
}

const missionRuns: TestbedMissionRun[] = [];
let missionSeq = 0;
let loadedMissionStorePath: string | undefined;

export function recordTestbedMissionRunFromOperatorResult(
  result: unknown,
  nowMs: number = Date.now(),
  path?: string,
  options: RecordTestbedMissionRunOptions = {}
): TestbedMissionRun | undefined {
  ensureMissionStoreLoaded(path, { force: true });
  if (!isRecord(result) || result.kind !== "testbed_agent_mission") return undefined;
  const rawMission = isRecord(result.mission) ? result.mission : undefined;
  if (!rawMission || rawMission.kind !== "testbed_agent_browser_mission") return undefined;
  const target = isRecord(rawMission.target) ? rawMission.target : {};
  const safety = isRecord(rawMission.safety) ? rawMission.safety : {};
  const createdAt = new Date(nowMs).toISOString();
  const mode = parseTestbedMissionMode(stringField(target, "mode"));
  const binding = resolveTestbedMutationBinding({
    targetUrl: stringField(target, "url"),
    mode,
    requestedAllowTestMutations:
      safety.requestedBrowserMissionShouldMutate === true
      || safety.browserMissionShouldMutate === true,
    configuredEnvironment:
      stringField(target, "environment")
      ?? stringField(safety, "mutationEnvironment")
      ?? testbedEnvironmentFromEnv(),
  });
  const mission = annotateMissionWithMutationBinding(rawMission, binding);
  const routes = Array.isArray(target.routes) ? stringArray(target.routes) : [];
  const initialStatus = options.initialStatus ?? "ready";
  const run: TestbedMissionRun = {
    schemaVersion: 1,
    kind: "testbed_mission_run",
    id: nextMissionId(nowMs),
    status: initialStatus,
    title: initialStatus === "requested" ? "Tester run requested" : testbedMissionTitle(mode),
    targetUrl: stringField(target, "url") ?? "[TESTBED_URL]",
    goal: stringField(target, "goal")
      ?? "Test whether a normal outside agent can understand and use the page.",
    agentName: stringField(target, "agentName") ?? "Hermes",
    ...(options.requesterAgent ? { requesterAgent: options.requesterAgent } : {}),
    ...(options.requestReason ? { requestReason: options.requestReason } : {}),
    freshMemory: target.freshMemory !== false,
    allowTestMutations: binding.allowTestMutations,
    requestedAllowTestMutations: binding.requestedAllowTestMutations,
    environment: binding.environment,
    mutationMode: binding.mutationMode,
    mutationScope: binding.mutationScope,
    mutationBindingReason: binding.reason,
    ...(mode ? { mode } : {}),
    ...(routes.length > 0 ? { routes } : {}),
    mission,
    history: [
      {
        at: createdAt,
        status: initialStatus,
        event: initialStatus === "requested" ? "mission_requested" : "mission_packet_ready",
        message: initialStatus === "requested"
          ? testbedMissionRequestedMessage(options.requesterAgent, options.requestReason)
          : testbedMissionReadyMessage(mode, binding),
      },
    ],
    createdAt,
    updatedAt: createdAt,
    ...(initialStatus === "requested" ? { requestedAt: createdAt } : {}),
    statusReason: initialStatus === "requested"
      ? testbedMissionRequestedReason(options.requesterAgent, options.requestReason)
      : testbedMissionReadyReason(mode, binding),
  };
  missionRuns.push(run);
  while (missionRuns.length > MAX_MISSION_RUNS) missionRuns.shift();
  persistMissionStore(path);
  return run;
}

export function listTestbedMissionRuns(options: ListTestbedMissionRunOptions = {}): TestbedMissionRun[] {
  ensureMissionStoreLoaded(options.path, { force: true });
  const limit = clampInt(options.limit, 1, MAX_MISSION_RUNS, 20);
  const runs = options.activeOnly
    ? missionRuns.filter((run) => run.status === "requested" || run.status === "ready" || run.status === "running")
    : missionRuns.slice();
  return runs
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit)
    .map((run) => cloneRun(run));
}

export function failedTestbedMissionsForSelfHealing(
  runs: readonly TestbedMissionRun[],
  options: SelfHealingTestbedMissionFilterOptions = {},
): TestbedMissionRun[] {
  const nowMs = (options.now ?? new Date()).getTime();
  const maxAgeHours = Math.max(1, options.maxAgeHours ?? 72);
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const latestBySurface = new Map<string, TestbedMissionRun>();

  for (const run of runs) {
    const key = missionSelfHealingSurfaceKey(run);
    const current = latestBySurface.get(key);
    if (!current || missionUpdatedMs(run) > missionUpdatedMs(current)) {
      latestBySurface.set(key, run);
    }
  }

  return Array.from(latestBySurface.values())
    .filter((run) => run.status === "failed")
    .filter((run) => {
      const failedMs = missionFailedMs(run);
      return Number.isFinite(failedMs) && nowMs - failedMs <= maxAgeMs;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((run) => cloneRun(run));
}

export function approveTestbedMissionRun(
  id: string,
  deps: TestbedMissionStoreDeps & { approvedBy?: string } = {}
): ApproveTestbedMissionRunResult {
  ensureMissionStoreLoaded(deps.path, { force: true });
  const existing = missionRuns.find((run) => run.id === id);
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.status !== "requested") {
    return { ok: false, error: "not_requested", run: cloneRun(existing) };
  }
  const now = (deps.now ?? new Date()).toISOString();
  existing.status = "ready";
  existing.title = testbedMissionTitle(existing.mode);
  existing.approvedAt = now;
  existing.approvedBy = deps.approvedBy ?? "operator";
  existing.updatedAt = now;
  existing.statusReason = testbedMissionReadyReasonForRun(existing);
  existing.history.push({
    at: now,
    status: "ready",
    event: "mission_approved",
    message: `Operator approved the requested tester run; ${existing.statusReason}`,
  });
  trimMissionHistory(existing);
  persistMissionStore(deps.path);
  return { ok: true, run: cloneRun(existing) };
}

export function recordTestbedMissionReportFromMessage(
  input: MissionReportInput,
  nowMs: number = Date.now()
): TestbedMissionRun | undefined {
  ensureMissionStoreLoaded(input.path, { force: true });
  const diagnosis = diagnoseTestbedMissionReportFromMessage(input);
  if (!diagnosis.valid || !diagnosis.report) return undefined;
  const report = diagnosis.report;
  const missionId = diagnosis.missionId;
  const run = missionId
    ? missionRuns.find((candidate) => candidate.id === missionId)
    : onlyActiveMissionRun();
  if (!run) return undefined;

  const structuredReport = normalizeTestbedMissionStructuredReport(report, run);
  const verdict = structuredReport?.verdict;
  const stoppedBeforeMutation = structuredReport?.stoppedBeforeMutation ?? report.stoppedBeforeMutation !== false;
  const mutationBoundaryOk = stoppedBeforeMutation || run.allowTestMutations;
  const completed = verdict === "pass" && mutationBoundaryOk;
  const failed = !verdict || verdict === "fail" || verdict === "partial" || !mutationBoundaryOk;
  const status: TestbedMissionStatus = completed ? "completed" : failed ? "failed" : "completed";
  const updatedAt = new Date(nowMs).toISOString();
  const baselineComparison = structuredReport ? compareToPreviousMissionBaseline(run, structuredReport) : undefined;
  run.result = {
    ...report,
    ...(structuredReport ? { structuredReport } : {}),
    ...(baselineComparison ? { baselineComparison } : {}),
    ingestedAt: updatedAt,
  };
  run.status = status;
  if (status === "completed") run.completedAt = updatedAt;
  if (status === "failed") run.failedAt = updatedAt;
  run.updatedAt = updatedAt;
  run.statusReason = missionReportStatusReason(run.result, status, stoppedBeforeMutation, run.allowTestMutations);
  run.history.push({
    at: updatedAt,
    status,
    event: status === "completed" ? "mission_report_passed" : "mission_report_needs_fix",
    message: run.statusReason,
  });
  persistMissionStore(input.path);
  return cloneRun(run);
}

export function claimNextReadyTestbedMission(
  deps: TestbedMissionStoreDeps & { runnerId?: string } = {}
): TestbedMissionRun | undefined {
  ensureMissionStoreLoaded(deps.path, { force: true });
  const existing = missionRuns
    .filter((run) => run.status === "ready")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
  if (!existing) return undefined;
  const now = (deps.now ?? new Date()).toISOString();
  existing.status = "running";
  existing.runnerId = deps.runnerId ?? existing.runnerId ?? "testbed-mission-runner";
  existing.claimedAt = now;
  existing.progressAt = now;
  existing.progressMessage = "Hermes testbed runner claimed the browser mission.";
  existing.statusReason = `Hermes testbed runner ${existing.runnerId} claimed the mission and is running the browser test.`;
  existing.updatedAt = now;
  existing.history.push({
    at: now,
    status: "running",
    event: "mission_runner_claimed",
    message: existing.statusReason,
  });
  trimMissionHistory(existing);
  persistMissionStore(deps.path);
  return cloneRun(existing);
}

export function updateTestbedMissionProgress(
  id: string,
  deps: TestbedMissionStoreDeps & {
    progressMessage?: string;
    stdoutTail?: string;
    stderrTail?: string;
  } = {}
): TestbedMissionRun | undefined {
  ensureMissionStoreLoaded(deps.path, { force: true });
  const existing = missionRuns.find((run) => run.id === id);
  if (!existing) return undefined;
  if (existing.status === "completed" || existing.status === "failed") return cloneRun(existing);
  const now = (deps.now ?? new Date()).toISOString();
  existing.status = "running";
  existing.progressAt = now;
  existing.progressMessage = deps.progressMessage ?? existing.progressMessage ?? "Hermes testbed runner is still working.";
  existing.updatedAt = now;
  if (deps.stdoutTail) existing.stdoutTail = deps.stdoutTail;
  if (deps.stderrTail) existing.stderrTail = deps.stderrTail;
  existing.history.push({
    at: now,
    status: "running",
    event: "mission_runner_progress",
    message: existing.progressMessage,
  });
  trimMissionHistory(existing);
  persistMissionStore(deps.path);
  return cloneRun(existing);
}

export function failTestbedMissionRun(
  id: string,
  deps: TestbedMissionStoreDeps & {
    failureReason?: string;
    stdoutTail?: string;
    stderrTail?: string;
  } = {}
): TestbedMissionRun | undefined {
  ensureMissionStoreLoaded(deps.path, { force: true });
  const existing = missionRuns.find((run) => run.id === id);
  if (!existing) return undefined;
  if (existing.status === "completed" || existing.status === "failed") return cloneRun(existing);
  const now = (deps.now ?? new Date()).toISOString();
  const reason = deps.failureReason ?? "Hermes testbed runner failed before it produced a valid report.";
  existing.status = "failed";
  existing.failedAt = now;
  existing.failureReason = reason;
  existing.statusReason = reason;
  existing.progressAt = now;
  existing.progressMessage = reason;
  existing.updatedAt = now;
  if (deps.stdoutTail) existing.stdoutTail = deps.stdoutTail;
  if (deps.stderrTail) existing.stderrTail = deps.stderrTail;
  existing.result = {
    verdict: "fail",
    confidence: 0,
    stoppedBeforeMutation: true,
    blockers: [reason],
    evidence: [
      deps.stderrTail ? `stderr: ${deps.stderrTail}` : "",
      deps.stdoutTail ? `stdout: ${deps.stdoutTail}` : "",
    ].filter(Boolean),
    scores: {},
    ingestedAt: now,
  };
  existing.history.push({
    at: now,
    status: "failed",
    event: "mission_runner_failed",
    message: reason,
  });
  trimMissionHistory(existing);
  persistMissionStore(deps.path);
  return cloneRun(existing);
}

export function readTestbedMissionRunnerHeartbeat(
  deps: TestbedMissionStoreDeps = {}
): TestbedMissionRunnerHeartbeat | undefined {
  const path = missionRunnerHeartbeatPath(deps.path);
  if (!path) return undefined;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isTestbedMissionRunnerHeartbeat(value) ? value : undefined;
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export function updateTestbedMissionRunnerHeartbeat(
  deps: TestbedMissionStoreDeps & {
    runnerId: string;
    status: TestbedMissionRunnerHeartbeatStatus;
    message?: string;
    activeMissionId?: string;
  }
): TestbedMissionRunnerHeartbeat {
  const path = missionRunnerHeartbeatPath(deps.path);
  const now = (deps.now ?? new Date()).toISOString();
  const heartbeat: TestbedMissionRunnerHeartbeat = {
    schemaVersion: 1,
    kind: "testbed_mission_runner_heartbeat",
    runnerId: deps.runnerId,
    status: deps.status,
    message: deps.message ?? testbedMissionRunnerStatusMessage(deps.status),
    updatedAt: now,
    ...(deps.activeMissionId ? { activeMissionId: deps.activeMissionId } : {}),
  };
  if (path) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(heartbeat, null, 2)}\n`);
  }
  return heartbeat;
}

export function summarizeTestbedMissionRunnerHeartbeat(
  heartbeat: TestbedMissionRunnerHeartbeat | undefined,
  now: Date = new Date()
): Record<string, unknown> | undefined {
  if (!heartbeat) return undefined;
  const updatedMs = Date.parse(heartbeat.updatedAt);
  const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now.getTime() - updatedMs) : undefined;
  return {
    ...heartbeat,
    ...(typeof ageMs === "number" ? { ageMs, stale: ageMs > 90_000 } : { stale: true }),
  };
}

export function diagnoseTestbedMissionReportFromMessage(input: MissionReportInput): MissionReportDiagnosis {
  const text = input.text ?? "";
  const report = parseMissionReport(text);
  const candidate = Boolean(report) || looksLikeMissionReportText(text);
  if (!report) {
    return candidate
      ? { candidate: true, valid: false, errors: ["No JSON report object was found."], warnings: [] }
      : { candidate: false, valid: false, errors: [], warnings: [] };
  }
  const missionId = missionIdFromReportInput(input, report);
  const errors = validateMissionReport(report);
  const warnings = missionId ? [] : ["No missionId was included; Hermes will only attach this if exactly one mission is active."];
  return {
    candidate: true,
    valid: errors.length === 0,
    errors,
    warnings,
    ...(missionId ? { missionId } : {}),
    report,
  };
}

export function testbedMissionRunToMonitorItem(run: TestbedMissionRun): Record<string, unknown> {
  const active = run.status === "requested" || run.status === "ready" || run.status === "running";
  const terminalStatus = run.status === "requested"
    ? "requested"
    : run.status === "completed"
      ? "completed"
      : run.status === "failed"
        ? "failed"
        : "running";
  const structuredReport = testbedMissionStructuredReport(run);
  const verdict = run.status === "completed"
    ? "pass"
    : run.status === "failed"
      ? structuredReport?.verdict ?? "failed"
      : run.status === "requested"
        ? "requested"
        : "running";
  const reportAttached = Boolean(run.result);
  const requested = run.status === "requested";
  return {
    correlationId: run.id,
    requester: "monitor",
    intent: "testbed_agent_mission",
    repo: "testbed/mission",
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
      missionStatus: run.status,
      finalReason: run.statusReason,
      finalVerdict: verdict,
      mergeRecommendation: "not_applicable",
      ...(structuredReport ? { structuredReport } : {}),
      reviewSignals: {
        touchedAreas: ["testbed"],
        testSignals: [
          requested ? "tester run requested" : "mission packet ready",
          ...(run.status === "running" ? ["browser mission runner claimed"] : []),
          ...(run.environment ? [`mission environment: ${run.environment}`] : []),
          ...(run.mutationMode ? [`mutation profile: ${run.mutationMode}`] : []),
          ...(run.allowTestMutations ? ["test-mode page mutation allowed"] : []),
          ...(reportAttached ? ["browser agent report attached"] : []),
        ],
        missingTestSignals: reportAttached
          ? []
          : requested
            ? ["operator approval", "browser-agent report"]
            : ["browser-agent report"],
      },
      reviewReasons: run.status === "failed"
        ? [{ severity: "high", code: "testbed_mission_failed", message: run.statusReason }]
        : [],
      testbedMission: run,
    },
    safety: {
      source: "monitor",
      wouldMutate: false,
      browserMissionShouldMutate: run.allowTestMutations,
      requestedBrowserMissionShouldMutate: run.requestedAllowTestMutations === true,
      missionEnvironment: run.environment,
      mutationMode: run.mutationMode,
      mutationScope: run.mutationScope,
      mutationBindingReason: run.mutationBindingReason,
      wouldWriteLocalCheckpoint: false,
      freeFormHermesPromptUsed: false,
    },
  };
}

export function testbedMissionStructuredReport(run: TestbedMissionRun): TestbedMissionStructuredReport | undefined {
  const result = run.result;
  if (!result) return undefined;
  const existing = isRecord(result.structuredReport) ? result.structuredReport : undefined;
  if (existing) {
    const normalizedExisting = normalizeTestbedMissionStructuredReport(existing, run);
    if (normalizedExisting) return normalizedExisting;
  }
  return normalizeTestbedMissionStructuredReport(result, run);
}

export function testbedMissionResultCoaching(run: TestbedMissionRun): string {
  const result = run.result ?? {};
  const verdict = typeof result.verdict === "string" ? result.verdict : run.status;
  const recommendations = stringArray(result.recommendations);
  const fixBrief = testbedMissionFixBrief(run);
  if (run.status === "completed") {
    return [
      "What I learned: the fresh browser agent found a path through the page without project-specific memory.",
      recommendations.length
        ? `Useful follow-up: ${recommendations[0]}`
        : "Useful follow-up: keep this report as the baseline before changing the page again.",
      "Smallest Codex task: no fix task is needed from this mission unless we want to improve the strongest remaining low-score area.",
    ].join(" ");
  }
  const weakScoreText = fixBrief.evidence.find((entry) => entry.startsWith("weak score:"))
    ? ` Low score signal: ${fixBrief.evidence.filter((entry) => entry.startsWith("weak score:")).map((entry) => entry.replace(/^weak score:\s*/, "")).join(", ")}.`
    : "";
  return [
    `What I learned: verdict ${verdict}; the first useful product signal is "${fixBrief.primaryBlocker}".${weakScoreText}`,
    `Suspected UX gap: ${fixBrief.suspectedUxGap}`,
    `Suggested product fix: ${fixBrief.smallestProductMove}`,
    `Smallest Codex task: improve the page or copy around "${fixBrief.primaryBlocker}" and then ${fixBrief.rerunProof}`,
  ].join(" ");
}

export function testbedMissionReportValidationCoaching(errors: string[], warnings: string[] = []): string {
  const missing = errors.slice(0, 4).join(" ");
  const warning = warnings.length ? ` ${warnings[0]}` : "";
  return [
    "I saw a possible testbed mission report, but I did not ingest it yet.",
    missing || "The report needs more structure before I can attach it to the mission.",
    "Use the card's Copy report template action, fill the missing fields, and post it again so I can close or fail the mission with auditable evidence.",
    "Smallest next move: keep the browser run as-is and only repair the report shape; do not ask Codex to change the product until the evidence is attached.",
    warning,
  ].filter(Boolean).join(" ");
}

export function testbedMissionCodexFollowupPrompt(run: TestbedMissionRun): string | undefined {
  if (run.status === "completed" || !run.result) return undefined;
  const result = run.result;
  const fixBrief = testbedMissionFixBrief(run);
  return [
    `Fix the testbed page for mission ${run.id}.`,
    "",
    `Target: ${run.targetUrl}`,
    `Goal: ${run.goal}`,
    `Fresh-agent result: ${String(result.verdict || run.status)}`,
    `Primary blocker: ${fixBrief.primaryBlocker}`,
    `Suspected UX gap: ${fixBrief.suspectedUxGap}`,
    `Smallest product move: ${fixBrief.smallestProductMove}`,
    `Proof after fix: ${fixBrief.rerunProof}`,
    "",
    "Use the smallest product/UI change that helps a normal outside agent complete this goal without project-specific memory. Keep mutation boundaries explicit and do not weaken safety copy.",
    "After the change, run the same testbed mission again and report whether the blocker disappeared.",
    fixBrief.evidence.length ? `Evidence:\n- ${fixBrief.evidence.join("\n- ")}` : "Evidence: see the attached testbed mission result in Hermes.",
  ].join("\n");
}

export function testbedMissionFixBrief(run: TestbedMissionRun): TestbedMissionFixBrief {
  const result = run.result ?? {};
  const blockers = stringArray(result.blockers);
  const confusingMoments = stringArray(result.confusingMoments);
  const recommendations = stringArray(result.recommendations);
  const weakScores = weakMissionScores(result.scores);
  const primaryBlocker = blockers[0] || confusingMoments[0] || "the fresh browser agent could not complete the mission cleanly";
  const smallestProductMove = recommendations[0] || productFixSuggestion(primaryBlocker, weakScores);
  const suspectedUxGap = productUxGap(primaryBlocker, weakScores);
  const evidence = missionEvidenceStrings(result.evidence)
    .concat(blockers.map((blocker) => `blocker: ${blocker}`))
    .concat(confusingMoments.map((moment) => `confusing moment: ${moment}`))
    .concat(weakScores.map((score) => `weak score: ${score}`))
    .slice(0, 8);
  return {
    primaryBlocker,
    suspectedUxGap,
    smallestProductMove,
    rerunProof: `run this same testbed mission again and verify whether "${primaryBlocker}" is gone, unchanged, or replaced`,
    evidence,
  };
}

export function testbedMissionRerunPrompt(run: TestbedMissionRun): string | undefined {
  if (run.status !== "failed" || !run.result) return undefined;
  const result = run.result;
  const blockers = stringArray(result.blockers);
  const confusingMoments = stringArray(result.confusingMoments);
  const recommendations = stringArray(result.recommendations);
  const primaryBlocker = blockers[0] || confusingMoments[0] || "the previous browser-agent run did not complete cleanly";
  const prompt = isRecord(run.mission) && typeof run.mission.missionPrompt === "string"
    ? run.mission.missionPrompt.trim()
    : "";
  return [
    `Rerun testbed mission ${run.id} after the product fix.`,
    "",
    `Target: ${run.targetUrl}`,
    `Goal: ${run.goal}`,
    "Memory mode: fresh browser agent; do not use Averray project memory or this monitor as product context.",
    `Previous verdict: ${String(result.verdict || run.status)}`,
    `Previous blocker to compare against: ${primaryBlocker}`,
    recommendations[0] ? `Expected improvement: ${recommendations[0]}` : "Expected improvement: the previous blocker should either disappear or become clearly different.",
    "",
    "Run the same visible-page path again. Stop before any real mutation boundary. Report whether the previous blocker is fixed, still present, or replaced by a new blocker.",
    prompt ? `\nOriginal mission prompt:\n${prompt}` : "",
  ].filter(Boolean).join("\n");
}

export function testbedMissionBaselinePrompt(run: TestbedMissionRun): string | undefined {
  if (run.status !== "completed" || !run.result) return undefined;
  const result = run.result;
  const completedPath = stringArray(result.completedPath);
  const evidence = missionEvidenceStrings(result.evidence).slice(0, 5);
  const recommendations = stringArray(result.recommendations);
  const prompt = isRecord(run.mission) && typeof run.mission.missionPrompt === "string"
    ? run.mission.missionPrompt.trim()
    : "";
  return [
    `Use testbed mission ${run.id} as the baseline for future page checks.`,
    "",
    `Target: ${run.targetUrl}`,
    `Goal: ${run.goal}`,
    "Memory mode: fresh browser agent; do not use Averray project memory or previous monitor discussion as product context.",
    `Baseline verdict: ${String(result.verdict || run.status)}`,
    typeof result.confidence === "number" ? `Baseline confidence: ${Math.round(result.confidence * 100)}%` : "",
    completedPath.length ? `Known-good path:\n- ${completedPath.join("\n- ")}` : "Known-good path: see the attached browser-agent report.",
    evidence.length ? `Baseline evidence:\n- ${evidence.join("\n- ")}` : "",
    recommendations[0] ? `Watch next time: ${recommendations[0]}` : "Watch next time: any new hesitation, missing context, or safety ambiguity compared with the known-good path.",
    "",
    "When the page changes, run this mission again and compare against the known-good path. Report whether the path still works, became clearer, or regressed.",
    prompt ? `\nOriginal mission prompt:\n${prompt}` : "",
  ].filter(Boolean).join("\n");
}

export function testbedMissionComparisonBrief(run: TestbedMissionRun): string | undefined {
  if (!run.result) return undefined;
  const result = run.result;
  const verdict = String(result.verdict || run.status);
  const completedPath = stringArray(result.completedPath);
  const blockers = stringArray(result.blockers);
  const confusingMoments = stringArray(result.confusingMoments);
  const recommendations = stringArray(result.recommendations);
  const weakScores = weakMissionScores(result.scores);
  if (run.status === "completed") {
    const knownGood = completedPath.length
      ? `Known-good path starts with "${completedPath[0]}".`
      : "Known-good path is attached in the browser-agent report.";
    return [
      "Comparison brief: treat this mission as a pass baseline.",
      knownGood,
      recommendations[0]
        ? `Next run should preserve the pass while checking this improvement: ${recommendations[0]}`
        : "Next run should preserve the same visible path and watch for any new hesitation or safety ambiguity.",
    ].join(" ");
  }
  const primaryBlocker = blockers[0] || confusingMoments[0] || "the fresh browser agent did not complete the mission cleanly";
  const weak = weakScores.length ? ` Weak signal: ${weakScores.join(", ")}.` : "";
  return [
    `Comparison brief: verdict ${verdict}; next run must check whether "${primaryBlocker}" is gone, unchanged, or replaced.`,
    recommendations[0] ? `Expected improvement: ${recommendations[0]}.` : "Expected improvement: the next safe step should be clearer to an outside agent.",
    weak,
  ].filter(Boolean).join(" ");
}

export function __resetTestbedMissionRunsForTests(): void {
  missionRuns.splice(0, missionRuns.length);
  missionSeq = 0;
  loadedMissionStorePath = undefined;
}

function ensureMissionStoreLoaded(path?: string, options: { force?: boolean } = {}): void {
  const targetPath = missionStorePath(path);
  if (!targetPath || (!options.force && loadedMissionStorePath === targetPath)) return;
  try {
    const value: unknown = JSON.parse(readFileSync(targetPath, "utf8"));
    const runs = missionStoreRuns(value);
    missionRuns.splice(0, missionRuns.length, ...runs);
    missionSeq = missionStoreSeq(value, runs);
    loadedMissionStorePath = targetPath;
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") throw error;
    missionRuns.splice(0, missionRuns.length);
    missionSeq = 0;
    loadedMissionStorePath = targetPath;
  }
}

function persistMissionStore(path?: string): void {
  const targetPath = missionStorePath(path);
  if (!targetPath) return;
  const store = {
    schemaVersion: 1,
    kind: "testbed_mission_store",
    missionSeq,
    runs: missionRuns.slice(-MAX_MISSION_RUNS),
  };
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(store, null, 2)}\n`);
  loadedMissionStorePath = targetPath;
}

function missionStoreRuns(value: unknown): TestbedMissionRun[] {
  const rawRuns = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.runs)
      ? value.runs
      : [];
  return rawRuns.filter(isTestbedMissionRun).slice(-MAX_MISSION_RUNS);
}

function missionStoreSeq(value: unknown, runs: TestbedMissionRun[]): number {
  if (isRecord(value) && typeof value.missionSeq === "number" && Number.isFinite(value.missionSeq)) {
    return Math.max(0, Math.floor(value.missionSeq));
  }
  return runs.reduce((max, run) => {
    const match = run.id.match(/-(\d+)$/);
    const parsed = match ? Number(match[1]) : 0;
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
}

function missionSelfHealingSurfaceKey(run: TestbedMissionRun): string {
  let key = run.targetUrl.trim().toLowerCase();
  try {
    const url = new URL(key);
    key = `${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    key = key.replace(/^https?:\/\//, "").split(/[?#]/)[0]!.replace(/\/+$/, "");
  }
  return key || "unknown";
}

function missionUpdatedMs(run: TestbedMissionRun): number {
  const parsed = Date.parse(run.updatedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function missionFailedMs(run: TestbedMissionRun): number {
  const parsed = Date.parse(run.failedAt ?? run.updatedAt);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function parseTestbedMissionMode(value: string | undefined): TestbedMissionMode | undefined {
  if (value === "surface_sweep" || value === "siwe_auth") return value;
  return undefined;
}

function testbedMissionTitle(mode: TestbedMissionMode | undefined): string {
  switch (mode) {
    case "surface_sweep":
      return "Surface sweep (T1)";
    case "siwe_auth":
      return "SIWE auth role-gating mission";
    default:
      return "Fresh-agent browser mission";
  }
}

function testbedMissionReadyMessage(
  mode: TestbedMissionMode | undefined,
  binding: ReturnType<typeof resolveTestbedMutationBinding>
): string {
  if (mode === "siwe_auth") {
    return "SIWE auth mission generated; waiting for the signer-sidecar role sessions and read-only role-gating checks.";
  }
  if (binding.allowTestMutations) {
    return `Mission packet generated for ${binding.environment}; waiting for a clean browser-only test-mode run where safe sandbox page mutations are allowed.`;
  }
  if (binding.requestedAllowTestMutations) {
    return `Mission packet generated, but mutation was rebound to read-only: ${binding.reason}`;
  }
  return `Mission packet generated for ${binding.environment}; waiting for a clean browser-only agent run.`;
}

function testbedMissionReadyReason(
  mode: TestbedMissionMode | undefined,
  binding: ReturnType<typeof resolveTestbedMutationBinding>
): string {
  if (mode === "siwe_auth") {
    return "SIWE auth mission is ready; waiting for signer-sidecar role sessions and structured role-gating evidence.";
  }
  if (binding.allowTestMutations) {
    return `Mission packet is ready with ${binding.environment} testbed mutations allowed; waiting for a browser-only test-mode run and structured report.`;
  }
  if (binding.requestedAllowTestMutations) {
    return `Mission packet is ready, but env→mutation binding forced read-only: ${binding.reason}`;
  }
  return "Mission packet is ready; waiting for a browser-only agent run and structured report.";
}

function missionStorePath(path?: string): string | undefined {
  return path ?? process.env.AVERRAY_TESTBED_MISSIONS_PATH;
}

function missionRunnerHeartbeatPath(path?: string): string | undefined {
  const storePath = missionStorePath(path);
  return storePath ? `${storePath}.runner.json` : undefined;
}

function trimMissionHistory(run: TestbedMissionRun): void {
  run.history = run.history
    .filter((entry) => entry.at && entry.status && entry.event && entry.message)
    .slice(-30);
}

function testbedMissionRunnerStatusMessage(status: TestbedMissionRunnerHeartbeatStatus): string {
  switch (status) {
    case "idle":
      return "Hermes testbed runner is online and waiting for a browser mission.";
    case "running":
      return "Hermes testbed runner is executing a browser mission.";
    case "completed":
      return "Hermes testbed runner completed its latest browser mission.";
    case "failed":
      return "Hermes testbed runner failed its latest browser mission.";
    case "disabled":
      return "Hermes testbed runner is disabled.";
    case "misconfigured":
      return "Hermes testbed runner is misconfigured.";
    case "error":
      return "Hermes testbed runner hit an error.";
  }
}

function onlyActiveMissionRun(): TestbedMissionRun | undefined {
  const activeRuns = missionRuns
    .filter((run) => run.status === "ready" || run.status === "running")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return activeRuns.length === 1 ? activeRuns[0] : undefined;
}

function testbedMissionRequestedMessage(
  requesterAgent: TestbedMissionRequesterAgent | undefined,
  reason: string | undefined
): string {
  const requester = requesterAgent ?? "agent";
  return [
    `Tester run requested by ${requester}; waiting for operator approval before the runner can claim it.`,
    reason ? `Reason: ${reason}` : "",
  ].filter(Boolean).join(" ");
}

function testbedMissionRequestedReason(
  requesterAgent: TestbedMissionRequesterAgent | undefined,
  reason: string | undefined
): string {
  const requester = requesterAgent ?? "agent";
  return [
    `Tester run requested by ${requester}; it has not started and remains board-gated until the operator approves it.`,
    reason ? `Reason: ${reason}` : "",
  ].filter(Boolean).join(" ");
}

function testbedMissionReadyReasonForRun(run: TestbedMissionRun): string {
  if (run.mode === "siwe_auth") {
    return "SIWE auth mission is ready; waiting for signer-sidecar role sessions and structured role-gating evidence.";
  }
  if (run.allowTestMutations) {
    return `Mission packet is ready with ${run.environment ?? "testbed"} testbed mutations allowed; waiting for a browser-only test-mode run and structured report.`;
  }
  if (run.requestedAllowTestMutations) {
    return `Mission packet is ready, but env→mutation binding forced read-only: ${run.mutationBindingReason ?? "testbed mutations denied"}.`;
  }
  return "Mission packet is ready; waiting for a browser-only agent run and structured report.";
}

function cloneRun(run: TestbedMissionRun): TestbedMissionRun {
  return {
    ...run,
    mission: { ...run.mission },
    history: run.history.map((entry) => ({ ...entry })),
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

function looksLikeMissionReportText(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("mission report")
    || lower.includes("testbed mission")
    || /\btestbed-mission-[A-Za-z0-9-]+\b/.test(text);
}

function validateMissionReport(report: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const verdict = normalizeVerdict(report.verdict);
  if (!verdict) errors.push("Set verdict to pass, partial, or fail.");
  if (typeof report.confidence !== "number" || report.confidence < 0 || report.confidence > 1) {
    errors.push("Set confidence to a number from 0 to 1.");
  }
  if (typeof report.stoppedBeforeMutation !== "boolean") {
    errors.push("Set stoppedBeforeMutation to true or false.");
  }
  if (!nonEmptyStringArray(report.evidence)) {
    errors.push("Add at least one evidence item or observation.");
  }
  if (report.stoppedBeforeMutation === false && !nonEmptyStringArray(report.mutationsAttempted)) {
    errors.push("List mutationsAttempted when the browser agent crossed a test mutation boundary.");
  }
  if (!isRecord(report.scores)) {
    errors.push("Add a scores object, even if some scores are 0.");
  }
  if (!nonEmptyStringArray(report.mutationBoundaryNotes)) {
    errors.push("Add mutationBoundaryNotes explaining where the agent stopped, or which test-only mutation boundary it crossed.");
  }
  if (verdict === "pass" && !nonEmptyStringArray(report.completedPath)) {
    errors.push("For a pass, add the completedPath steps the browser agent actually took.");
  }
  if ((verdict === "partial" || verdict === "fail") && !nonEmptyStringArray(report.blockers) && !nonEmptyStringArray(report.confusingMoments)) {
    errors.push("For partial or fail, add blockers or confusingMoments so Hermes knows what stopped the agent.");
  }
  return errors;
}

export function normalizeTestbedMissionStructuredReport(
  report: Record<string, unknown>,
  run?: Pick<TestbedMissionRun, "allowTestMutations">
): TestbedMissionStructuredReport | undefined {
  const verdict = normalizeVerdict(report.verdict);
  if (!verdict) return undefined;
  const confidence = clampNumber(typeof report.confidence === "number" ? report.confidence : 0, 0, 1);
  const stoppedBeforeMutation = typeof report.stoppedBeforeMutation === "boolean"
    ? report.stoppedBeforeMutation
    : true;
  const mutationMode = typeof report.mutationMode === "string" && report.mutationMode.trim()
    ? report.mutationMode.trim()
    : run?.allowTestMutations ? "testbed_mutation_allowed" : "stop_before_mutation";
  const blockers = stringArray(report.blockers);
  const confusingMoments = stringArray(report.confusingMoments);
  const mutationBoundaryNotes = stringArray(report.mutationBoundaryNotes);
  const mutationsAttempted = stringArray(report.mutationsAttempted);
  const completedPath = stringArray(report.completedPath);
  const recommendations = stringArray(report.recommendations);
  const evidence = missionEvidenceStrings(report.evidence).slice(0, 12);
  const scores = normalizedMissionScores(report.scores);
  const summary = missionReportSummary({
    verdict,
    blockers,
    confusingMoments,
    mutationBoundaryNotes,
    stoppedBeforeMutation,
    mutationMode,
  });
  return {
    verdict,
    confidence,
    scores,
    blockers,
    confusingMoments,
    mutationBoundaryNotes,
    stoppedBeforeMutation,
    mutationMode,
    mutationsAttempted,
    completedPath,
    recommendations,
    evidence,
    summary,
  };
}

function nonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => String(entry ?? "").trim().length > 0);
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
  stoppedBeforeMutation: boolean,
  allowTestMutations: boolean
): string {
  const structuredReport = isRecord(report.structuredReport)
    ? normalizeTestbedMissionStructuredReport(report.structuredReport, { allowTestMutations })
    : normalizeTestbedMissionStructuredReport(report, { allowTestMutations });
  const verdict = structuredReport?.verdict ?? normalizeVerdict(report.verdict) ?? "reported";
  const blockers = structuredReport?.blockers ?? stringArray(report.blockers);
  const mutationNotes = structuredReport?.mutationBoundaryNotes ?? stringArray(report.mutationBoundaryNotes);
  if (!stoppedBeforeMutation && !allowTestMutations) {
    return mutationNotes[0]
      ? `Browser-agent report says the mission crossed or attempted a mutation boundary: ${mutationNotes[0]}`
      : "Browser-agent report says the mission crossed or attempted a mutation boundary.";
  }
  if (status === "completed") {
    if (!stoppedBeforeMutation && allowTestMutations) {
      return mutationNotes[0]
        ? `Browser-agent report passed after permitted testbed-only page mutation: ${mutationNotes[0]}`
        : "Browser-agent report passed after permitted testbed-only page mutation; Hermes has structured evidence for this mission.";
    }
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

function compareToPreviousMissionBaseline(
  run: TestbedMissionRun,
  report: TestbedMissionStructuredReport
): TestbedMissionBaselineComparison | undefined {
  const baseline = missionRuns
    .filter((candidate) =>
      candidate.id !== run.id
      && candidate.status === "completed"
      && candidate.targetUrl === run.targetUrl
      && candidate.goal === run.goal
      && (candidate.environment ?? "unknown") === (run.environment ?? "unknown")
      && Boolean(candidate.result)
    )
    .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt))[0];
  if (!baseline) return undefined;
  const baselineReport = testbedMissionStructuredReport(baseline);
  if (!baselineReport) return undefined;
  const scoreDeltas = Object.fromEntries(
    Object.keys({ ...baselineReport.scores, ...report.scores })
      .map((key) => [key, Math.round(((report.scores[key] ?? 0) - (baselineReport.scores[key] ?? 0)) * 100) / 100] as const)
      .filter(([, delta]) => delta !== 0)
  );
  const blockerChanged = (baselineReport.blockers[0] ?? "") !== (report.blockers[0] ?? "");
  const verdictChanged = baselineReport.verdict !== report.verdict;
  const scoreSummary = Object.entries(scoreDeltas)
    .slice(0, 3)
    .map(([key, delta]) => `${key} ${delta > 0 ? "+" : ""}${delta}`)
    .join(", ");
  return {
    baselineRunId: baseline.id,
    ...(baseline.completedAt ? { baselineCompletedAt: baseline.completedAt } : {}),
    verdictChanged,
    blockerChanged,
    scoreDeltas,
    summary: [
      `Compared against baseline ${baseline.id}.`,
      verdictChanged ? `Verdict changed ${baselineReport.verdict}→${report.verdict}.` : `Verdict stayed ${report.verdict}.`,
      blockerChanged ? "Primary blocker changed." : "Primary blocker unchanged.",
      scoreSummary ? `Score deltas: ${scoreSummary}.` : "No score deltas recorded.",
    ].join(" "),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean)
    : [];
}

function missionEvidenceStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (!isRecord(entry)) return String(entry ?? "").trim();
    const type = typeof entry.type === "string" ? entry.type.trim() : "evidence";
    const detail = typeof entry.value === "string"
      ? entry.value.trim()
      : typeof entry.url === "string"
        ? entry.url.trim()
        : "";
    return detail ? `${type}: ${detail}` : type;
  }).filter(Boolean);
}

function weakMissionScores(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, score]) => typeof score === "number" && score <= 3)
    .map(([key, score]) => `${key}:${score}`)
    .slice(0, 3);
}

function normalizedMissionScores(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, score]) => [key, Number(score)] as const)
      .filter(([, score]) => Number.isFinite(score))
      .map(([key, score]) => [key, clampNumber(score, 0, 5)])
  );
}

function missionReportSummary(report: {
  verdict: TestbedMissionVerdict;
  blockers: string[];
  confusingMoments: string[];
  mutationBoundaryNotes: string[];
  stoppedBeforeMutation: boolean;
  mutationMode: string;
}): string {
  const firstIssue = report.blockers[0] || report.confusingMoments[0];
  const mutation = report.mutationBoundaryNotes[0]
    || (report.stoppedBeforeMutation
      ? "agent stopped before mutation"
      : `agent crossed a ${report.mutationMode} boundary`);
  if (report.verdict === "pass") {
    return `pass: usable path found; ${mutation}`;
  }
  if (firstIssue) {
    return `${report.verdict}: ${firstIssue}; ${mutation}`;
  }
  return `${report.verdict}: inspect evidence; ${mutation}`;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function productFixSuggestion(primaryBlocker: string, weakScores: string[]): string {
  const blocker = primaryBlocker.toLowerCase();
  if (blocker.includes("wallet") || blocker.includes("submit") || blocker.includes("mutation")) {
    return "make the mutation boundary explicit before the agent reaches any wallet, submit, or irreversible action.";
  }
  if (blocker.includes("find") || blocker.includes("navigation") || blocker.includes("where")) {
    return "make the next action visible in the first viewport and label it with the user's goal language.";
  }
  if (weakScores.some((score) => score.toLowerCase().includes("trust") || score.toLowerCase().includes("safety"))) {
    return "add clearer trust and safety copy near the action that made the agent hesitate.";
  }
  return "remove the ambiguity the browser agent reported and make the next safe step visible without insider context.";
}

function productUxGap(primaryBlocker: string, weakScores: string[]): string {
  const blocker = primaryBlocker.toLowerCase();
  if (blocker.includes("wallet") || blocker.includes("submit") || blocker.includes("mutation")) {
    return "the page does not make the safe stopping point or irreversible action boundary obvious enough for a fresh agent.";
  }
  if (blocker.includes("find") || blocker.includes("navigation") || blocker.includes("where")) {
    return "the next action is discoverable to project insiders, but not prominent enough for an outside agent's first pass.";
  }
  if (weakScores.some((score) => score.toLowerCase().includes("trust") || score.toLowerCase().includes("safety"))) {
    return "the agent lacked enough trust or safety context near the moment it had to decide whether to continue.";
  }
  return "the page asks the agent to infer context that should be visible in the product experience.";
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

function isTestbedMissionRun(value: unknown): value is TestbedMissionRun {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && value.kind === "testbed_mission_run"
    && typeof value.id === "string"
    && typeof value.status === "string"
    && typeof value.targetUrl === "string"
    && typeof value.goal === "string"
    && typeof value.agentName === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && Array.isArray(value.history);
}

function isTestbedMissionRunnerHeartbeat(value: unknown): value is TestbedMissionRunnerHeartbeat {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && value.kind === "testbed_mission_runner_heartbeat"
    && typeof value.runnerId === "string"
    && typeof value.status === "string"
    && typeof value.message === "string"
    && typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
