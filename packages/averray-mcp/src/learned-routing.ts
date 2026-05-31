import type { RoutingAgent, RoutingDecision, RoutingInput } from "./dispatch-routing.js";

export interface LearnedRoutingConfig {
  minSamples: number;
  decayHalfLifeDays: number;
  explorationRate: number;
}

export interface LearnedRoutingOptions {
  scorecard?: unknown;
  config?: Partial<LearnedRoutingConfig>;
  now?: Date;
  rng?: () => number;
}

interface CandidateScore {
  agent: RoutingAgent;
  score: number;
  samples: number;
  effectiveSamples: number;
  readyRate: number | null;
}

interface SurfaceSignal {
  count: number;
  readyRate: number | null;
  ciPassRate: number | null;
  blockedRate: number | null;
  reworkRate: number | null;
  revertRate: number | null;
  operatorOverrideRate: number | null;
  observedAt: string | null;
}

interface AgentBaseline {
  mergeRate: number | null;
  ciPassRate: number | null;
  taskSuccessRate: number | null;
  reworkRate: number | null;
  revertRate: number | null;
  operatorOverrideRate: number | null;
}

export const DEFAULT_LEARNED_ROUTING_CONFIG: LearnedRoutingConfig = {
  minSamples: 8,
  decayHalfLifeDays: 14,
  explorationRate: 0.02,
};

const ROUTING_AGENTS: RoutingAgent[] = ["codex", "claude"];

export function parseLearnedRoutingConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<LearnedRoutingConfig> = {}
): LearnedRoutingConfig {
  const config = {
    minSamples: intFromEnv(env.A2_LEARNED_ROUTING_MIN_SAMPLES, DEFAULT_LEARNED_ROUTING_CONFIG.minSamples),
    decayHalfLifeDays: numberFromEnv(
      env.A2_LEARNED_ROUTING_DECAY_HALF_LIFE_DAYS,
      DEFAULT_LEARNED_ROUTING_CONFIG.decayHalfLifeDays
    ),
    explorationRate: numberFromEnv(env.A2_LEARNED_ROUTING_EXPLORATION_RATE, DEFAULT_LEARNED_ROUTING_CONFIG.explorationRate),
    ...overrides,
  };
  return {
    minSamples: Math.max(1, Math.floor(config.minSamples)),
    decayHalfLifeDays: Math.max(1, config.decayHalfLifeDays),
    explorationRate: clamp(config.explorationRate, 0, 1),
  };
}

export function applyLearnedRouting(
  input: RoutingInput,
  staticDecision: RoutingDecision,
  options: LearnedRoutingOptions = {}
): RoutingDecision {
  if (staticDecision.riskTier === "high") {
    return {
      agent: "codex",
      riskTier: staticDecision.riskTier,
      reason: `A2 high-risk rule-bound → codex; scorecard ignored (${staticDecision.reason})`,
    };
  }

  const config = parseLearnedRoutingConfig(undefined, options.config);
  const now = options.now ?? new Date();
  const rng = options.rng ?? Math.random;
  const surface = targetSurface(input, staticDecision);
  const candidates = ROUTING_AGENTS
    .map((agent) => scoreAgentForSurface(agent, surface, options.scorecard, config, now))
    .filter((candidate) => candidate.effectiveSamples >= config.minSamples)
    .sort((a, b) => b.score - a.score || b.effectiveSamples - a.effectiveSamples || agentSort(a.agent) - agentSort(b.agent));

  if (candidates.length === 0) {
    return {
      ...staticDecision,
      reason: `A2 cold start on ${surface} → static default (${staticDecision.reason})`,
    };
  }

  const best = candidates[0]!;
  const chosen = shouldExplore(candidates, config, rng) ? candidates[1]! : best;
  const mode = chosen.agent === best.agent ? "learned" : "exploration";
  return {
    agent: chosen.agent,
    riskTier: staticDecision.riskTier,
    reason: `${reasonPrefix(mode, chosen, surface)}; ${comparisonSummary(candidates, surface)}; static default ${staticDecision.agent}`,
  };
}

function shouldExplore(candidates: CandidateScore[], config: LearnedRoutingConfig, rng: () => number): boolean {
  return candidates.length > 1 && config.explorationRate > 0 && rng() < config.explorationRate;
}

function reasonPrefix(mode: "learned" | "exploration", chosen: CandidateScore, surface: string): string {
  const label = mode === "exploration" ? "A2 exploration" : "A2 learned routing";
  return `${label}: ${chosen.agent} on ${surface}`;
}

function comparisonSummary(candidates: CandidateScore[], surface: string): string {
  return ROUTING_AGENTS
    .map((agent) => candidates.find((candidate) => candidate.agent === agent))
    .map((candidate, index) => {
      const agent = ROUTING_AGENTS[index]!;
      if (!candidate) return `${agent} cold start on ${surface}`;
      return `${agent} ${percent(candidate.readyRate)} ready, score ${formatNumber(candidate.score)}, n=${candidate.samples}, effective=${formatNumber(candidate.effectiveSamples)}`;
    })
    .join(" vs ");
}

function scoreAgentForSurface(
  agent: RoutingAgent,
  surface: string,
  scorecard: unknown,
  config: LearnedRoutingConfig,
  now: Date
): CandidateScore {
  const agentRecord = records(isRecord(scorecard) ? scorecard.agents : undefined)
    .find((item) => stringField(item, "agent") === agent);
  if (!agentRecord) return emptyCandidate(agent);

  const baseline = agentBaseline(agentRecord);
  const matchingSignals = records(agentRecord.surfaces)
    .filter((entry) => surfaceMatches(surface, stringField(entry, "surface") ?? ""))
    .map((entry) => surfaceSignal(entry, baseline));

  if (matchingSignals.length === 0) return emptyCandidate(agent);

  let weightedScore = 0;
  let weightedReadyRate = 0;
  let readyRateWeight = 0;
  let samples = 0;
  let effectiveSamples = 0;

  for (const signal of matchingSignals) {
    if (signal.count <= 0) continue;
    const weight = recencyWeight(signal.observedAt, now, config.decayHalfLifeDays);
    const weightedSamples = signal.count * weight;
    samples += signal.count;
    effectiveSamples += weightedSamples;
    const score = signalScore(signal);
    weightedScore += score * weightedSamples;
    if (signal.readyRate !== null) {
      weightedReadyRate += signal.readyRate * weightedSamples;
      readyRateWeight += weightedSamples;
    }
  }

  if (effectiveSamples <= 0) return emptyCandidate(agent);

  return {
    agent,
    score: weightedScore / effectiveSamples,
    samples,
    effectiveSamples,
    readyRate: readyRateWeight > 0 ? weightedReadyRate / readyRateWeight : null,
  };
}

function emptyCandidate(agent: RoutingAgent): CandidateScore {
  return { agent, score: Number.NEGATIVE_INFINITY, samples: 0, effectiveSamples: 0, readyRate: null };
}

function surfaceSignal(entry: Record<string, unknown>, baseline: AgentBaseline): SurfaceSignal {
  const count = numberField(entry, "count") ?? numberField(entry, "samples") ?? numberField(entry, "total") ?? 0;
  const ready = numberField(entry, "ready") ?? numberField(entry, "merged") ?? numberField(entry, "completed");
  const blocked = numberField(entry, "blocked") ?? numberField(entry, "failed");
  return {
    count,
    readyRate: rateField(entry, ["mergeRate", "readyRate", "successRate"])
      ?? rateFromCount(ready, count)
      ?? baseline.mergeRate
      ?? baseline.taskSuccessRate,
    ciPassRate: rateField(entry, ["ciFirstPassRate", "latestPassRate"]) ?? baseline.ciPassRate,
    blockedRate: rateField(entry, ["blockedRate", "failureRate"]) ?? rateFromCount(blocked, count),
    reworkRate: rateField(entry, ["reworkRate", "laterHumanReworkRate"]) ?? baseline.reworkRate,
    revertRate: rateField(entry, ["revertRate", "rollbackRate"]) ?? baseline.revertRate,
    operatorOverrideRate: rateField(entry, ["operatorOverrideRate", "overrideRate", "operatorOverridesRate"])
      ?? baseline.operatorOverrideRate,
    observedAt: stringField(entry, "observedAt") ?? stringField(entry, "updatedAt") ?? stringField(entry, "lastSeenAt") ?? null,
  };
}

function signalScore(signal: SurfaceSignal): number {
  const positive = signal.readyRate ?? 0;
  const ciBonus = signal.ciPassRate !== null ? signal.ciPassRate * 0.15 : 0;
  const blockedPenalty = signal.blockedRate ?? 0;
  const reworkPenalty = signal.reworkRate ?? 0;
  const revertPenalty = signal.revertRate ?? 0;
  const overridePenalty = signal.operatorOverrideRate ?? 0;
  return positive + ciBonus - blockedPenalty - reworkPenalty - revertPenalty - overridePenalty;
}

function agentBaseline(agentRecord: Record<string, unknown>): AgentBaseline {
  const quality = recordField(agentRecord, "quality");
  const pullRequests = recordField(quality, "pullRequests");
  const checks = recordField(quality, "checks");
  const tasks = recordField(agentRecord, "tasks");
  const trust = recordField(agentRecord, "trust");
  const routingSignal = recordField(agentRecord, "routingSignal");
  return {
    mergeRate: rateField(pullRequests ?? {}, ["mergeRate"]),
    ciPassRate: rateField(checks ?? {}, ["ciFirstPassRate", "latestPassRate"]),
    taskSuccessRate: rateField(tasks ?? {}, ["successRate"]),
    reworkRate: rateField(trust ?? {}, ["laterHumanReworkRate", "reworkRate"]),
    revertRate: rateField(trust ?? {}, ["revertRate", "rollbackRate"]),
    operatorOverrideRate: rateField(routingSignal ?? {}, ["operatorOverrideRate", "overrideRate", "operatorOverridesRate"])
      ?? rateField(agentRecord, ["operatorOverrideRate", "overrideRate", "operatorOverridesRate"]),
  };
}

function recencyWeight(observedAt: string | null, now: Date, halfLifeDays: number): number {
  if (!observedAt) return 1;
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return 1;
  const ageMs = Math.max(0, now.getTime() - observedMs);
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  return 0.5 ** (ageMs / halfLifeMs);
}

function targetSurface(input: RoutingInput, staticDecision: RoutingDecision): string {
  const reasonSurface = staticDecision.reason.match(/^(.+?)\s*→/)?.[1]?.trim();
  if (reasonSurface && reasonSurface !== "general/ambiguous") return reasonSurface;
  return input.area?.trim() || reasonSurface || "general/ambiguous";
}

function surfaceMatches(target: string, observed: string): boolean {
  const targetAliases = surfaceAliases(target);
  const observedAliases = surfaceAliases(observed);
  for (const alias of targetAliases) {
    if (observedAliases.has(alias)) return true;
  }
  return false;
}

function surfaceAliases(value: string): Set<string> {
  const normalized = normalizeSurface(value);
  const aliases = new Set([normalized]);
  const aliasMap: Record<string, string[]> = {
    uifrontend: ["ui", "frontend", "front", "app", "operatorapp"],
    frontend: ["ui", "uifrontend", "front", "app", "operatorapp"],
    themonitor: ["monitor", "board", "drawer"],
    monitor: ["themonitor", "board", "drawer"],
    docscopy: ["docs", "documentation", "copy"],
    docs: ["docscopy", "documentation", "copy"],
    tests: ["test", "spec", "vitest"],
    refactordx: ["refactor", "dx", "cleanup"],
    mcptooling: ["mcp", "tooling", "tools"],
    generalambiguous: ["general", "ambiguous", "other"],
    other: ["generalambiguous", "general", "ambiguous"],
  };
  for (const alias of aliasMap[normalized] ?? []) aliases.add(alias);
  return aliases;
}

function normalizeSurface(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function rateField(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = numberField(record, key);
    if (value !== undefined) return clamp(value, 0, 1);
  }
  return null;
}

function rateFromCount(value: number | undefined, count: number): number | null {
  if (value === undefined || count <= 0) return null;
  return clamp(value / count, 0, 1);
}

function percent(value: number | null): string {
  if (value === null) return "not recorded";
  return `${Math.round(value * 100)}%`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function agentSort(agent: RoutingAgent): number {
  return agent === "codex" ? 0 : 1;
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

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
