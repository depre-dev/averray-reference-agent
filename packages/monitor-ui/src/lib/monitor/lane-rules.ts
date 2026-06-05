// Hermes Handoff Monitor — lane derivation.
//
// Single pure function `laneFor(card)` that decides which lane a card
// belongs in. UI components must call this rather than reading
// `card.lane` directly (the stored lane can lag behind the
// authoritative classification when, e.g., an `isAction` card has been
// promoted from "operator-review" → "needs-attention").
//
// Priority (per §5 of docs/HERMES_MONITOR_REDESIGN_SPEC.md):
//   - isAction always wins
//   - drafts next
//   - codex tasks → codex-needed
//   - deploy verifications → deploying
//   - closed cards → done
//   - everything else uses its explicit `lane` field
//
// Disagreements get litigated in lane-rules.test.ts, not in components.

import type { BoardCard, Lane } from "./card-types.js";

export function laneFor(card: BoardCard | undefined | null): Lane {
  if (!card) return "hermes-checking";
  if (card.isAction) return "needs-attention";
  if (card.isDraft) return "drafts";
  if (card.type === "task") return "codex-needed";
  if (card.type === "deploy") return "deploying";
  if (card.type === "done") return "done";
  return card.lane || "hermes-checking";
}

/**
 * P1-1: an "unrouted" card is one that only lands in `hermes-checking`
 * through `laneFor()`'s fallback — it carries no routing (it isn't an
 * action/draft, isn't a task/deploy/done, and has no explicit `lane`).
 * That's a bug (the classifier or an upstream source dropped the lane),
 * not a legitimate in-flight resident, so the UI renders these as a quiet,
 * collapsed "N unrouted" summary instead of loose junk-drawer cards. They
 * still appear in `hermes-checking` (laneFor is unchanged) — they're just
 * no longer loud.
 */
export function isUnroutedCard(card: BoardCard | undefined | null): boolean {
  if (!card) return true;
  if (card.isAction || card.isDraft) return false;
  if (card.type === "task" || card.type === "deploy" || card.type === "done") return false;
  return !card.lane;
}

/**
 * PR-D1 — DECIDE / WATCH / HIDE kanban tiers. Each of the 8 lanes belongs to
 * one tier (a coloring/grouping layer over the existing flat lanes, not a
 * re-routing of cards):
 *   - DECIDE: the Decision Inbox — `needs-attention`, the single lane that
 *     unions everything waiting on the operator (laneFor promotes isAction /
 *     operator-waiting cards here). DECIDE-orange (--h4-act) is reserved for
 *     this tier only.
 *   - WATCH:  in-flight pipeline lanes (drafts → deploying).
 *   - HIDE:   `done` (release history), de-emphasized.
 */
export type KanbanTier = "decide" | "watch" | "hide";

export function tierFor(lane: Lane): KanbanTier {
  if (lane === "needs-attention") return "decide";
  if (lane === "done") return "hide";
  return "watch";
}

/** Cards genuinely waiting on the human operator — the DECIDE workload. */
export function isWaitingOnOperator(card: BoardCard | undefined | null): boolean {
  if (!card) return false;
  return card.isAction === true || card.waitingOn?.actor === "operator";
}

export type InflightStatus = "Pre-check" | "CI watching" | "Mission running";

/**
 * Human status label for a legitimate in-flight `hermes-checking` card, so
 * every card in the lane reads as deliberate progress with a reason rather
 * than mystery noise.
 */
export function inflightStatus(card: BoardCard): InflightStatus {
  if (card.type === "mission") return "Mission running";
  if (card.waitingOn?.actor === "CI" || (card.checks?.running ?? 0) > 0) return "CI watching";
  return "Pre-check";
}

/**
 * Group cards by lane. Every lane appears in the result, even empty
 * ones — UI code can iterate the full LANES list and trust [].
 */
export function groupByLane(cards: BoardCard[]): Record<Lane, BoardCard[]> {
  const out: Record<Lane, BoardCard[]> = {
    "needs-attention": [],
    "drafts": [],
    "codex-needed": [],
    "hermes-checking": [],
    "operator-review": [],
    "release-queue": [],
    "deploying": [],
    "done": [],
  };
  if (!Array.isArray(cards)) return out;
  for (const card of cards) {
    out[laneFor(card)].push(card);
  }
  return out;
}

/** Count cards per lane. Convenience for the KPI strip. */
export function laneCounts(cards: BoardCard[]): Record<Lane, number> {
  const grouped = groupByLane(cards);
  return {
    "needs-attention": grouped["needs-attention"].length,
    "drafts": grouped["drafts"].length,
    "codex-needed": grouped["codex-needed"].length,
    "hermes-checking": grouped["hermes-checking"].length,
    "operator-review": grouped["operator-review"].length,
    "release-queue": grouped["release-queue"].length,
    "deploying": grouped["deploying"].length,
    "done": grouped["done"].length,
  };
}
