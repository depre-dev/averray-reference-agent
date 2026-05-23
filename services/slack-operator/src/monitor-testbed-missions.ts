const MAX_MISSION_RUNS = 50;

export type TestbedMissionStatus = "ready" | "running" | "completed" | "failed";

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
  freshMemory: boolean;
  mission: Record<string, unknown>;
  result?: Record<string, unknown>;
  history: TestbedMissionHistoryEntry[];
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

export interface MissionReportDiagnosis {
  candidate: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
  missionId?: string;
  report?: Record<string, unknown>;
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
    history: [
      {
        at: createdAt,
        status: "ready",
        event: "mission_packet_ready",
        message: "Mission packet generated; waiting for a clean browser-only agent run.",
      },
    ],
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
    .map((run) => cloneRun(run));
}

export function recordTestbedMissionReportFromMessage(
  input: MissionReportInput,
  nowMs: number = Date.now()
): TestbedMissionRun | undefined {
  const diagnosis = diagnoseTestbedMissionReportFromMessage(input);
  if (!diagnosis.valid || !diagnosis.report) return undefined;
  const report = diagnosis.report;
  const missionId = diagnosis.missionId;
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
  run.history.push({
    at: updatedAt,
    status,
    event: status === "completed" ? "mission_report_passed" : "mission_report_needs_fix",
    message: run.statusReason,
  });
  return cloneRun(run);
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

export function testbedMissionResultCoaching(run: TestbedMissionRun): string {
  const result = run.result ?? {};
  const verdict = typeof result.verdict === "string" ? result.verdict : run.status;
  const blockers = stringArray(result.blockers);
  const confusingMoments = stringArray(result.confusingMoments);
  const recommendations = stringArray(result.recommendations);
  const weakScores = weakMissionScores(result.scores);
  if (run.status === "completed") {
    return [
      "What I learned: the fresh browser agent found a path through the page without project-specific memory.",
      recommendations.length
        ? `Useful follow-up: ${recommendations[0]}`
        : "Useful follow-up: keep this report as the baseline before changing the page again.",
      "Smallest Codex task: no fix task is needed from this mission unless we want to improve the strongest remaining low-score area.",
    ].join(" ");
  }
  const primaryBlocker = blockers[0] || confusingMoments[0] || "the browser agent could not complete the mission cleanly";
  const weakScoreText = weakScores.length ? ` Low score signal: ${weakScores.join(", ")}.` : "";
  const recommendation = recommendations[0] || productFixSuggestion(primaryBlocker, weakScores);
  return [
    `What I learned: verdict ${verdict}; the first useful product signal is "${primaryBlocker}".${weakScoreText}`,
    `Suggested product fix: ${recommendation}`,
    `Smallest Codex task: improve the page or copy around "${primaryBlocker}" and then run this same testbed mission again.`,
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
  const blockers = stringArray(result.blockers);
  const confusingMoments = stringArray(result.confusingMoments);
  const recommendations = stringArray(result.recommendations);
  const weakScores = weakMissionScores(result.scores);
  const primaryBlocker = blockers[0] || confusingMoments[0] || "the fresh browser agent could not complete the mission cleanly";
  const suggestedFix = recommendations[0] || productFixSuggestion(primaryBlocker, weakScores);
  const evidence = missionEvidenceStrings(result.evidence)
    .concat(blockers.map((blocker) => `blocker: ${blocker}`))
    .concat(confusingMoments.map((moment) => `confusing moment: ${moment}`))
    .concat(weakScores.map((score) => `weak score: ${score}`))
    .slice(0, 8);
  return [
    `Fix the testbed page for mission ${run.id}.`,
    "",
    `Target: ${run.targetUrl}`,
    `Goal: ${run.goal}`,
    `Fresh-agent result: ${String(result.verdict || run.status)}`,
    `Primary blocker: ${primaryBlocker}`,
    `Suggested product fix: ${suggestedFix}`,
    "",
    "Use the smallest product/UI change that helps a normal outside agent complete this goal without project-specific memory. Keep mutation boundaries explicit and do not weaken safety copy.",
    "After the change, run the same testbed mission again and report whether the blocker disappeared.",
    evidence.length ? `Evidence:\n- ${evidence.join("\n- ")}` : "Evidence: see the attached testbed mission result in Hermes.",
  ].join("\n");
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
  if (!isRecord(report.scores)) {
    errors.push("Add a scores object, even if some scores are 0.");
  }
  if (verdict === "pass" && !nonEmptyStringArray(report.completedPath)) {
    errors.push("For a pass, add the completedPath steps the browser agent actually took.");
  }
  if ((verdict === "partial" || verdict === "fail") && !nonEmptyStringArray(report.blockers) && !nonEmptyStringArray(report.confusingMoments)) {
    errors.push("For partial or fail, add blockers or confusingMoments so Hermes knows what stopped the agent.");
  }
  return errors;
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
