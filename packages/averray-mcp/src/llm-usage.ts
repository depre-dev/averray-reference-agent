import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LlmUsageEvent {
  agent: string;
  model: string;
  runId?: string;
  taskId?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  ts: string;
}

export interface LlmUsageModelRollup {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
}

export interface LlmUsageDayRollup {
  day: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
  byModel: LlmUsageModelRollup[];
}

export interface LlmUsageAggregate {
  status: "recorded" | "not_recorded";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
  byModel: LlmUsageModelRollup[];
  byDay: LlmUsageDayRollup[];
}

export interface LlmUsageCaptureInput {
  agent: string;
  model?: string;
  runId?: string;
  taskId?: string;
  ts?: Date;
  result: unknown;
}

const DEFAULT_USAGE_LOG_PATH = "/data/llm-usage.jsonl";

export function llmUsageLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLM_USAGE_LOG_PATH?.trim() || env.AVERRAY_LLM_USAGE_LOG_PATH?.trim() || DEFAULT_USAGE_LOG_PATH;
}

export async function appendLlmUsageEvent(
  event: LlmUsageEvent,
  options: { path?: string } = {}
): Promise<void> {
  const path = options.path ?? llmUsageLogPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, "utf8");
}

export async function readLlmUsageEvents(path: string = llmUsageLogPath()): Promise<LlmUsageEvent[]> {
  try {
    const content = await readFile(path, "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseUsageLine(line))
      .filter((event): event is LlmUsageEvent => Boolean(event));
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
}

export async function recordLlmUsageFromResult(
  input: LlmUsageCaptureInput,
  options: { path?: string } = {}
): Promise<LlmUsageEvent | undefined> {
  const event = llmUsageEventFromResult(input);
  if (!event) return undefined;
  await appendLlmUsageEvent(event, options);
  return event;
}

export function llmUsageEventFromResult(input: LlmUsageCaptureInput): LlmUsageEvent | undefined {
  const usage = firstRecord(
    recordField(input.result, "usage"),
    recordField(recordField(input.result, "response"), "usage"),
    recordField(recordField(input.result, "result"), "usage"),
    explicitUsageJson(input.result)
  );
  if (!usage) return undefined;

  const inputTokens = integerField(usage, "inputTokens")
    ?? integerField(usage, "input_tokens")
    ?? integerField(usage, "promptTokens")
    ?? integerField(usage, "prompt_tokens");
  const outputTokens = integerField(usage, "outputTokens")
    ?? integerField(usage, "output_tokens")
    ?? integerField(usage, "completionTokens")
    ?? integerField(usage, "completion_tokens");
  if (inputTokens === undefined || outputTokens === undefined) return undefined;

  const model = stringField(usage, "model")
    ?? stringField(input.result, "model")
    ?? stringField(input.result, "modelId")
    ?? input.model
    ?? "not_recorded";
  const costUsd = numberField(usage, "costUsd")
    ?? numberField(usage, "cost_usd")
    ?? numberField(input.result, "costUsd")
    ?? numberField(input.result, "totalCostUsd");

  const event: LlmUsageEvent = {
    agent: input.agent,
    model,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    inputTokens,
    outputTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
    ts: (input.ts ?? new Date()).toISOString(),
  };
  return sanitizeUsageEvent(event);
}

export function aggregateLlmUsage(events: readonly LlmUsageEvent[] = []): LlmUsageAggregate {
  const byModel = rollupByModel(events);
  const byDay = rollupByDay(events);
  const total = totalsFor(events);
  return {
    status: events.length > 0 ? "recorded" : "not_recorded",
    ...total,
    runs: events.length,
    byModel,
    byDay,
  };
}

export function aggregateLlmUsageForAgent(
  aggregate: LlmUsageAggregate,
  agent: string
): LlmUsageAggregate {
  const byModel = aggregate.byModel.filter((entry) => entry.agent === agent);
  const events = byModel.map((entry) => ({
    agent: entry.agent,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    ...(entry.costUsd !== null ? { costUsd: entry.costUsd } : {}),
    ts: "1970-01-01T00:00:00.000Z",
  }));
  const total = totalsFor(events);
  return {
    status: byModel.length > 0 ? "recorded" : "not_recorded",
    ...total,
    runs: byModel.reduce((sum, entry) => sum + entry.runs, 0),
    byModel,
    byDay: [],
  };
}

function rollupByModel(events: readonly LlmUsageEvent[]): LlmUsageModelRollup[] {
  const groups = new Map<string, LlmUsageEvent[]>();
  for (const event of events) {
    const key = `${event.agent}\u0000${event.model}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return Array.from(groups.entries())
    .map(([key, group]) => {
      const [agent = "unknown", model = "not_recorded"] = key.split("\u0000");
      return { agent, model, ...totalsFor(group), runs: group.length };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
}

function rollupByDay(events: readonly LlmUsageEvent[]): LlmUsageDayRollup[] {
  const groups = new Map<string, LlmUsageEvent[]>();
  for (const event of events) {
    const day = event.ts.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), event]);
  }
  return Array.from(groups.entries())
    .map(([day, group]) => ({
      day,
      ...totalsFor(group),
      runs: group.length,
      byModel: rollupByModel(group),
    }))
    .sort((a, b) => b.day.localeCompare(a.day));
}

function totalsFor(events: readonly Pick<LlmUsageEvent, "inputTokens" | "outputTokens" | "costUsd">[]) {
  const inputTokens = events.reduce((sum, event) => sum + event.inputTokens, 0);
  const outputTokens = events.reduce((sum, event) => sum + event.outputTokens, 0);
  const costEvents = events.filter((event) => typeof event.costUsd === "number");
  const costUsd = costEvents.length > 0
    ? round(costEvents.reduce((sum, event) => sum + (event.costUsd ?? 0), 0), 6)
    : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    costStatus: costEvents.length > 0 ? "recorded" as const : "not_recorded" as const,
  };
}

function sanitizeUsageEvent(event: LlmUsageEvent): LlmUsageEvent | undefined {
  if (!event.agent.trim() || !event.model.trim()) return undefined;
  if (!Number.isInteger(event.inputTokens) || event.inputTokens < 0) return undefined;
  if (!Number.isInteger(event.outputTokens) || event.outputTokens < 0) return undefined;
  if (event.costUsd !== undefined && (!Number.isFinite(event.costUsd) || event.costUsd < 0)) return undefined;
  if (!Number.isFinite(Date.parse(event.ts))) return undefined;
  return {
    agent: event.agent.trim(),
    model: event.model.trim(),
    ...(event.runId ? { runId: event.runId.trim() } : {}),
    ...(event.taskId ? { taskId: event.taskId.trim() } : {}),
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.costUsd !== undefined ? { costUsd: round(event.costUsd, 6) } : {}),
    ts: new Date(event.ts).toISOString(),
  };
}

function parseUsageLine(line: string): LlmUsageEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return undefined;
    return sanitizeUsageEvent({
      agent: stringField(parsed, "agent") ?? "",
      model: stringField(parsed, "model") ?? "",
      ...(stringField(parsed, "runId") ? { runId: stringField(parsed, "runId") } : {}),
      ...(stringField(parsed, "taskId") ? { taskId: stringField(parsed, "taskId") } : {}),
      inputTokens: integerField(parsed, "inputTokens") ?? -1,
      outputTokens: integerField(parsed, "outputTokens") ?? -1,
      ...(numberField(parsed, "costUsd") !== undefined ? { costUsd: numberField(parsed, "costUsd") } : {}),
      ts: stringField(parsed, "ts") ?? "",
    });
  } catch {
    return undefined;
  }
}

function explicitUsageJson(value: unknown): Record<string, unknown> | undefined {
  const stdout = isRecord(value) && typeof value.stdout === "string" ? value.stdout : "";
  const stderr = isRecord(value) && typeof value.stderr === "string" ? value.stderr : "";
  const match = `${stdout}\n${stderr}`.match(/(?:^|\n)LLM_USAGE_JSON:\s*(\{[^\n]+\})/);
  if (!match?.[1]) return undefined;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function firstRecord(...values: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
  return values.find((value): value is Record<string, unknown> => Boolean(value));
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function stringField(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(record: unknown, key: string): number | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerField(record: unknown, key: string): number | undefined {
  const value = numberField(record, key);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
