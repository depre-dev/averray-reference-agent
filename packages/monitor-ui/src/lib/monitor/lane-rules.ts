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
