import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface LlmUsageEvent {
  agent: string;
  model: string;
  runId?: string;
  taskId?: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  costUsd?: number;
  ts: string;
}

export interface LlmUsageModelRollup {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
  lastActiveAt: string | null;
}

export interface LlmUsageDayRollup {
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
  lastActiveAt: string | null;
  byModel: LlmUsageModelRollup[];
}

export interface LlmUsageSourceStatus {
  agent: string;
  status: "recorded" | "not_reported";
  reason?: string;
}

export interface LlmUsageActiveCall {
  id: string;
  agent: string;
  model: string;
  startedAt: string;
  runId?: string;
  taskId?: string;
}

/** One per-model line in the recent (live) usage window. `points` are per-minute
 *  total-token sums, oldest→newest, length === windowMinutes. */
export interface LlmUsageRecentSeries {
  agent: string;
  model: string;
  points: number[];
}

/** A real, live "tokens/min · per model" window built from event timestamps.
 *  null when there is no clock to anchor the window or no events fell in it. */
export interface LlmUsageRecent {
  windowMinutes: number;
  endsAt: string;
  series: LlmUsageRecentSeries[];
}

export interface LlmUsageAggregate {
  status: "recorded" | "not_recorded";
  message: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
  lastActiveAt: string | null;
  byModel: LlmUsageModelRollup[];
  byDay: LlmUsageDayRollup[];
  sourceStatus: LlmUsageSourceStatus[];
  activeCalls: LlmUsageActiveCall[];
  /** Live per-minute per-model series for the recent window (null when idle). */
  recent: LlmUsageRecent | null;
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
  activeCalls?: readonly LlmUsageActiveCall[];
  /** Anchor for the live "recent" window (server passes new Date()); when
   *  omitted, `recent` is null (no clock to build a last-N-minutes window). */
  now?: Date;
  /** Recent-window length in minutes (default 60). */
  recentWindowMinutes?: number;
}

export interface LlmUsageActiveCallInput {
  agent: string;
  model?: string;
  runId?: string;
  taskId?: string;
  startedAt?: Date;
}

const DEFAULT_USAGE_LOG_PATH = "/data/llm-usage.jsonl";
const DEFAULT_EXPECTED_AGENTS = ["claude", "test-writer", "security", "docs", "codex", "hermes"] as const;
const DEFAULT_SOURCE_REASONS: Readonly<Record<string, string>> = {
  claude: "Claude Agent SDK usage counters have not arrived from runner output yet.",
  "test-writer": "Test-writer SDK usage counters have not arrived from runner output yet.",
  security: "Security specialist SDK usage counters have not arrived from runner output yet.",
  docs: "Docs specialist SDK usage counters have not arrived from runner output yet.",
  codex: "Codex CLI does not report usage.",
  hermes: "Hermes monitor replies may be templated when OLLAMA_API_KEY is unset; live Hermes agent usage is recorded from post_llm_call traces when provider counters are present.",
};

const activeCalls = new Map<string, LlmUsageActiveCall>();
let nextActiveCallId = 0;

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

export function beginLlmUsageCall(input: LlmUsageActiveCallInput): () => void {
  const agent = input.agent.trim();
  if (!agent) return () => undefined;
  const id = `llm-call-${Date.now()}-${++nextActiveCallId}`;
  const call: LlmUsageActiveCall = {
    id,
    agent,
    model: input.model?.trim() || `${agent} model pending`,
    startedAt: (input.startedAt ?? new Date()).toISOString(),
    ...(input.runId ? { runId: input.runId.trim() } : {}),
    ...(input.taskId ? { taskId: input.taskId.trim() } : {}),
  };
  activeCalls.set(id, call);
  return () => {
    activeCalls.delete(id);
  };
}

export function listActiveLlmUsageCalls(): LlmUsageActiveCall[] {
  return Array.from(activeCalls.values()).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function llmUsageEventFromResult(input: LlmUsageCaptureInput): LlmUsageEvent | undefined {
  const usageSource = firstUsageSource(
    tokenUsageSource(input.result),
    usageSourceFromRecord(input.result),
    usageSourceFromRecord(recordField(input.result, "message")),
    usageSourceFromArrayField(input.result, "choices"),
    usageSourceFromNestedArrayField(input.result, "choices", "message"),
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
    ?? integerField(usage, "inputTokenCount")
    ?? integerField(usage, "promptTokens")
    ?? integerField(usage, "prompt_tokens")
    ?? integerField(usage, "promptTokenCount")
    ?? integerField(usage, "prompt_eval_count")
    ?? integerField(usage, "promptEvalCount");
  const outputTokens = integerField(usage, "outputTokens")
    ?? integerField(usage, "output_tokens")
    ?? integerField(usage, "outputTokenCount")
    ?? integerField(usage, "completionTokens")
    ?? integerField(usage, "completion_tokens")
    ?? integerField(usage, "completionTokenCount")
    ?? integerField(usage, "eval_count")
    ?? integerField(usage, "evalCount");
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cacheTokens = cacheTokensFromUsage(usage);
  const costUsd = numberField(usage, "costUsd")
    ?? numberField(usage, "cost_usd")
    ?? numberField(usage, "total_cost_usd")
    ?? numberField(carrier, "costUsd")
    ?? numberField(carrier, "cost_usd")
    ?? numberField(carrier, "total_cost_usd")
    ?? numberField(input.result, "costUsd")
    ?? numberField(input.result, "cost_usd")
    ?? numberField(input.result, "total_cost_usd");

  const model = stringField(usage, "model")
    ?? stringField(carrier, "model")
    ?? stringField(carrier, "modelId")
    ?? stringField(input.result, "model")
    ?? stringField(input.result, "modelId")
    ?? input.model
    ?? "not_recorded";

  const event: LlmUsageEvent = {
    agent: input.agent,
    model,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    inputTokens,
    outputTokens,
    ...(cacheTokens > 0 ? { cacheTokens } : {}),
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
  const recent = buildRecent(events, options.now, options.recentWindowMinutes ?? 60);
  const status = events.length > 0 ? "recorded" : "not_recorded";
  return {
    status,
    message: status === "recorded"
      ? "LLM usage includes only runner results that emitted whitelisted token counters."
      : "No LLM usage counters have been recorded yet. Sources stay not reported until a real provider or runner emits whitelisted counters.",
    ...total,
    runs: events.length,
    byModel,
    byDay,
    sourceStatus,
    activeCalls: [...(options.activeCalls ?? [])],
    recent,
  };
}

/**
 * Build the live "tokens/min · per model" window from real event timestamps.
 * Returns null when there's no clock to anchor the window or no event fell in
 * it — so the UI honestly falls back to the daily view instead of a flat fake.
 */
function buildRecent(
  events: readonly LlmUsageEvent[],
  now: Date | undefined,
  windowMinutes: number,
): LlmUsageRecent | null {
  if (!now || !Number.isFinite(now.getTime()) || windowMinutes <= 0) return null;
  const end = now.getTime();
  const start = end - windowMinutes * 60_000;
  const byKey = new Map<string, number[]>();
  for (const event of events) {
    const t = Date.parse(event.ts);
    if (!Number.isFinite(t) || t < start || t > end) continue;
    let idx = Math.floor((t - start) / 60_000);
    if (idx < 0) idx = 0;
    if (idx >= windowMinutes) idx = windowMinutes - 1;
    const key = `${event.agent} ${event.model}`;
    let points = byKey.get(key);
    if (!points) {
      points = new Array<number>(windowMinutes).fill(0);
      byKey.set(key, points);
    }
    points[idx] += event.inputTokens + event.outputTokens + (event.cacheTokens ?? 0);
  }
  if (byKey.size === 0) return null;
  const series = Array.from(byKey.entries())
    .map(([key, points]) => {
      const [agent = "unknown", model = "not_recorded"] = key.split(" ");
      return { agent, model, points };
    })
    .sort((a, b) => sumPoints(b.points) - sumPoints(a.points) || a.agent.localeCompare(b.agent) || a.model.localeCompare(b.model));
  return { windowMinutes, endsAt: new Date(end).toISOString(), series };
}

function sumPoints(points: readonly number[]): number {
  return points.reduce((sum, value) => sum + value, 0);
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
    ...(entry.cacheTokens > 0 ? { cacheTokens: entry.cacheTokens } : {}),
    ...(entry.costUsd !== null ? { costUsd: entry.costUsd } : {}),
    ts: entry.lastActiveAt ?? "1970-01-01T00:00:00.000Z",
  }));
  const total = totalsFor(events);
  return {
    status: byModel.length > 0 ? "recorded" : "not_recorded",
    message: byModel.length > 0
      ? "LLM usage includes only runner results that emitted whitelisted token counters."
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
    activeCalls: aggregate.activeCalls.filter((call) => call.agent === agent),
    recent: null,
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

function totalsFor(events: readonly Pick<LlmUsageEvent, "inputTokens" | "outputTokens" | "cacheTokens" | "costUsd" | "ts">[]) {
  const inputTokens = events.reduce((sum, event) => sum + event.inputTokens, 0);
  const outputTokens = events.reduce((sum, event) => sum + event.outputTokens, 0);
  const cacheTokens = events.reduce((sum, event) => sum + (event.cacheTokens ?? 0), 0);
  const costEvents = events.filter((event) => typeof event.costUsd === "number");
  const costUsd = costEvents.length > 0
    ? round(costEvents.reduce((sum, event) => sum + (event.costUsd ?? 0), 0), 6)
    : null;
  return {
    inputTokens,
    outputTokens,
    cacheTokens,
    totalTokens: inputTokens + outputTokens + cacheTokens,
    costUsd,
    costStatus: costEvents.length > 0 ? "recorded" as const : "not_recorded" as const,
    lastActiveAt: lastActiveAtFor(events),
  };
}

function sanitizeUsageEvent(event: LlmUsageEvent): LlmUsageEvent | undefined {
  if (!event.agent.trim() || !event.model.trim()) return undefined;
  if (!Number.isInteger(event.inputTokens) || event.inputTokens < 0) return undefined;
  if (!Number.isInteger(event.outputTokens) || event.outputTokens < 0) return undefined;
  if (event.cacheTokens !== undefined && (!Number.isInteger(event.cacheTokens) || event.cacheTokens < 0)) return undefined;
  if (event.costUsd !== undefined && (!Number.isFinite(event.costUsd) || event.costUsd < 0)) return undefined;
  if (!Number.isFinite(Date.parse(event.ts))) return undefined;
  return {
    agent: event.agent.trim(),
    model: event.model.trim(),
    ...(event.runId ? { runId: event.runId.trim() } : {}),
    ...(event.taskId ? { taskId: event.taskId.trim() } : {}),
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.cacheTokens !== undefined ? { cacheTokens: event.cacheTokens } : {}),
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
      ...(integerField(parsed, "cacheTokens") !== undefined ? { cacheTokens: integerField(parsed, "cacheTokens") } : {}),
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
  return usage && hasTokenCounts(usage) ? { usage, carrier: value } : undefined;
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

function usageSourceFromNestedArrayField(value: unknown, key: string, nestedKey: string): UsageSource | undefined {
  if (!isRecord(value) || !Array.isArray(value[key])) return undefined;
  for (const item of value[key]) {
    const source = usageSourceFromRecord(recordField(item, nestedKey)) ?? tokenUsageSource(recordField(item, nestedKey));
    if (source) return source;
  }
  return undefined;
}

function explicitUsageSource(value: unknown): UsageSource | undefined {
  const usage = explicitUsageJson(value);
  if (usage) return { usage, carrier: usage };
  const parsed = explicitUsageText(value);
  return parsed ? { usage: parsed, carrier: parsed } : undefined;
}

function hasTokenCounts(record: Record<string, unknown>): boolean {
  const inputTokens = integerField(record, "inputTokens")
    ?? integerField(record, "input_tokens")
    ?? integerField(record, "inputTokenCount")
    ?? integerField(record, "promptTokens")
    ?? integerField(record, "prompt_tokens")
    ?? integerField(record, "promptTokenCount")
    ?? integerField(record, "prompt_eval_count")
    ?? integerField(record, "promptEvalCount");
  const outputTokens = integerField(record, "outputTokens")
    ?? integerField(record, "output_tokens")
    ?? integerField(record, "outputTokenCount")
    ?? integerField(record, "completionTokens")
    ?? integerField(record, "completion_tokens")
    ?? integerField(record, "completionTokenCount")
    ?? integerField(record, "eval_count")
    ?? integerField(record, "evalCount");
  return inputTokens !== undefined && outputTokens !== undefined;
}

function cacheTokensFromUsage(usage: Record<string, unknown>): number {
  const explicit = integerField(usage, "cacheTokens")
    ?? integerField(usage, "cache_tokens");
  if (explicit !== undefined) return explicit;
  const detailsCache = integerField(recordField(usage, "prompt_tokens_details"), "cached_tokens")
    ?? integerField(recordField(usage, "input_tokens_details"), "cached_tokens");
  return [
    integerField(usage, "cacheReadInputTokens"),
    integerField(usage, "cache_read_input_tokens"),
    integerField(usage, "cacheCreationInputTokens"),
    integerField(usage, "cache_creation_input_tokens"),
    detailsCache,
  ].reduce<number>((sum, value) => sum + (value ?? 0), 0);
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

function explicitUsageText(value: unknown): Record<string, unknown> | undefined {
  const stdout = isRecord(value) && typeof value.stdout === "string" ? value.stdout : "";
  const stderr = isRecord(value) && typeof value.stderr === "string" ? value.stderr : "";
  const text = `${stdout}\n${stderr}`;
  const inputTokens = tokenCountFromText(text, /(?:input|prompt)\s+tokens?\D+([\d,]+)/i);
  const outputTokens = tokenCountFromText(text, /(?:output|completion)\s+tokens?\D+([\d,]+)/i);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const model = text.match(/\bmodel(?:\s+id)?\s*[:=]\s*([A-Za-z0-9_.:\/-]+)/i)?.[1];
  return {
    inputTokens,
    outputTokens,
    ...(model ? { model } : {}),
  };
}

function tokenCountFromText(text: string, pattern: RegExp): number | undefined {
  const match = text.match(pattern);
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integerField(record: unknown, key: string): number | undefined {
  const value = numberField(record, key);
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function lastActiveAtFor(events: readonly Pick<LlmUsageEvent, "ts">[]): string | null {
  let latest = "";
  for (const event of events) {
    if (event.ts > latest) latest = event.ts;
  }
  return latest || null;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
