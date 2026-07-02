/**
 * Hermes failure analysis for operator decision cards (feature: grounded failure
 * analysis).
 *
 * A card whose verdict is just "deploy failed" (or a failed task / degraded
 * fetch) shows a bare box and no path forward. When this feature is on, the real
 * agentic Hermes produces ONE short paragraph: the likely WHY it failed + a
 * recommended next step (fix vs rollback) — or an explicit "cause unclear from
 * the available signals" when the data is thin. This module owns producing that
 * paragraph so it can be unit-tested in isolation (index.ts wires the real deps).
 *
 * Modeled on monitor-router-narration.ts (#472): a flag-gated agentic call, a
 * prompt grounded ONLY in real card fields, usage recorded via an injected side
 * effect, and a degraded fallback. Two differences from the router narration:
 *   - There is NO template/Ollama fallback. This analysis is an agentic read of
 *     a failure; if the real agent can't run (flag off, gateway down, empty
 *     reply) we produce NOTHING — the drawer keeps its existing "Ask Hermes"
 *     pointer. A canned "why it failed" would be a fabricated root cause, which
 *     the truth-boundary forbids. So the only "live" transport is the session.
 *   - `hermesMode` is "live" ONLY when the real session produced the text; there
 *     is no "templated" analysis to mis-tag.
 *
 * TRUTH-BOUNDARY (the whole point):
 *   - The prompt is grounded ONLY in the failure fields that actually exist on
 *     the card (title, repo, verdict, failureReason, sourceFailure, failed check
 *     names, degraded state, risk signals). `failureContextFactLines` emits a
 *     line for a field only when it is non-empty — the single choke point the
 *     no-fabrication guard relies on.
 *   - The guardrails forbid inventing a root cause the data doesn't support and
 *     REQUIRE an explicit "cause unclear from the available signals" when the
 *     signals don't determine the cause. Hermes must never guess.
 *   - The result is tagged as Hermes's agentic read so the UI honesty
 *     badge/label is accurate. Usage is recorded, mirroring the co-pilot /
 *     router-narration path.
 */

import type { HermesReplyMode } from "./monitor-collab.js";
import type { HermesSessionConfig, HermesSessionTurn } from "./hermes-session-client.js";

/**
 * The ONLY card fields the failure analysis is allowed to read. A deliberately
 * narrow projection (not the full BoardCard) so the module stays pure and the
 * grounded-fact surface is auditable. index.ts / monitor-v2 build this from a
 * real card; a field is present here iff it is real on the card.
 */
export interface FailureAnalysisCard {
  id: string;
  title: string;
  repo?: string;
  /** Hermes verdict / reasoning carried from the classifier, when present. */
  verdict?: string;
  /** Codex/Claude task failure reason, when the task failed. */
  failureReason?: string;
  /** Degraded source read / heartbeat failure message, when present. */
  sourceFailure?: { source: string; code?: string; message: string };
  /** Names of CI checks that failed (from the per-check breakdown). */
  failedCheckNames?: string[];
  /** Card state, e.g. "failed-fetch" for a degraded card. */
  state?: string;
  /** Hermes review findings — the "why review" detail, when present. */
  riskSignals?: string[];
  /** A short label for the kind of failure, e.g. "deploy verification". */
  failureKind?: string;
}

export interface FailureAnalysisResult {
  text: string;
  /** "live" only when the real agentic session produced the text; else "none". */
  hermesMode: HermesReplyMode | "none";
  /** Model the gateway ran the turn on, when reported — surfaced on the card. */
  model?: string;
}

export interface FailureAnalysisDeps {
  /** Resolved gateway config, or null when the session transport is unavailable. */
  sessionConfig: HermesSessionConfig | null;
  /** True when HERMES_FAILURE_ANALYSIS is truthy. */
  enabled: boolean;
  /** Runs one agentic session turn; returns null on any failure (degraded-safe). */
  runSession?: (config: HermesSessionConfig, prompt: string) => Promise<HermesSessionTurn | null>;
  /**
   * Side effect fired ONLY when the session produced a usable analysis. index.ts
   * uses it to record the agent turn's token usage on the monitor usage panel
   * (mirrors the router-narration onSessionTurn). Kept injected so this module
   * stays a pure text+mode producer with no usage/IO of its own.
   */
  onSessionTurn?: (turn: HermesSessionTurn) => void;
}

/** Cap so a runaway agent reply can't bloat the card payload. */
const MAX_ANALYSIS_CHARS = 900;

/**
 * The grounded failure facts we are willing to put in a prompt, derived ONLY
 * from the card. A field is present in the returned lines iff it is non-empty on
 * the card — so a card without a given failure signal never surfaces one. This
 * is the single choke point the no-fabrication guard (and its test) relies on.
 */
export function failureContextFactLines(card: FailureAnalysisCard): string[] {
  const lines: string[] = [];
  const push = (label: string, value: string | undefined) => {
    const trimmed = (value ?? "").trim();
    if (trimmed) lines.push(`${label}: ${trimmed}`);
  };
  push("Card", card.title);
  push("Repo", card.repo);
  push("Failure kind", card.failureKind);
  push("Verdict", card.verdict);
  push("Failure reason", card.failureReason);
  if (card.sourceFailure && card.sourceFailure.message.trim()) {
    const sf = card.sourceFailure;
    const code = sf.code ? ` [${sf.code}]` : "";
    push("Source failure", `${sf.source}${code}: ${sf.message}`);
  }
  const failedChecks = (card.failedCheckNames ?? []).map((n) => n.trim()).filter(Boolean);
  if (failedChecks.length > 0) push("Failed checks", failedChecks.join(", "));
  if (card.state && card.state.trim()) push("Card state", card.state);
  const signals = (card.riskSignals ?? []).map((s) => s.trim()).filter(Boolean);
  if (signals.length > 0) push("Risk signals", signals.slice(0, 5).join("; "));
  return lines;
}

/**
 * True when the card carries at least one CONCRETE failure detail Hermes can
 * reason about beyond the bare verdict/title/state. Used by the routine to skip
 * cards whose only signal is "failed" with no diagnosable context — asking the
 * agent to explain a failure with no detail would only invite a guess.
 */
export function hasDiagnosableFailureDetail(card: FailureAnalysisCard): boolean {
  if ((card.failureReason ?? "").trim()) return true;
  if (card.sourceFailure && card.sourceFailure.message.trim()) return true;
  if ((card.failedCheckNames ?? []).some((n) => n.trim())) return true;
  if ((card.riskSignals ?? []).some((s) => s.trim())) return true;
  return false;
}

const TRUTH_RULES = [
  "Rules (follow exactly):",
  "- Ground EVERY claim in the failure facts listed above. Do not invent a root cause, error, log line, metric, PR number, or step that is not in that list.",
  "- If the listed signals do not actually determine why it failed, say exactly: \"Cause unclear from the available signals.\" Then, still grounded only in what is listed, suggest the safest next step. Never guess a cause to fill the gap.",
  "- Recommend ONE concrete next step and say whether it leans toward a fix or a rollback, based only on the listed signals. If the signals don't favor either, say so.",
  "- Do not claim you inspected logs, ran commands, merged, deployed, approved, rolled back, or took any action. You are reading the card, not acting.",
  "- Reply with ONE short paragraph (2-4 sentences) for the operator's decision drawer. No preamble, no heading, no list, no trailing notes.",
];

/**
 * Prompt for the agentic failure analysis. Threads the real failure facts + the
 * truth guardrails (grounded-only, explicit "cause unclear" path). Framed for
 * the real Hermes agent so it reads the failure in its own board-aware voice —
 * WITHOUT loosening the guardrails: the facts here are the only claims it may
 * assert about THIS failure.
 */
export function buildFailureAnalysisPrompt(card: FailureAnalysisCard): string {
  return [
    "An operator is looking at a decision card on the monitor board that represents a FAILURE. Read why it likely failed and recommend the next move, for the operator's decision drawer.",
    "Stay strictly grounded in these failure facts from the card:",
    "",
    ...failureContextFactLines(card),
    "",
    ...TRUTH_RULES,
    "- You may reflect your own board/context awareness in tone, but every concrete claim about THIS failure must come from the facts above.",
  ].join("\n");
}

/**
 * A stable hash of the failure context, so the cache re-runs ONLY when the
 * failure actually changes (not on every unrelated board refresh). Derived from
 * the same grounded fact lines the prompt uses, so any change to a real failure
 * field invalidates the cache. Small, dependency-free FNV-1a over the joined
 * lines — collisions are astronomically unlikely for this short, low-cardinality
 * input, and a collision would at worst reuse a still-relevant analysis.
 */
export function hashFailureContext(card: FailureAnalysisCard): string {
  const basis = failureContextFactLines(card).join("\n");
  let h = 0x811c9dc5;
  // Iterate Unicode CODE POINTS (not UTF-16 units) so astral chars don't split
  // into surrogate halves — keeps distinct failure texts distinct.
  for (const ch of basis) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Produce the grounded failure analysis for a card via the real agentic Hermes.
 * Runs the session ONLY when the flag is on AND a gateway config resolved AND a
 * session runner is provided; any failure (disabled, unconfigured, thrown, empty
 * reply) returns `{ text: "", hermesMode: "none" }` so the caller writes nothing
 * and the drawer keeps its existing "Ask Hermes" pointer. There is deliberately
 * no template fallback — a canned cause would be fabrication.
 */
export async function analyzeCardFailure(
  card: FailureAnalysisCard,
  deps: FailureAnalysisDeps,
): Promise<FailureAnalysisResult> {
  if (!deps.enabled || !deps.sessionConfig || !deps.runSession) {
    return { text: "", hermesMode: "none" };
  }
  const turn = await deps
    .runSession(deps.sessionConfig, buildFailureAnalysisPrompt(card))
    .catch(() => null);
  const text = turn?.text?.trim();
  if (!turn || !text) return { text: "", hermesMode: "none" };

  // Only now (real text produced) attribute the agent turn's token usage.
  deps.onSessionTurn?.(turn);
  return {
    text: text.replace(/\s+/g, " ").trim().slice(0, MAX_ANALYSIS_CHARS),
    hermesMode: "live",
    ...(turn.model ? { model: turn.model } : {}),
  };
}
