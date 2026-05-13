import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HandoffEventStatus =
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "passed"
  | "needs_review";

export interface HandoffEventInput {
  correlationId: string;
  requester?: string;
  intent?: string;
  phase: string;
  status: HandoffEventStatus;
  repo?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  testCaseId?: string;
  testCaseIds?: string[];
  reason?: string;
  summary?: Record<string, unknown>;
  safety?: Record<string, unknown>;
  timestamp?: string;
}

export interface HandoffEvent extends HandoffEventInput {
  schemaVersion: 1;
  kind: "agent_handoff_event";
  eventId: string;
  timestamp: string;
}

export interface HandoffMonitorOptions {
  correlationId?: string;
  limit?: number;
  activeWindowMinutes?: number;
  now?: Date;
  eventLogPath?: string;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_ACTIVE_WINDOW_MINUTES = 120;
const ACTIVE_LINGER_MINUTES = 3;

export async function recordHandoffEvent(input: HandoffEventInput): Promise<HandoffEvent> {
  const event: HandoffEvent = {
    schemaVersion: 1,
    kind: "agent_handoff_event",
    eventId: makeEventId(input.timestamp),
    ...input,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  const path = handoffEventLogPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(event)}\n`, { flag: "a" });
  return event;
}

export async function getHandoffMonitor(options: HandoffMonitorOptions = {}) {
  const limit = clampInt(options.limit ?? DEFAULT_LIMIT, 1, 100);
  const now = options.now ?? new Date();
  const events = await readHandoffEvents(options.eventLogPath ?? handoffEventLogPath());
  const filtered = options.correlationId
    ? events.filter((event) => event.correlationId === options.correlationId)
    : events;
  const sorted = filtered
    .slice()
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const grouped = groupByCorrelation(sorted);
  const activeWindowMs = clampInt(
    options.activeWindowMinutes ?? DEFAULT_ACTIVE_WINDOW_MINUTES,
    1,
    24 * 60
  ) * 60_000;
  const summaries = Array.from(grouped.values()).map((group) => summarizeCorrelation(group, now));
  const active = summaries.filter((summary) => isVisibleActive(summary, now, activeWindowMs));
  const running = active.filter((summary) => summary.activeState === "running").length;
  const justFinished = active.filter((summary) => summary.activeState === "just_finished").length;

  return {
    schemaVersion: 1,
    kind: "agent_handoff_monitor",
    generatedAt: now.toISOString(),
    status: running > 0 ? "active" : justFinished > 0 ? "recently_active" : "idle",
    source: "local_handoff_event_log",
    filter: {
      correlationId: options.correlationId ?? null,
      limit,
      activeWindowMinutes: options.activeWindowMinutes ?? DEFAULT_ACTIVE_WINDOW_MINUTES,
    },
    counts: {
      events: filtered.length,
      correlations: summaries.length,
      active: active.length,
      running,
      justFinished,
      recent: Math.min(summaries.length, limit),
    },
    active: active.slice(0, limit),
    recent: summaries.slice(0, limit),
    safety: {
      readOnly: true,
      githubMutated: false,
      wikipediaEdited: false,
      freeFormHermesPromptUsed: false,
    },
  };
}

export function summarizeHandoffResult(result: unknown): Record<string, unknown> {
  const record = isRecord(result) ? result : {};
  const nestedResult = isRecord(record.result) ? record.result : {};
  const summary = isRecord(record.summary)
    ? record.summary
    : isRecord(nestedResult.summary)
      ? nestedResult.summary
      : undefined;
  const safety = isRecord(record.safety)
    ? record.safety
    : isRecord(nestedResult.safety)
      ? nestedResult.safety
      : undefined;

  return compactRecord({
    kind: stringField(record, "kind") ?? stringField(nestedResult, "kind"),
    status: stringField(record, "status") ?? stringField(nestedResult, "status"),
    reason: stringField(record, "reason") ?? stringField(nestedResult, "finalReason"),
    finalReason: stringField(nestedResult, "finalReason"),
    finalVerdict: stringField(nestedResult, "finalVerdict"),
    mergeRecommendation: firstDeepString(nestedResult, [
      ["github", "mergeRecommendation"],
      ["github", "merge_recommendation"],
    ]),
    reviewReasons: githubReviewReasons(nestedResult),
    requestedCaseIds: arrayField(nestedResult, "requestedCaseIds"),
    summary,
    safety,
  });
}

export function summarizeHandoffError(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.message : String(error),
  };
}

async function readHandoffEvents(path: string): Promise<HandoffEvent[]> {
  let content = "";
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseEventLine)
    .filter((event): event is HandoffEvent => event !== null);
}

function parseEventLine(line: string): HandoffEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) return null;
    if (value.kind !== "agent_handoff_event") return null;
    const correlationId = stringField(value, "correlationId");
    const timestamp = stringField(value, "timestamp");
    const phase = stringField(value, "phase");
    const status = stringField(value, "status");
    if (!correlationId || !timestamp || !phase || !status) return null;
    return value as unknown as HandoffEvent;
  } catch {
    return null;
  }
}

function groupByCorrelation(eventsNewestFirst: HandoffEvent[]) {
  const groups = new Map<string, HandoffEvent[]>();
  for (const event of eventsNewestFirst) {
    const group = groups.get(event.correlationId) ?? [];
    group.push(event);
    groups.set(event.correlationId, group);
  }
  return groups;
}

function summarizeCorrelation(eventsNewestFirst: HandoffEvent[], now: Date) {
  const latest = eventsNewestFirst[0];
  const oldest = eventsNewestFirst[eventsNewestFirst.length - 1];
  const status = latest?.status ?? "completed";
  const sawRunning = eventsNewestFirst.some((event) => event.status === "running");
  const active = status === "running";
  const updatedAt = latest?.timestamp ?? now.toISOString();
  return {
    correlationId: latest?.correlationId ?? "unknown",
    requester: latest?.requester ?? oldest?.requester ?? null,
    intent: latest?.intent ?? oldest?.intent ?? null,
    repo: latest?.repo ?? oldest?.repo ?? null,
    pullRequestNumber: latest?.pullRequestNumber ?? oldest?.pullRequestNumber ?? null,
    pullRequestUrl: latest?.pullRequestUrl ?? oldest?.pullRequestUrl ?? null,
    testCaseIds: latest?.testCaseIds ?? oldest?.testCaseIds ?? [],
    reason: latest?.reason ?? oldest?.reason ?? null,
    status,
    phase: latest?.phase ?? "unknown",
    active,
    activeState: active
      ? "running"
      : sawRunning && isTerminalStatus(status) && now.getTime() - Date.parse(updatedAt) <= ACTIVE_LINGER_MINUTES * 60_000
        ? "just_finished"
        : "inactive",
    startedAt: oldest?.timestamp ?? now.toISOString(),
    updatedAt,
    eventCount: eventsNewestFirst.length,
    summary: latest?.summary ?? null,
    safety: latest?.safety ?? null,
  };
}

function isVisibleActive(
  summary: { activeState?: string; updatedAt: string },
  now: Date,
  activeWindowMs: number
): boolean {
  const ageMs = now.getTime() - Date.parse(summary.updatedAt);
  if (ageMs > activeWindowMs) return false;
  return summary.activeState === "running" || summary.activeState === "just_finished";
}

function isTerminalStatus(status: string): boolean {
  return status === "completed"
    || status === "passed"
    || status === "blocked"
    || status === "failed"
    || status === "needs_review";
}

function handoffEventLogPath(): string {
  return process.env.AVERRAY_HANDOFF_EVENTS_PATH
    ?? "/tmp/averray-reference-agent/handoff-events.jsonl";
}

function makeEventId(timestamp?: string): string {
  const stamp = (timestamp ?? new Date().toISOString()).replace(/[^0-9A-Za-z]/g, "");
  return `handoff-event-${stamp}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function arrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function firstDeepString(record: Record<string, unknown>, paths: string[][]): string | undefined {
  for (const path of paths) {
    let value: unknown = record;
    for (const key of path) {
      value = isRecord(value) ? value[key] : undefined;
    }
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function githubReviewReasons(record: Record<string, unknown>): Record<string, unknown>[] | undefined {
  const github = isRecord(record.github) ? record.github : undefined;
  const findings = Array.isArray(github?.riskFindings) ? github.riskFindings : [];
  const reviewReasons = findings
    .filter(isRecord)
    .filter((finding) => stringField(finding, "code") !== "pr_review_green")
    .slice(0, 5)
    .map((finding) => compactRecord({
      severity: stringField(finding, "severity"),
      code: stringField(finding, "code"),
      message: stringField(finding, "message"),
    }));
  return reviewReasons.length > 0 ? reviewReasons : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
