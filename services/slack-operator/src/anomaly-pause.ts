// D3 — tiered anomaly auto-pause.
//
// The automatic fail-safe that lets a misbehaving autopilot be stopped without
// a human watching. SERVER-SIDE (runs with no tab open). It owns the
// autopilot-suspended flag (autopilot-state.ts) that O4-PR3 will respect.
//
//   SOFT trip (medium) → set autopilot-suspended + push a D4 alert. No new
//     auto-approvals while suspended; in-flight work finishes.
//   HARD trip (severe)  → touch HALT_FILE (everything mutating stops) + alert.
//
// This module is the pure decision (evaluateAnomalies / decideAnomalyAction)
// plus an effect-injected orchestrator (runAnomalyPauseOnce) — so detection +
// the tiered action are unit-tested with no fs/network.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { optionalEnv, readYamlFile } from "@avg/mcp-common";
import type { AlertChannel, AlertPayload } from "./alert-bridge.js";

// ── Signals + thresholds ────────────────────────────────────────────

export interface AnomalySignals {
  /** Highest attemptCount among non-terminal tasks (retry-loop detection). */
  maxTaskAttemptCount: number;
  /** Tasks currently in a failed/retrying state (multi-task runaway). */
  failingTaskCount: number;
  /** Hermes-proposed/approved tasks created today (budget spike). */
  hermesTasksToday: number;
  /** The per-day dispatch cap (from the dispatch guardrail). */
  perDayCap: number;
  /** Age of the most recent runner heartbeat, seconds (gap detection). */
  runnerHeartbeatAgeSec?: number;
}

export interface AnomalyConfig {
  /** attemptCount ≥ this → SOFT (task retry loop). */
  taskRetrySoft: number;
  /** attemptCount ≥ this → HARD (single-task runaway). */
  taskRunawayHard: number;
  /** failing tasks ≥ this → HARD (multi-task runaway). */
  failingTasksHard: number;
  /** today/cap ratio ≥ this → SOFT (budget spike). */
  budgetSpikeRatio: number;
  /** today/cap ratio ≥ this → HARD (budget blowout). */
  budgetBlowoutRatio: number;
  /** runner heartbeat age (s) ≥ this → SOFT (heartbeat gap). */
  heartbeatGapSec: number;
}

export type AnomalyTier = "none" | "soft" | "hard";
export interface AnomalyTrip {
  signal: string;
  tier: "soft" | "hard";
  detail: string;
}
export interface AnomalyEvaluation {
  tier: AnomalyTier;
  trips: AnomalyTrip[];
}

const DEFAULTS: AnomalyConfig = {
  taskRetrySoft: 3,
  taskRunawayHard: 6,
  failingTasksHard: 3,
  budgetSpikeRatio: 0.8,
  budgetBlowoutRatio: 1.0,
  heartbeatGapSec: 600,
};

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

interface AnomalyYamlBlock {
  task_retry_soft?: unknown;
  task_runaway_hard?: unknown;
  failing_tasks_hard?: unknown;
  budget_spike_ratio?: unknown;
  budget_blowout_ratio?: unknown;
  heartbeat_gap_sec?: unknown;
}

/** Load thresholds from the `anomaly:` block of policy.yaml, with env overrides. */
export function loadAnomalyConfig(env: NodeJS.ProcessEnv = process.env): AnomalyConfig {
  const yaml = readYamlFile<{ anomaly?: AnomalyYamlBlock }>(
    optionalEnv("POLICY_CONFIG_PATH", "/config/policy.yaml") ?? "/config/policy.yaml",
    {},
  );
  const a = yaml.anomaly ?? {};
  return {
    taskRetrySoft: num(env.D3_TASK_RETRY_SOFT ?? a.task_retry_soft, DEFAULTS.taskRetrySoft),
    taskRunawayHard: num(env.D3_TASK_RUNAWAY_HARD ?? a.task_runaway_hard, DEFAULTS.taskRunawayHard),
    failingTasksHard: num(env.D3_FAILING_TASKS_HARD ?? a.failing_tasks_hard, DEFAULTS.failingTasksHard),
    budgetSpikeRatio: num(env.D3_BUDGET_SPIKE_RATIO ?? a.budget_spike_ratio, DEFAULTS.budgetSpikeRatio),
    budgetBlowoutRatio: num(env.D3_BUDGET_BLOWOUT_RATIO ?? a.budget_blowout_ratio, DEFAULTS.budgetBlowoutRatio),
    heartbeatGapSec: num(env.D3_HEARTBEAT_GAP_SEC ?? a.heartbeat_gap_sec, DEFAULTS.heartbeatGapSec),
  };
}

/** Pure: evaluate signals against thresholds. Conservative — hard wins over soft. */
export function evaluateAnomalies(s: AnomalySignals, c: AnomalyConfig): AnomalyEvaluation {
  const trips: AnomalyTrip[] = [];

  if (s.maxTaskAttemptCount >= c.taskRunawayHard) {
    trips.push({ signal: "task_runaway", tier: "hard", detail: `a task reached attempt #${s.maxTaskAttemptCount} (≥ ${c.taskRunawayHard})` });
  } else if (s.maxTaskAttemptCount >= c.taskRetrySoft) {
    trips.push({ signal: "task_retry_loop", tier: "soft", detail: `a task reached attempt #${s.maxTaskAttemptCount} (≥ ${c.taskRetrySoft})` });
  }

  if (s.failingTaskCount >= c.failingTasksHard) {
    trips.push({ signal: "multi_task_runaway", tier: "hard", detail: `${s.failingTaskCount} tasks failing/retrying (≥ ${c.failingTasksHard})` });
  }

  if (s.perDayCap > 0) {
    const ratio = s.hermesTasksToday / s.perDayCap;
    if (ratio >= c.budgetBlowoutRatio) {
      trips.push({ signal: "budget_blowout", tier: "hard", detail: `${s.hermesTasksToday}/${s.perDayCap} dispatched today (≥ ${Math.round(c.budgetBlowoutRatio * 100)}% of cap)` });
    } else if (ratio >= c.budgetSpikeRatio) {
      trips.push({ signal: "budget_spike", tier: "soft", detail: `${s.hermesTasksToday}/${s.perDayCap} dispatched today (≥ ${Math.round(c.budgetSpikeRatio * 100)}% of cap)` });
    }
  }

  if (s.runnerHeartbeatAgeSec !== undefined && s.runnerHeartbeatAgeSec >= c.heartbeatGapSec) {
    trips.push({ signal: "runner_heartbeat_gap", tier: "soft", detail: `runner heartbeat ${Math.round(s.runnerHeartbeatAgeSec)}s old (≥ ${c.heartbeatGapSec}s)` });
  }

  const tier: AnomalyTier = trips.some((t) => t.tier === "hard")
    ? "hard"
    : trips.some((t) => t.tier === "soft")
      ? "soft"
      : "none";
  return { tier, trips };
}

export type AnomalyAction = "none" | "soft" | "hard";

/**
 * Pure: pick the action, with de-dup. A hard tier always acts (the caller skips
 * when HALT is already present, so it can't re-fire). A soft tier is suppressed
 * while already suspended — re-evaluated naturally once the operator resumes.
 */
export function decideAnomalyAction(evaluation: AnomalyEvaluation, alreadySuspended: boolean): AnomalyAction {
  if (evaluation.tier === "hard") return "hard";
  if (evaluation.tier === "soft") return alreadySuspended ? "none" : "soft";
  return "none";
}

export function summarizeTrips(evaluation: AnomalyEvaluation): { reason: string; signals: string } {
  return {
    reason: evaluation.trips.map((t) => `${t.signal}: ${t.detail}`).join(" | "),
    signals: evaluation.trips.map((t) => `${t.tier}:${t.signal}`).join(","),
  };
}

export function buildAnomalyAlert(evaluation: AnomalyEvaluation, action: AnomalyAction, boardUrl: string): AlertPayload {
  const head = action === "hard"
    ? "🛑 Hermes HARD-paused — HALT_FILE set, all mutating work stopped"
    : "⏸️ Hermes autopilot suspended (soft) — no new auto-approvals until you resume";
  const lines = evaluation.trips.map((t) => `• [${t.tier}] ${t.signal}: ${t.detail}`).join("\n");
  const text = `${head}\n${lines}\nResume / inspect: ${boardUrl}`;
  return { count: evaluation.trips.length, items: [], boardUrl, text };
}

function haltPath(path?: string): string {
  return path ?? optionalEnv("HALT_FILE", "/data/HALT") ?? "/data/HALT";
}

/** Touch the HALT_FILE (hard trip). Same path assertNoKillSwitch reads. */
export function touchHaltFile(reason: string, path?: string): void {
  const p = haltPath(path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${reason}\n`);
}

/** Whether HALT_FILE is already present (so the routine doesn't re-fire). */
export function isHaltFilePresent(path?: string): boolean {
  try {
    return existsSync(haltPath(path));
  } catch {
    return false;
  }
}

// ── Orchestrator (effect-injected; the index.ts routine wires real impls) ──

export interface AnomalyPauseDeps {
  config: AnomalyConfig;
  getSignals: () => Promise<AnomalySignals> | AnomalySignals;
  isHaltPresent: () => boolean;
  isSuspended: () => boolean;
  setSuspended: (info: { reason: string; signal: string; tier: "soft" | "hard"; setAt: string }) => void;
  touchHalt: (reason: string) => void;
  alert: (payload: AlertPayload) => Promise<boolean>;
  audit: (record: { tier: AnomalyTier; action: AnomalyAction; signals: string; reason: string }) => Promise<unknown> | unknown;
  boardUrl: string;
  now: () => Date;
}

export interface AnomalyPauseResult {
  action: AnomalyAction | "halted";
  evaluation?: AnomalyEvaluation;
}

export async function runAnomalyPauseOnce(deps: AnomalyPauseDeps): Promise<AnomalyPauseResult> {
  // Already halted ⇒ nothing more to stop; don't re-fire.
  if (deps.isHaltPresent()) return { action: "halted" };

  const signals = await deps.getSignals();
  const evaluation = evaluateAnomalies(signals, deps.config);
  const action = decideAnomalyAction(evaluation, deps.isSuspended());
  if (action === "none") return { action: "none", evaluation };

  const { reason, signals: signalList } = summarizeTrips(evaluation);
  const setAt = deps.now().toISOString();

  if (action === "hard") {
    deps.touchHalt(`D3 hard anomaly trip: ${reason}`);
    deps.setSuspended({ reason, signal: signalList, tier: "hard", setAt }); // also suspend autopilot
  } else {
    deps.setSuspended({ reason, signal: signalList, tier: "soft", setAt });
  }

  await deps.alert(buildAnomalyAlert(evaluation, action, deps.boardUrl));
  await deps.audit({ tier: evaluation.tier, action, signals: signalList, reason });
  return { action, evaluation };
}
