import { readFile } from "node:fs/promises";
import { getHandoffMonitor } from "./handoff-events.js";
import {
  aggregateLlmUsage,
  aggregateLlmUsageForAgent,
  llmUsageLogPath,
  readLlmUsageEvents,
  type LlmUsageEvent,
} from "./llm-usage.js";

export type ScorecardAgent = "codex" | "claude" | "test-writer" | "hermes" | "browser" | "unknown";
export type ScorecardConfidence = "none" | "low" | "medium" | "high";

export interface AgentScorecardOptions {
  now?: Date;
  limit?: number;
  activeWindowMinutes?: number;
  eventLogPath?: string;
  codexTasksPath?: string;
  testbedMissionsPath?: string;
  llmUsageLogPath?: string;
  llmUsageEvents?: LlmUsageEvent[];
}

interface MutableAgentStats {
  agent: ScorecardAgent;
  handoffs: number;
  taskTotal: number;
  taskCompleted: number;
  taskFailed: number;
  taskCancelled: number;
  taskRunning: number;
  taskProposed: number;
  taskAttempts: number;
  taskDurationMsTotal: number;
  taskDurationCount: number;
  missionTotal: number;
  missionPassed: number;
  missionPartial: number;
  missionFailed: number;
  prOpened: number;
  prMerged: number;
  prMergeReady: number;
  prNeedsReview: number;
  prBlocked: number;
  prDraft: number;
  checkPass: number;
  checkFail: number;
  checkRunning: number;
  checkNeutral: number;
  verdicts: Record<string, number>;
  surfaces: Map<string, { count: number; ready: number; blocked: number }>;
  seenPrKeys: Set<string>;
}

export async function getAgentScorecard(options: AgentScorecardOptions = {}) {
  const now = options.now ?? new Date();
  const monitor = await getHandoffMonitor({
    limit: options.limit ?? 100,
    activeWindowMinutes: options.activeWindowMinutes,
    eventLogPath: options.eventLogPath,
    now,
  });
  const codexTasks = await readCodexTasks(options.codexTasksPath);
  const testbedMissions = await readTestbedMissions(options.testbedMissionsPath);
  const llmUsageEvents = options.llmUsageEvents ?? await readLlmUsageEvents(options.llmUsageLogPath ?? llmUsageLogPath());
  return buildAgentScorecard({
    ...monitor,
    codexTasks: {
      schemaVersion: 1,
      kind: "codex_task_queue",
      items: codexTasks,
    },
    testbedMissions,
    llmUsageEvents,
  }, { now });
}

export function buildAgentScorecard(snapshot: unknown, options: { now?: Date } = {}) {
  const now = options.now ?? new Date();
  const root = isRecord(snapshot) ? snapshot : {};
  const agents = new Map<ScorecardAgent, MutableAgentStats>();

  for (const item of [...records(root.active), ...records(root.recent)]) {
    recordHandoffItem(agents, item);
  }

  const codexTasks = isRecord(root.codexTasks) ? root.codexTasks : {};
  for (const task of records(codexTasks.items)) {
    recordTask(agents, task);
  }

  for (const mission of records(root.testbedMissions)) {
    recordMission(agents, mission);
  }
  const llmUsageEvents = usageEvents(root.llmUsageEvents);
  const llmUsage = aggregateLlmUsage(llmUsageEvents);
  for (const item of llmUsage.byModel) {
    ensureAgent(agents, scorecardAgent(item.agent));
  }

  const items = Array.from(agents.values())
    .map((agent) => finalizeAgent(agent, llmUsage))
    .sort((a, b) => agentSortKey(a.agent) - agentSortKey(b.agent) || b.sampleCount - a.sampleCount);

  const totals = items.reduce(
    (acc, item) => {
      acc.agents += 1;
      acc.samples += item.sampleCount;
      acc.tasks += item.tasks.total;
      acc.pullRequests += item.quality.pullRequests.opened;
      acc.missions += item.missions.total;
      return acc;
    },
    { agents: 0, samples: 0, tasks: 0, pullRequests: 0, missions: 0 }
  );

  return {
    schemaVersion: 1,
    kind: "averray_agent_scorecard",
    generatedAt: now.toISOString(),
    truthBoundary: "Read-only A1 scorecard from monitor events, task queue state, browser mission reports, and whitelisted LLM usage counters. Missing cost/token/autopilot-rework signals are marked as not_recorded, not inferred.",
    totals,
    llmUsage,
    agents: items,
    gaps: [
      llmUsage.status === "recorded"
        ? "LLM usage only includes providers/runs that report whitelisted counters; missing providers stay not_recorded."
        : "Cost and token totals are not present in the current runner events.",
      "Autopilot auto-approval rework is not yet emitted as a durable signal.",
      "Time-to-PR and time-to-merge need GitHub timeline evidence before they become routing inputs.",
    ],
    safety: {
      readOnly: true,
      mutatesGithub: false,
      mutatesRunnerQueue: false,
      routingInfluence: "A1 only observes. A2 may use these baselines later with high-risk surfaces still rule-bound.",
    },
  };
}

function recordHandoffItem(agents: Map<ScorecardAgent, MutableAgentStats>, item: Record<string, unknown>): void {
  const agent = agentForHandoff(item);
  const stats = ensureAgent(agents, agent);
  stats.handoffs += 1;

  const summary = recordField(item, "summary");
  const currentPr = firstRecord(
    recordField(summary, "currentPullRequest"),
    recordField(summary, "pullRequest"),
    recordField(item, "currentPullRequest"),
    recordField(item, "pullRequest")
  );
  if (currentPr) {
    const repo = stringField(currentPr, "repo") ?? stringField(item, "repo") ?? "unknown";
    const number = numberField(currentPr, "number") ?? numberField(item, "pullRequestNumber") ?? 0;
    const prKey = `${repo}#${number}`;
    if (!stats.seenPrKeys.has(prKey)) {
      stats.seenPrKeys.add(prKey);
      stats.prOpened += 1;
      if (booleanField(currentPr, "merged")) stats.prMerged += 1;
      if (booleanField(currentPr, "draft")) stats.prDraft += 1;
    }
  }

  const finalVerdict = normalizedVerdict(
    stringField(summary, "finalVerdict")
      ?? stringField(summary, "mergeRecommendation")
      ?? stringField(item, "reason")
      ?? stringField(item, "status")
  );
  if (finalVerdict) {
    stats.verdicts[finalVerdict] = (stats.verdicts[finalVerdict] ?? 0) + 1;
    if (isReadyVerdict(finalVerdict)) stats.prMergeReady += 1;
    if (isReviewVerdict(finalVerdict)) stats.prNeedsReview += 1;
    if (isBlockVerdict(finalVerdict)) stats.prBlocked += 1;
  }

  for (const check of records(summary?.checks)) {
    const status = stringField(check, "status");
    const conclusion = stringField(check, "conclusion");
    if (status === "completed" && conclusion === "success") stats.checkPass += 1;
    else if (status === "completed" && conclusion && conclusion !== "success" && conclusion !== "neutral") stats.checkFail += 1;
    else if (status === "in_progress" || status === "queued" || status === "waiting") stats.checkRunning += 1;
    else stats.checkNeutral += 1;
  }

  for (const surface of surfacesForHandoff(summary)) {
    const surfaceStats = stats.surfaces.get(surface) ?? { count: 0, ready: 0, blocked: 0 };
    surfaceStats.count += 1;
    if (finalVerdict && isReadyVerdict(finalVerdict)) surfaceStats.ready += 1;
    if (finalVerdict && isBlockVerdict(finalVerdict)) surfaceStats.blocked += 1;
    stats.surfaces.set(surface, surfaceStats);
  }
}

function recordTask(agents: Map<ScorecardAgent, MutableAgentStats>, task: Record<string, unknown>): void {
  const agent = taskAgent(task);
  const stats = ensureAgent(agents, agent);
  stats.taskTotal += 1;
  const status = stringField(task, "status");
  if (status === "completed") stats.taskCompleted += 1;
  else if (status === "failed") stats.taskFailed += 1;
  else if (status === "cancelled") stats.taskCancelled += 1;
  else if (status === "running") stats.taskRunning += 1;
  else if (status === "proposed" || status === "approved") stats.taskProposed += 1;

  stats.taskAttempts += Math.max(0, numberField(task, "attemptCount") ?? 0);
  const started = stringField(task, "startedAt");
  const ended = stringField(task, "completedAt") ?? stringField(task, "failedAt");
  const durationMs = durationBetween(started, ended);
  if (durationMs !== undefined) {
    stats.taskDurationMsTotal += durationMs;
    stats.taskDurationCount += 1;
  }
}

function recordMission(agents: Map<ScorecardAgent, MutableAgentStats>, mission: Record<string, unknown>): void {
  const agent = agentForMission(mission);
  const stats = ensureAgent(agents, agent);
  stats.missionTotal += 1;
  const result = recordField(mission, "result");
  const verdict = normalizedVerdict(stringField(result, "verdict") ?? stringField(mission, "status"));
  if (verdict === "pass" || verdict === "ok_to_merge") stats.missionPassed += 1;
  else if (verdict === "partial" || verdict === "needs_review" || verdict === "operator_review") stats.missionPartial += 1;
  else if (verdict === "fail" || verdict === "failed" || verdict === "block") stats.missionFailed += 1;
}

function finalizeAgent(stats: MutableAgentStats, llmUsage: ReturnType<typeof aggregateLlmUsage>) {
  const terminalTasks = stats.taskCompleted + stats.taskFailed + stats.taskCancelled;
  const checkTotal = stats.checkPass + stats.checkFail + stats.checkRunning + stats.checkNeutral;
  const sampleCount = stats.handoffs + stats.taskTotal + stats.missionTotal;
  const successNumerator = stats.prMerged + stats.prMergeReady + stats.taskCompleted + stats.missionPassed;
  const outcomeDenominator = Math.max(
    1,
    stats.prOpened + terminalTasks + stats.missionPassed + stats.missionPartial + stats.missionFailed
  );
  const successRate = round(successNumerator / outcomeDenominator, 3);
  const checkPassRate = checkTotal > 0 ? round(stats.checkPass / checkTotal, 3) : null;
  const failurePenalty = round((stats.prBlocked + stats.taskFailed + stats.missionFailed) / outcomeDenominator, 3);
  const routingScore = sampleCount > 0
    ? clamp(Math.round((successRate * 0.65 + (checkPassRate ?? successRate) * 0.25 + (1 - failurePenalty) * 0.10) * 100), 0, 100)
    : null;
  const agentUsage = aggregateLlmUsageForAgent(llmUsage, stats.agent);
  const tokensRecorded = agentUsage.status === "recorded";

  return {
    agent: stats.agent,
    sampleCount,
    confidence: confidenceFor(sampleCount),
    routingSignal: {
      score: routingScore,
      status: sampleCount >= 4 ? "baseline_available" : sampleCount > 0 ? "cold_start" : "no_signal",
      note: sampleCount >= 4
        ? "Enough read-only signal for humans to compare; A2 still needs safeguards before acting on it."
        : "Treat this as orientation only; static routing should still win.",
    },
    quality: {
      pullRequests: {
        opened: stats.prOpened,
        merged: stats.prMerged,
        mergeReady: stats.prMergeReady,
        needsReview: stats.prNeedsReview,
        blocked: stats.prBlocked,
        draft: stats.prDraft,
        mergeRate: stats.prOpened > 0 ? round(stats.prMerged / stats.prOpened, 3) : null,
      },
      checks: {
        pass: stats.checkPass,
        fail: stats.checkFail,
        running: stats.checkRunning,
        neutral: stats.checkNeutral,
        latestPassRate: checkPassRate,
      },
      verdicts: stats.verdicts,
    },
    tasks: {
      total: stats.taskTotal,
      completed: stats.taskCompleted,
      failed: stats.taskFailed,
      cancelled: stats.taskCancelled,
      running: stats.taskRunning,
      proposedOrApproved: stats.taskProposed,
      attempts: stats.taskAttempts,
      successRate: terminalTasks > 0 ? round(stats.taskCompleted / terminalTasks, 3) : null,
    },
    missions: {
      total: stats.missionTotal,
      passed: stats.missionPassed,
      partial: stats.missionPartial,
      failed: stats.missionFailed,
    },
    speed: {
      avgTaskDurationMinutes: stats.taskDurationCount > 0
        ? round((stats.taskDurationMsTotal / stats.taskDurationCount) / 60_000, 2)
        : null,
      timeToPrMinutes: null,
      timeToMergeMinutes: null,
      status: stats.taskDurationCount > 0 ? "task_duration_available" : "timeline_not_recorded",
    },
    cost: {
      status: agentUsage.costStatus,
      totalUsd: agentUsage.costUsd,
      totalTokens: tokensRecorded ? agentUsage.totalTokens : null,
      averageUsdPerTask: agentUsage.costUsd !== null && stats.taskTotal > 0
        ? round(agentUsage.costUsd / stats.taskTotal, 6)
        : null,
      byModel: agentUsage.byModel.map((entry) => ({
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.totalTokens,
        costUsd: entry.costUsd,
        costStatus: entry.costStatus,
        runs: entry.runs,
      })),
    },
    tokens: {
      status: tokensRecorded ? "recorded" : "not_recorded",
      inputTokens: tokensRecorded ? agentUsage.inputTokens : null,
      outputTokens: tokensRecorded ? agentUsage.outputTokens : null,
      totalTokens: tokensRecorded ? agentUsage.totalTokens : null,
      byModel: agentUsage.byModel.map((entry) => ({
        model: entry.model,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.totalTokens,
        runs: entry.runs,
      })),
    },
    trust: {
      autopilotAutoApprovals: 0,
      laterHumanRework: 0,
      status: "not_recorded",
    },
    surfaces: Array.from(stats.surfaces.entries())
      .map(([surface, value]) => ({ surface, ...value }))
      .sort((a, b) => b.count - a.count || a.surface.localeCompare(b.surface))
      .slice(0, 8),
  };
}

function ensureAgent(agents: Map<ScorecardAgent, MutableAgentStats>, agent: ScorecardAgent): MutableAgentStats {
  const existing = agents.get(agent);
  if (existing) return existing;
  const next: MutableAgentStats = {
    agent,
    handoffs: 0,
    taskTotal: 0,
    taskCompleted: 0,
    taskFailed: 0,
    taskCancelled: 0,
    taskRunning: 0,
    taskProposed: 0,
    taskAttempts: 0,
    taskDurationMsTotal: 0,
    taskDurationCount: 0,
    missionTotal: 0,
    missionPassed: 0,
    missionPartial: 0,
    missionFailed: 0,
    prOpened: 0,
    prMerged: 0,
    prMergeReady: 0,
    prNeedsReview: 0,
    prBlocked: 0,
    prDraft: 0,
    checkPass: 0,
    checkFail: 0,
    checkRunning: 0,
    checkNeutral: 0,
    verdicts: {},
    surfaces: new Map(),
    seenPrKeys: new Set(),
  };
  agents.set(agent, next);
  return next;
}

async function readCodexTasks(path?: string): Promise<Record<string, unknown>[]> {
  const taskPath = path ?? process.env.AVERRAY_CODEX_TASKS_PATH ?? "/tmp/averray-reference-agent/codex-tasks.json";
  try {
    const content = await readFile(taskPath, "utf8");
    const value: unknown = JSON.parse(content);
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) return records(value.items);
    return [];
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function readTestbedMissions(path?: string): Promise<Record<string, unknown>[]> {
  const missionPath = path ?? process.env.AVERRAY_TESTBED_MISSIONS_PATH;
  if (!missionPath) return [];
  try {
    const content = await readFile(missionPath, "utf8");
    const value: unknown = JSON.parse(content);
    if (Array.isArray(value)) return value.filter(isRecord);
    if (isRecord(value)) return records(value.runs);
    return [];
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
}

function agentForHandoff(item: Record<string, unknown>): ScorecardAgent {
  const summary = recordField(item, "summary");
  const pr = firstRecord(
    recordField(summary, "currentPullRequest"),
    recordField(summary, "pullRequest"),
    recordField(item, "currentPullRequest"),
    recordField(item, "pullRequest")
  );
  const branchAgent = agentFromBranch(stringField(pr, "headBranch") ?? stringField(item, "headBranch"));
  if (branchAgent) return branchAgent;
  const requester = (stringField(item, "requester") ?? "").toLowerCase();
  const source = (stringField(summary, "source") ?? "").toLowerCase();
  const intent = (stringField(item, "intent") ?? "").toLowerCase();
  if (intent.includes("testbed") || source.includes("testbed")) return "browser";
  if (requester.includes("github-live") || requester.includes("hermes") || source.includes("github_live")) return "hermes";
  return "unknown";
}

function taskAgent(task: Record<string, unknown>): ScorecardAgent {
  const agent = (stringField(task, "agent") ?? "").toLowerCase();
  const scorecard = scorecardAgent(agent);
  if (scorecard !== "unknown") return scorecard;
  return "codex";
}

function agentForMission(mission: Record<string, unknown>): ScorecardAgent {
  const name = (stringField(mission, "agentName") ?? "").toLowerCase();
  if (name.includes("codex")) return "codex";
  if (name.includes("claude")) return "claude";
  if (name.includes("hermes")) return "hermes";
  return "browser";
}

function agentFromBranch(branch: string | undefined): ScorecardAgent | undefined {
  const normalized = branch?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("codex/")) return "codex";
  if (normalized.startsWith("claude/")) return "claude";
  if (normalized.startsWith("test-writer/")) return "test-writer";
  return undefined;
}

function scorecardAgent(value: string): ScorecardAgent {
  const agent = value.trim().toLowerCase();
  if (agent === "codex") return "codex";
  if (agent === "claude") return "claude";
  if (agent === "test-writer" || agent === "test writer") return "test-writer";
  if (agent === "hermes") return "hermes";
  if (agent === "browser" || agent === "tester" || agent === "testbed") return "browser";
  return "unknown";
}

function usageEvents(value: unknown): LlmUsageEvent[] {
  return records(value)
    .map((event) => {
      const inputTokens = numberField(event, "inputTokens");
      const outputTokens = numberField(event, "outputTokens");
      const agent = stringField(event, "agent");
      const model = stringField(event, "model");
      const ts = stringField(event, "ts");
      if (!agent || !model || !ts || inputTokens === undefined || outputTokens === undefined) return undefined;
      if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) return undefined;
      const costUsd = numberField(event, "costUsd");
      return {
        agent,
        model,
        ...(stringField(event, "runId") ? { runId: stringField(event, "runId") } : {}),
        ...(stringField(event, "taskId") ? { taskId: stringField(event, "taskId") } : {}),
        inputTokens,
        outputTokens,
        ...(costUsd !== undefined ? { costUsd } : {}),
        ts,
      };
    })
    .filter((event): event is LlmUsageEvent => Boolean(event));
}

function surfacesForHandoff(summary: Record<string, unknown> | undefined): string[] {
  const reviewSignals = recordField(summary, "reviewSignals");
  const touchedAreas = arrayStrings(reviewSignals?.touchedAreas);
  if (touchedAreas.length > 0) return touchedAreas;
  const touchedFiles = records(reviewSignals?.touchedFiles)
    .map((file) => stringField(file, "area"))
    .filter((area): area is string => Boolean(area));
  if (touchedFiles.length > 0) return Array.from(new Set(touchedFiles));
  return [];
}

function normalizedVerdict(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function isReadyVerdict(verdict: string): boolean {
  return verdict === "ok_to_merge" || verdict === "pass" || verdict === "passed" || verdict === "completed" || verdict === "github_ok_to_merge";
}

function isReviewVerdict(verdict: string): boolean {
  return verdict === "needs_review" || verdict === "human_review" || verdict === "operator_review" || verdict === "review";
}

function isBlockVerdict(verdict: string): boolean {
  return verdict === "block" || verdict === "blocked" || verdict === "hold" || verdict === "failed" || verdict === "fail" || verdict === "github_hold";
}

function confidenceFor(sampleCount: number): ScorecardConfidence {
  if (sampleCount <= 0) return "none";
  if (sampleCount < 4) return "low";
  if (sampleCount < 10) return "medium";
  return "high";
}

function agentSortKey(agent: ScorecardAgent): number {
  switch (agent) {
    case "codex": return 0;
    case "claude": return 1;
    case "test-writer": return 2;
    case "hermes": return 3;
    case "browser": return 4;
    case "unknown": return 5;
  }
}

function durationBetween(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  return endMs - startMs;
}

function firstRecord(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  return values.find((value): value is Record<string, unknown> => Boolean(value));
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
