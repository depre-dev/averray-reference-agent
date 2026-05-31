import type { RoutingAgent, RoutingDecision, RoutingInput } from "./dispatch-routing.js";
import { createHermesDecisionRecord } from "./decision-records.js";

export interface LearnedRoutingConfig {
  minSamples: number;
  decayHalfLifeDays: number;
  explorationRate: number;
  costAware: boolean;
  costMinRuns: number;
  costTieMaxScoreDelta: number;
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
  costUsdPerTask: number | null;
  costRuns: number;
  costStatus: "recorded" | "not_recorded";
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
  costAware: true,
  costMinRuns: 3,
  costTieMaxScoreDelta: 0.05,
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
    costAware: boolFromEnv(env.A3_COST_AWARE_ROUTING, DEFAULT_LEARNED_ROUTING_CONFIG.costAware),
    costMinRuns: intFromEnv(env.A3_COST_ROUTING_MIN_USAGE_RUNS, DEFAULT_LEARNED_ROUTING_CONFIG.costMinRuns),
    costTieMaxScoreDelta: numberFromEnv(
      env.A3_COST_ROUTING_MAX_SCORE_DELTA,
      DEFAULT_LEARNED_ROUTING_CONFIG.costTieMaxScoreDelta
    ),
    ...overrides,
  };
  return {
    minSamples: Math.max(1, Math.floor(config.minSamples)),
    decayHalfLifeDays: Math.max(1, config.decayHalfLifeDays),
    explorationRate: clamp(config.explorationRate, 0, 1),
    costAware: config.costAware,
    costMinRuns: Math.max(1, Math.floor(config.costMinRuns)),
    costTieMaxScoreDelta: Math.max(0, config.costTieMaxScoreDelta),
  };
}

export function applyLearnedRouting(
  input: RoutingInput,
  staticDecision: RoutingDecision,
  options: LearnedRoutingOptions = {}
): RoutingDecision {
  const config = parseLearnedRoutingConfig(undefined, options.config);
  const now = options.now ?? new Date();
  const rng = options.rng ?? Math.random;
  const surface = targetSurface(input, staticDecision);

  if (staticDecision.riskTier === "high") {
    const reason = `A2 high-risk rule-bound → codex; scorecard ignored (${staticDecision.reason})`;
    return {
      agent: "codex",
      riskTier: staticDecision.riskTier,
      reason,
      decisionRecord: createHermesDecisionRecord({
        kind: "routing",
        subject: routingSubject(input, surface),
        decision: "routed to codex",
        reasons: [
          "The static classifier marked this task high-risk.",
          "High-risk tasks are rule-bound to Codex and cannot be changed by scorecard evidence.",
          staticDecision.reason,
        ],
        inputs: {
          riskTier: staticDecision.riskTier,
          surface,
          routingReason: reason,
          staticDecision,
          scorecardUsed: false,
          wouldChangeDecision: "Only changing the static risk classifier could route high-risk work away from Codex.",
          policyGates: { dispatchEvaluated: false },
        },
        outcome: {
          summary: "Codex selected for the proposed task; dispatch still waits on the normal operator gates.",
          waitingNext: "Operator dispatch gate or the autopilot gate.",
        },
        safety: { readOnly: true, mutates: false },
        generatedAt: now,
      }),
    };
  }

  const candidates = ROUTING_AGENTS
    .map((agent) => scoreAgentForSurface(agent, surface, options.scorecard, config, now))
    .filter((candidate) => candidate.effectiveSamples >= config.minSamples)
    .sort((a, b) => b.score - a.score || b.effectiveSamples - a.effectiveSamples || agentSort(a.agent) - agentSort(b.agent));

  if (candidates.length === 0) {
    const reason = `A2 cold start on ${surface} → static default (${staticDecision.reason})`;
    return {
      ...staticDecision,
      reason,
      decisionRecord: createHermesDecisionRecord({
        kind: "routing",
        subject: routingSubject(input, surface),
        decision: `routed to ${staticDecision.agent}`,
        reasons: [
          `Hermes has fewer than ${config.minSamples} effective samples for ${surface}.`,
          "Cold-start routing uses the static default until scorecard evidence is ready.",
          staticDecision.reason,
        ],
        inputs: {
          riskTier: staticDecision.riskTier,
          surface,
          mode: "cold_start",
          routingReason: reason,
          staticDecision,
          wouldChangeDecision: `At least ${config.minSamples} effective samples for another agent on ${surface} would let learned routing choose differently.`,
          scorecardSnapshot: ROUTING_AGENTS.map((agent) =>
            candidateSnapshot(scoreAgentForSurface(agent, surface, options.scorecard, config, now))
          ),
          policyGates: { dispatchEvaluated: false },
        },
        outcome: {
          summary: `${staticDecision.agent} selected from the static routing rule; task still waits on operator gates.`,
          waitingNext: "Operator dispatch gate or the autopilot gate.",
        },
        safety: { readOnly: true, mutates: false },
        generatedAt: now,
      }),
    };
  }

  const best = candidates[0]!;
  const costPreferred = costAwareChoice(candidates, config);
  const explored = shouldExplore(candidates, config, rng)
    ? candidates.find((candidate) => candidate.agent !== costPreferred.agent) ?? candidates[1]!
    : undefined;
  const chosen = explored ?? costPreferred;
  const mode = explored
    ? "exploration"
    : costPreferred.agent === best.agent
      ? "learned"
      : "cost_aware";
  const reason = [
    reasonPrefix(mode, chosen, surface),
    comparisonSummary(candidates, surface),
    costSummary(best, costPreferred, candidates, config),
    `static default ${staticDecision.agent}`,
  ].filter(Boolean).join("; ");
  return {
    agent: chosen.agent,
    riskTier: staticDecision.riskTier,
    reason,
    decisionRecord: createHermesDecisionRecord({
      kind: "routing",
      subject: routingSubject(input, surface),
      decision: `routed to ${chosen.agent}`,
      reasons: [
        mode === "exploration"
          ? `Hermes intentionally explored ${chosen.agent} despite ${costPreferred.agent} being the preferred scored route.`
          : mode === "cost_aware"
            ? `${chosen.agent} had recorded lower cost while staying within the quality tie band for ${surface}.`
            : `${chosen.agent} had the strongest current score for ${surface}.`,
        comparisonSummary(candidates, surface),
        costSummary(best, costPreferred, candidates, config) || "A3 cost routing found no recorded close-tie cost advantage.",
        `The static default would have selected ${staticDecision.agent}.`,
      ],
      inputs: {
        riskTier: staticDecision.riskTier,
        surface,
        mode,
        routingReason: reason,
        staticDecision,
        learnedRoutingConfig: config,
        scorecardSnapshot: candidates.map(candidateSnapshot),
        wouldChangeDecision: "Different scorecard quality, recorded cost data within the tie band, enough recency decay, or exploration RNG could choose the other candidate.",
        policyGates: { dispatchEvaluated: false },
      },
      outcome: {
        summary: `${chosen.agent} selected for the proposed task; task still waits on operator gates.`,
        waitingNext: "Operator dispatch gate or the autopilot gate.",
      },
      safety: { readOnly: true, mutates: false },
      generatedAt: now,
    }),
  };
}

function shouldExplore(candidates: CandidateScore[], config: LearnedRoutingConfig, rng: () => number): boolean {
  return candidates.length > 1 && config.explorationRate > 0 && rng() < config.explorationRate;
}

function reasonPrefix(mode: "learned" | "exploration" | "cost_aware", chosen: CandidateScore, surface: string): string {
  const label = mode === "exploration"
    ? "A2 exploration"
    : mode === "cost_aware"
      ? "A3 cost-aware routing"
      : "A2 learned routing";
  return `${label}: ${chosen.agent} on ${surface}`;
}

function costAwareChoice(candidates: CandidateScore[], config: LearnedRoutingConfig): CandidateScore {
  const best = candidates[0]!;
  if (!config.costAware || best.costStatus !== "recorded" || best.costRuns < config.costMinRuns) return best;
  const closeRecorded = candidates.filter((candidate) =>
    candidate.costStatus === "recorded"
    && candidate.costRuns >= config.costMinRuns
    && candidate.costUsdPerTask !== null
    && best.score - candidate.score <= config.costTieMaxScoreDelta
  );
  if (closeRecorded.length < 2) return best;
  return closeRecorded.sort((a, b) =>
    (a.costUsdPerTask ?? Number.POSITIVE_INFINITY) - (b.costUsdPerTask ?? Number.POSITIVE_INFINITY)
    || b.score - a.score
    || agentSort(a.agent) - agentSort(b.agent)
  )[0] ?? best;
}

function costSummary(
  best: CandidateScore,
  costPreferred: CandidateScore,
  candidates: CandidateScore[],
  config: LearnedRoutingConfig
): string {
  if (!config.costAware) return "A3 cost-aware routing disabled";
  const values = candidates.map((candidate) => {
    const cost = candidate.costUsdPerTask === null ? "cost not recorded" : `$${formatUsd(candidate.costUsdPerTask)}/task`;
    return `${candidate.agent} ${cost}, cost-runs=${candidate.costRuns}`;
  }).join(" vs ");
  if (costPreferred.agent !== best.agent) {
    return `A3 close quality tie → ${costPreferred.agent} lower recorded cost (${values})`;
  }
  if (best.costStatus !== "recorded" || best.costRuns < config.costMinRuns) {
    return `A3 cost neutral: winning route lacks enough recorded cost data (${values})`;
  }
  return `A3 cost checked; quality winner kept (${values})`;
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

function routingSubject(input: RoutingInput, surface: string) {
  const repo = input.repo?.trim();
  return {
    type: repo ? "repo" as const : "task" as const,
    id: repo || surface || "unknown-routing-surface",
    ...(repo ? { repo } : {}),
  };
}

function candidateSnapshot(candidate: CandidateScore) {
  return {
    agent: candidate.agent,
    score: Number.isFinite(candidate.score) ? Number(candidate.score.toFixed(3)) : "not_enough_data",
    samples: candidate.samples,
    effectiveSamples: Number(candidate.effectiveSamples.toFixed(2)),
    readyRate: candidate.readyRate === null ? "not_recorded" : Number(candidate.readyRate.toFixed(3)),
    costUsdPerTask: candidate.costUsdPerTask === null ? "not_recorded" : Number(candidate.costUsdPerTask.toFixed(6)),
    costRuns: candidate.costRuns,
  };
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
  const cost = agentCostSignal(agentRecord);
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
    ...cost,
  };
}

function emptyCandidate(agent: RoutingAgent): CandidateScore {
  return {
    agent,
    score: Number.NEGATIVE_INFINITY,
    samples: 0,
    effectiveSamples: 0,
    readyRate: null,
    costUsdPerTask: null,
    costRuns: 0,
    costStatus: "not_recorded",
  };
}

function agentCostSignal(agentRecord: Record<string, unknown>) {
  const cost = recordField(agentRecord, "cost");
  const byModel = records(cost?.byModel);
  const runs = byModel.reduce((sum, entry) => sum + (numberField(entry, "runs") ?? 0), 0);
  const averageUsdPerTask = numberField(cost, "averageUsdPerTask");
  const totalUsd = numberField(cost, "totalUsd");
  const fallbackAverage = totalUsd !== undefined && runs > 0 ? totalUsd / runs : undefined;
  const costUsdPerTask = averageUsdPerTask ?? fallbackAverage;
  return {
    costUsdPerTask: cost?.status === "recorded" && costUsdPerTask !== undefined ? costUsdPerTask : null,
    costRuns: runs,
    costStatus: cost?.status === "recorded" && costUsdPerTask !== undefined ? "recorded" as const : "not_recorded" as const,
  };
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

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return value < 0.01 ? value.toFixed(4) : value.toFixed(2);
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
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
