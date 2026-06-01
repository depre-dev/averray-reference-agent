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

export interface LlmUsageSourceStatus {
  agent: string;
  status: "recorded" | "not_reported";
  reason?: string;
}

export interface LlmUsageAggregate {
  status: "recorded" | "not_recorded";
  message: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
  byModel: LlmUsageModelRollup[];
  byDay: LlmUsageDayRollup[];
  sourceStatus: LlmUsageSourceStatus[];
}

export interface LlmUsageCaptureInput {
  agent: string;
  model?: string;
  runId?: string;
  taskId?: string;
  ts?: Date;
  result: unknown;
}

export interface LlmUsageAggregateOptions {
  expectedAgents?: readonly string[];
  sourceReasons?: Readonly<Record<string, string>>;
}

const DEFAULT_USAGE_LOG_PATH = "/data/llm-usage.jsonl";
const DEFAULT_EXPECTED_AGENTS = ["claude", "test-writer", "codex", "hermes"] as const;
const DEFAULT_SOURCE_REASONS: Readonly<Record<string, string>> = {
  claude: "Claude Agent SDK usage counters have not arrived from runner output yet.",
  "test-writer": "Test-writer SDK usage counters have not arrived from runner output yet.",
  codex: "Codex usage is not reported by the CLI yet.",
  hermes: "Hermes/Ollama responses have not exposed usage counters yet.",
};

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
  const usageSource = firstUsageSource(
    tokenUsageSource(input.result),
    usageSourceFromRecord(input.result),
    usageSourceFromRecord(recordField(input.result, "response")),
    usageSourceFromRecord(recordField(input.result, "result")),
    usageSourceFromArrayField(input.result, "messages"),
    usageSourceFromArrayField(input.result, "events"),
    explicitUsageSource(input.result)
  );
  if (!usageSource) return undefined;
  const { usage, carrier } = usageSource;

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
    ?? stringField(carrier, "model")
    ?? stringField(carrier, "modelId")
    ?? stringField(input.result, "model")
    ?? stringField(input.result, "modelId")
    ?? input.model
    ?? "not_recorded";
  const costUsd = numberField(usage, "costUsd")
    ?? numberField(usage, "cost_usd")
    ?? numberField(usage, "total_cost_usd")
    ?? numberField(carrier, "costUsd")
    ?? numberField(carrier, "cost_usd")
    ?? numberField(carrier, "totalCostUsd")
    ?? numberField(carrier, "total_cost_usd")
    ?? numberField(input.result, "costUsd")
    ?? numberField(input.result, "cost_usd")
    ?? numberField(input.result, "totalCostUsd")
    ?? numberField(input.result, "total_cost_usd");

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

export function aggregateLlmUsage(
  events: readonly LlmUsageEvent[] = [],
  options: LlmUsageAggregateOptions = {}
): LlmUsageAggregate {
  const byModel = rollupByModel(events);
  const byDay = rollupByDay(events);
  const total = totalsFor(events);
  const sourceStatus = sourceStatuses(events, options);
  const status = events.length > 0 ? "recorded" : "not_recorded";
  return {
    status,
    message: status === "recorded"
      ? "LLM usage includes only runner results that emitted whitelisted cost/token counters."
      : "No runner has reported LLM usage counters yet. Claude/test-writer counters depend on SDK output; Codex CLI and Hermes/Ollama do not reliably report usage today.",
    ...total,
    runs: events.length,
    byModel,
    byDay,
    sourceStatus,
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
    message: byModel.length > 0
      ? "LLM usage includes only runner results that emitted whitelisted cost/token counters."
      : sourceReason(agent, undefined),
    ...total,
    runs: byModel.reduce((sum, entry) => sum + entry.runs, 0),
    byModel,
    byDay: [],
    sourceStatus: [{
      agent,
      status: byModel.length > 0 ? "recorded" : "not_reported",
      ...(byModel.length > 0 ? {} : { reason: sourceReason(agent, undefined) }),
    }],
  };
}

function sourceStatuses(
  events: readonly LlmUsageEvent[],
  options: LlmUsageAggregateOptions
): LlmUsageSourceStatus[] {
  const recorded = new Set(events.map((event) => event.agent));
  const expectedAgents = uniqueStrings([
    ...(options.expectedAgents ?? DEFAULT_EXPECTED_AGENTS),
    ...recorded,
  ]);
  return expectedAgents.map((agent) => ({
    agent,
    status: recorded.has(agent) ? "recorded" as const : "not_reported" as const,
    ...(recorded.has(agent) ? {} : { reason: sourceReason(agent, options.sourceReasons) }),
  }));
}

function sourceReason(agent: string, overrides?: Readonly<Record<string, string>>): string {
  return overrides?.[agent]
    ?? DEFAULT_SOURCE_REASONS[agent]
    ?? `${agent} usage counters have not arrived from runner output yet.`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort();
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

interface UsageSource {
  usage: Record<string, unknown>;
  carrier: Record<string, unknown>;
}

function usageSourceFromRecord(value: unknown): UsageSource | undefined {
  if (!isRecord(value)) return undefined;
  const usage = recordField(value, "usage");
  return usage ? { usage, carrier: value } : undefined;
}

function tokenUsageSource(value: unknown): UsageSource | undefined {
  if (!isRecord(value)) return undefined;
  return hasTokenCounts(value) ? { usage: value, carrier: value } : undefined;
}

function usageSourceFromArrayField(value: unknown, key: string): UsageSource | undefined {
  if (!isRecord(value) || !Array.isArray(value[key])) return undefined;
  for (const item of value[key]) {
    const source = usageSourceFromRecord(item) ?? tokenUsageSource(item);
    if (source) return source;
  }
  return undefined;
}

function explicitUsageSource(value: unknown): UsageSource | undefined {
  const usage = explicitUsageJson(value);
  return usage ? { usage, carrier: usage } : undefined;
}

function hasTokenCounts(record: Record<string, unknown>): boolean {
  const inputTokens = integerField(record, "inputTokens")
    ?? integerField(record, "input_tokens")
    ?? integerField(record, "promptTokens")
    ?? integerField(record, "prompt_tokens");
  const outputTokens = integerField(record, "outputTokens")
    ?? integerField(record, "output_tokens")
    ?? integerField(record, "completionTokens")
    ?? integerField(record, "completion_tokens");
  return inputTokens !== undefined && outputTokens !== undefined;
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

function firstUsageSource(...values: Array<UsageSource | undefined>): UsageSource | undefined {
  return values.find((value): value is UsageSource => Boolean(value));
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
