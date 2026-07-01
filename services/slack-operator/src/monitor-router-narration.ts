/**
 * Hermes narration for router proposals (ORCH-P4b, feature #5).
 *
 * When the Hermes router turns a backlog gap into a *proposed* task it narrates
 * the proposal for the monitor co-pilot rail. This module owns that narration so
 * it can be unit-tested in isolation (index.ts wires the real dependencies).
 *
 * Three transports, tried in order — every step is DEGRADED-SAFE, falling back
 * to the next on any failure so the rail never breaks:
 *   1. Agentic session (flag `HERMES_ROUTER_AGENTIC_NARRATION` + a resolved
 *      gateway config): the real Hermes agent (MCP tools/skills/memory) narrates
 *      the WHY in its own board-aware voice. Tagged `hermesMode: "live"`.
 *   2. Ollama persona completion (existing behaviour): a stateless persona-only
 *      completion. Also tagged `"live"` — it is a real model turn.
 *   3. Canned template (`fallbackHermesRouterNarration`): tagged `"templated"`.
 *
 * TRUTH-BOUNDARY (the whole point of this feature):
 *   - The narration is grounded ONLY in the fields that actually exist on the
 *     `RoutedProposal` (repo, surface, agent, riskTier, why, whyAgent, taskPrompt).
 *     `boardSignal` is folded into the backlog item's description upstream and is
 *     NOT preserved on the proposal, so we never claim one. The prompt builders
 *     emit a line for a field only when that field is non-empty on the proposal,
 *     and the guardrails forbid inventing signals/urgency/rationale not present.
 *   - `hermesMode` is tagged `"live"` ONLY when a real model transport produced
 *     the text (session or completion). A template fallback stays `"templated"`.
 *     The UI honesty badge reads this, so the mapping must never mark templated
 *     output as live.
 */

import type { RoutedProposal } from "@avg/averray-mcp/work-router";
import type { HermesReplyMode } from "./monitor-collab.js";
import type { HermesSessionConfig, HermesSessionTurn } from "./hermes-session-client.js";

/** Only the task fields the narration needs (id + optional correlation id). */
export interface RouterNarrationTask {
  id: string;
  correlationId?: string;
}

export interface RouterNarrationResult {
  text: string;
  hermesMode: HermesReplyMode;
}

/**
 * Injected transports/recorder so the orchestrator is testable without touching
 * the network or the collaboration store. index.ts supplies the real impls.
 */
export interface RouterNarrationDeps {
  /** Canned, always-available template (the final fallback). */
  fallback: (proposal: RoutedProposal, task: RouterNarrationTask) => string;
  /** Resolved gateway config, or null when the session transport is unavailable. */
  sessionConfig: HermesSessionConfig | null;
  /** True when `HERMES_ROUTER_AGENTIC_NARRATION` is truthy. */
  agenticEnabled: boolean;
  /** Runs one agentic session turn; returns null on any failure (degraded-safe). */
  runSession?: (config: HermesSessionConfig, prompt: string) => Promise<HermesSessionTurn | null>;
  /** Runs the Ollama persona completion; returns null on any failure. */
  runCompletion?: (prompt: string) => Promise<string | null>;
  /**
   * Side effect fired ONLY when the agentic session produced usable narration
   * text. index.ts uses it to record the agent turn's token usage on the monitor
   * usage panel (the completion path records usage inside `runCompletion`; the
   * template path spends no tokens). Kept as an injected side effect so this
   * module stays a pure text+mode producer with no usage/IO logic of its own.
   */
  onSessionTurn?: (turn: HermesSessionTurn) => void;
  /** Records the finished narration onto the collaboration thread. */
  record: (result: RouterNarrationResult & { relatedCorrelationId: string }) => void;
}

/** Stable correlation id for the proposal's narration (mirrors the routine). */
export function routerNarrationCorrelationId(
  proposal: Pick<RoutedProposal, "dedupeKey">,
  task: RouterNarrationTask,
): string {
  return task.correlationId ?? `hermes-router:${proposal.dedupeKey}`;
}

/**
 * The grounded facts we are willing to put in a prompt, derived ONLY from the
 * proposal. A field is present in the returned lines iff it is non-empty on the
 * proposal — so a proposal without a given signal never surfaces one. This is
 * the single choke point the no-fabrication guard (and its test) relies on.
 */
export function routerProposalFactLines(
  proposal: RoutedProposal,
  task: RouterNarrationTask,
): string[] {
  const lines: string[] = [];
  const push = (label: string, value: string | undefined) => {
    const trimmed = (value ?? "").trim();
    if (trimmed) lines.push(`${label}: ${trimmed}`);
  };
  push("Task id", task.id);
  push("Repo", proposal.repo);
  push("Surface/gap", proposal.surface);
  push("Agent", proposal.agent);
  push("Risk tier", proposal.riskTier);
  push("Why this gap (stated rationale)", proposal.why);
  push("Why this agent (routing rationale)", proposal.whyAgent);
  return lines;
}

const TRUTH_RULES = [
  "Rules (follow exactly):",
  "- Describe ONLY the proposal facts listed above. Do not add any signal, urgency, deadline, board card, failure, metric, PR number, or rationale that is not in that list.",
  "- If a fact is not listed, it is unknown — do not guess or imply it. Never invent a board signal or a reason the work matters.",
  "- This task is PROPOSED ONLY and waiting for operator approval. Do not say it ran, was approved, merged, dispatched, or that anyone acted.",
  "- Reply with exactly one concise, truthful sentence for the monitor co-pilot rail. No preamble, no list, no trailing notes.",
];

/**
 * Prompt for the stateless persona completion (transport 2). Threads the real
 * proposal facts + the truth guardrails.
 */
export function buildHermesRouterNarrationPrompt(
  proposal: RoutedProposal,
  task: RouterNarrationTask,
): string {
  return [
    "Hermes just created a proposed task from the roadmap backlog. Write one concise, truthful sentence for the monitor co-pilot rail.",
    "",
    ...routerProposalFactLines(proposal, task),
    "",
    ...TRUTH_RULES,
  ].join("\n");
}

/**
 * Prompt for the agentic session turn (transport 1). Same grounded facts, but
 * framed for the real Hermes agent so it narrates the actual WHY in its own
 * board/context-aware voice — WITHOUT loosening the truth guardrails. The agent
 * may draw on its own memory of prior room decisions, but the proposal facts
 * here are the only claims it may assert about *this* proposal.
 */
export function buildHermesRouterAgenticNarrationPrompt(
  proposal: RoutedProposal,
  task: RouterNarrationTask,
): string {
  return [
    "You are narrating a router proposal for the monitor co-pilot rail. The Hermes router just turned a backlog gap into a PROPOSED task (not approved, not running).",
    "Speak in your own agentic voice and surface the WHY, but stay strictly grounded in these proposal facts:",
    "",
    ...routerProposalFactLines(proposal, task),
    "",
    ...TRUTH_RULES,
    "- You may reflect your own board/context awareness in tone, but every concrete claim about THIS proposal must come from the facts above.",
  ].join("\n");
}

/**
 * Produce the narration for a router proposal and record it. Tries the agentic
 * session (when enabled + configured), then the Ollama completion, then the
 * canned template. `hermesMode` is "live" only when a real model transport
 * produced the text.
 *
 * Returns the recorded result so callers/tests can assert the text + mode.
 */
export async function narrateRouterProposal(
  proposal: RoutedProposal,
  task: RouterNarrationTask,
  deps: RouterNarrationDeps,
): Promise<RouterNarrationResult> {
  let text = deps.fallback(proposal, task);
  let hermesMode: HermesReplyMode = "templated";

  // Transport 1: the real agentic Hermes. Only runs when the flag is on AND a
  // gateway config resolved. Any failure returns null -> fall through.
  if (deps.agenticEnabled && deps.sessionConfig && deps.runSession) {
    const turn = await deps
      .runSession(deps.sessionConfig, buildHermesRouterAgenticNarrationPrompt(proposal, task))
      .catch(() => null);
    if (turn?.text?.trim()) {
      text = turn.text;
      hermesMode = "live";
      // Attribute the agent turn's token usage (side effect owned by index.ts).
      deps.onSessionTurn?.(turn);
    }
  }

  // Transport 2: the stateless Ollama persona completion. Runs when the agentic
  // path did not produce text (disabled, unconfigured, or failed).
  if (hermesMode === "templated" && deps.runCompletion) {
    const completion = await deps
      .runCompletion(buildHermesRouterNarrationPrompt(proposal, task))
      .catch(() => null);
    if (completion?.trim()) {
      text = completion;
      hermesMode = "live";
    }
  }

  const result: RouterNarrationResult = {
    text: text.replace(/\s+/g, " ").trim().slice(0, 1000),
    hermesMode,
  };
  deps.record({ ...result, relatedCorrelationId: routerNarrationCorrelationId(proposal, task) });
  return result;
}
