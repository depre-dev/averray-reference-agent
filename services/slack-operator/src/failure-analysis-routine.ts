// Hermes failure-analysis routine (feature: grounded failure analysis for
// operator decision cards).
//
// The effectful, flag-gated companion to the pure analyzeCardFailure(...). On a
// scheduled tick it walks the current board, picks the operator-decision cards
// that represent a FAILURE, and — for each one lacking a FRESH cached analysis —
// asks the real agentic Hermes for one grounded paragraph (why it likely failed
// + a fix/rollback next step, or an explicit "cause unclear"). The paragraph is
// cached keyed by card id + a hash of the failure context, so it re-runs only
// when the failure changes. It NEVER approves, dispatches, merges, deploys, or
// mutates the card — it only attaches Hermes's read.
//
// Modeled on hermes-router-routine.ts (runHermesRouterOnce): pure orchestration
// over injected deps, degraded-safe, and a no-op when the flag is off.

import {
  analyzeCardFailure,
  hashFailureContext,
  hasDiagnosableFailureDetail,
  type FailureAnalysisCard,
  type FailureAnalysisDeps,
} from "./monitor-failure-analysis.js";

export interface FailureAnalysisRoutineConfig {
  enabled: boolean;
  intervalMs: number;
  /** Max analyses produced per tick — caps token spend when many cards fail at once. */
  maxPerTick: number;
}

export interface FailureAnalysisRoutineDeps {
  /** The failure cards to consider, already projected to the grounded fields. */
  listFailureCards: () => Promise<FailureAnalysisCard[]> | FailureAnalysisCard[];
  /** Fresh cached analysis for this card + failure hash, or undefined. */
  readFresh: (cardId: string, failureHash: string) => { text: string } | undefined;
  /** Persist a produced analysis for a card. */
  write: (cardId: string, value: { text: string; model?: string; failureHash: string }) => void;
  /** The agentic transport + flag + usage side effect passed to analyzeCardFailure. */
  analysisDeps: FailureAnalysisDeps;
  /** Guardrails — mirror the router routine so autopilot halt/suspend also parks this. */
  isSuspended: () => boolean;
  isHalt: () => boolean;
}

export interface FailureAnalysisRoutineResult {
  status: "disabled" | "paused" | "idle" | "analyzed";
  reason?:
    | "halt_present"
    | "autopilot_suspended"
    | "no_failure_cards"
    | "all_fresh"
    /** Failure cards needed analysis but every turn came back degraded (gateway down / empty). */
    | "degraded";
  analyzed: Array<{ cardId: string }>;
}

/**
 * One pass of the failure-analysis routine. Degraded-safe throughout: a
 * transport that returns nothing simply produces no analysis for that card (the
 * drawer keeps its "Ask Hermes" pointer). No-op when the flag is off.
 */
export async function runFailureAnalysisOnce(
  config: FailureAnalysisRoutineConfig,
  deps: FailureAnalysisRoutineDeps,
): Promise<FailureAnalysisRoutineResult> {
  if (!config.enabled) return { status: "disabled", analyzed: [] };
  if (deps.isHalt()) return { status: "paused", reason: "halt_present", analyzed: [] };
  if (deps.isSuspended()) return { status: "paused", reason: "autopilot_suspended", analyzed: [] };

  const cards = await deps.listFailureCards();
  if (cards.length === 0) return { status: "idle", reason: "no_failure_cards", analyzed: [] };

  const analyzed: Array<{ cardId: string }> = [];
  let sawStale = false;
  for (const card of cards) {
    if (analyzed.length >= config.maxPerTick) break;
    // Skip a card with no concrete, diagnosable failure detail — explaining a
    // bare "failed" with nothing to reason about would only invite a guess.
    if (!hasDiagnosableFailureDetail(card)) continue;

    const failureHash = hashFailureContext(card);
    if (deps.readFresh(card.id, failureHash)) continue; // already fresh
    sawStale = true;

    const result = await analyzeCardFailure(card, deps.analysisDeps);
    if (result.hermesMode !== "live" || !result.text) continue; // degraded — write nothing

    deps.write(card.id, {
      text: result.text,
      failureHash,
      ...(result.model ? { model: result.model } : {}),
    });
    analyzed.push({ cardId: card.id });
  }

  if (analyzed.length > 0) return { status: "analyzed", analyzed };
  // sawStale means there WERE failure cards needing analysis but every turn came
  // back degraded (gateway down / empty) — report "degraded", not "all_fresh"
  // (the board is NOT clean) and not "no_failure_cards" (there were some).
  return {
    status: "idle",
    reason: sawStale ? "degraded" : "all_fresh",
    analyzed: [],
  };
}
