// Hermes Handoff Monitor — pure cache-patching for live updates.
//
// `applyEventToBoard(prev, event)` takes the current board snapshot +
// a single MonitorEvent and returns a NEW snapshot with the event
// applied. Used by the SWR hook to patch the cache without a full
// refetch when SSE events arrive. Never mutates the input.

import type { BoardCard, Lane } from "./card-types.js";
import type { CalmBoardMetrics } from "./board-state.js";
import type { SavedTestSuite } from "./mission-launch.js";

export interface MonitorBoard {
  cards: BoardCard[];
  /** ISO timestamp from the server */
  at: string;
  llmUsage?: LlmUsageAggregate;
  testbedSuites?: SavedTestSuite[];
  /** Optional board-summary metrics; omitted means the UI must not fabricate them. */
  calmMetrics?: CalmBoardMetrics;
  /** Quiet automation-capacity gauge. Omitted means the UI must omit it. */
  automationHealth?: AutomationHealth;
}

export interface AutomationHealth {
  sourceStatus?: "ok" | "degraded";
  selfHealingOpen: number | null;
  dispatchUsedToday: number | null;
  dispatchPerDayCap: number;
  quietSignalCount?: number | null;
  selfHealingCapacitySignals?: number | null;
  taskHealthCapacitySignals?: number | null;
  taskHealth?: {
    status: "ok" | "stuck" | "degraded" | "unknown";
    runningTasks: number;
    stuckTasks: number;
    retryWaitingTasks: number;
    escalatedTasks: number;
    runner: {
      status: "online" | "missing" | "stale" | "unavailable" | "unknown";
      reason: string;
      activeTaskId?: string;
      ageMs?: number;
    };
  };
  routing?: {
    status: "baseline_available" | "insufficient_data" | "unknown";
    decisionsToday: number | null;
    surfaces: number | null;
    baselineSurfaces: number | null;
    insufficientSurfaces: number | null;
    top?: {
      surface: string;
      agent: string;
      score: number;
      samples: number;
    };
  };
  guardrails?: {
    dispatchPolicy: "enforced";
    haltInterlock: "enforced";
    anomalyPause: "enforced";
    authority: "human_merge_gate";
  };
}

export interface LlmUsageModelRollup {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
  lastActiveAt?: string | null;
}

export interface LlmUsageDayRollup {
  day: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
  lastActiveAt?: string | null;
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

/** One per-model line in the live usage window; points are per-minute token sums. */
export interface LlmUsageRecentSeries {
  agent: string;
  model: string;
  points: number[];
}

/** Real "tokens/min · per model" window (null when there's no recent activity). */
export interface LlmUsageRecent {
  windowMinutes: number;
  endsAt: string;
  series: LlmUsageRecentSeries[];
}

export interface LlmUsageAggregate {
  status: "recorded" | "not_recorded";
  message?: string;
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  totalTokens: number;
  costUsd: number | null;
  costStatus: "recorded" | "not_recorded";
  runs: number;
  lastActiveAt?: string | null;
  byModel: LlmUsageModelRollup[];
  byDay: LlmUsageDayRollup[];
  sourceStatus?: LlmUsageSourceStatus[];
  activeCalls?: LlmUsageActiveCall[];
  recent?: LlmUsageRecent | null;
}

export interface MonitorEvent {
  type: string;
  [key: string]: unknown;
}

export function applyEventToBoard(
  prev: MonitorBoard | undefined,
  event: MonitorEvent | null | undefined
): MonitorBoard | undefined {
  if (!event || typeof event.type !== "string") return prev;
  switch (event.type) {
    case "board.snapshot": {
      const cards = Array.isArray(event.cards) ? (event.cards as BoardCard[]) : [];
      const at = typeof event.at === "string" ? event.at : new Date().toISOString();
      const calmMetrics = isRecord(event.calmMetrics) ? (event.calmMetrics as CalmBoardMetrics) : undefined;
      const automationHealth = isAutomationHealth(event.automationHealth)
        ? event.automationHealth
        : undefined;
      const llmUsage = isLlmUsageAggregate(event.llmUsage) ? event.llmUsage : undefined;
      const testbedSuites = Array.isArray(event.testbedSuites) ? (event.testbedSuites as SavedTestSuite[]) : undefined;
      return {
        cards,
        at,
        ...(llmUsage ? { llmUsage } : {}),
        ...(testbedSuites ? { testbedSuites } : {}),
        ...(calmMetrics ? { calmMetrics } : {}),
        ...(automationHealth ? { automationHealth } : {}),
      };
    }
    case "board.card.added": {
      if (!prev) return prev;
      const card = event.card as BoardCard | undefined;
      if (!card?.id) return prev;
      const idx = prev.cards.findIndex((c) => c.id === card.id);
      if (idx >= 0) {
        const next = prev.cards.slice();
        next[idx] = card;
        return { ...prev, cards: next, at: typeof event.at === "string" ? event.at : prev.at };
      }
      return { ...prev, cards: [...prev.cards, card], at: typeof event.at === "string" ? event.at : prev.at };
    }
    case "board.card.updated": {
      if (!prev) return prev;
      const id = event.id as string | undefined;
      if (!id) return prev;
      const partial = (event.partial ?? {}) as Partial<BoardCard>;
      const idx = prev.cards.findIndex((c) => c.id === id);
      if (idx < 0) return prev;
      const next = prev.cards.slice();
      next[idx] = { ...next[idx], ...partial, id } as BoardCard;
      return { ...prev, cards: next, at: typeof event.at === "string" ? event.at : prev.at };
    }
    case "board.card.moved": {
      if (!prev) return prev;
      const id = event.id as string | undefined;
      const toLane = event.toLane as Lane | undefined;
      if (!id || !toLane) return prev;
      const idx = prev.cards.findIndex((c) => c.id === id);
      if (idx < 0) return prev;
      const card = isRecord(event.card) ? (event.card as unknown as BoardCard) : undefined;
      const next = prev.cards.slice();
      next[idx] = card?.id === id ? { ...card, lane: toLane } : ({ ...next[idx], lane: toLane } as BoardCard);
      return { ...prev, cards: next, at: typeof event.at === "string" ? event.at : prev.at };
    }
    case "board.card.archived": {
      if (!prev) return prev;
      const id = event.id as string | undefined;
      if (!id) return prev;
      if (!prev.cards.some((c) => c.id === id)) return prev;
      return {
        ...prev,
        cards: prev.cards.filter((c) => c.id !== id),
        at: typeof event.at === "string" ? event.at : prev.at,
      };
    }
    case "stream.keepalive":
      // Keepalive doesn't change the cache; UI surfaces it via streamStatus.
      return prev;
    default:
      return prev;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isAutomationHealth(value: unknown): value is AutomationHealth {
  if (!isRecord(value)) return false;
  const selfHealingKnown = value.selfHealingOpen === null || Number.isFinite(value.selfHealingOpen);
  const dispatchKnown = value.dispatchUsedToday === null || Number.isFinite(value.dispatchUsedToday);
  return selfHealingKnown
    && dispatchKnown
    && Number.isFinite(value.dispatchPerDayCap);
}

function isLlmUsageAggregate(value: unknown): value is LlmUsageAggregate {
  if (!isRecord(value)) return false;
  return (value.status === "recorded" || value.status === "not_recorded")
    && Number.isFinite(value.inputTokens)
    && Number.isFinite(value.outputTokens)
    && Number.isFinite(value.totalTokens)
    && Number.isFinite(value.runs)
    && Array.isArray(value.byModel)
    && Array.isArray(value.byDay);
}
