// Hermes Handoff Monitor — card-render dispatch logic.
//
// Decides which renderer a given card uses:
//   - "card"     → unified <Card /> (fresh / stale / running / done)
//   - "degraded" → <DegradedCard /> (failed-fetch / source-offline)
//
// The dispatch is the gate that enforces "we never silently fall back
// to a fresh-looking card when the data is broken" (§16 of the spec).

import type { BoardCard } from "./card-types.js";

export type CardRenderer = "card" | "degraded";

export function pickRenderer(card: BoardCard | undefined | null): CardRenderer {
  if (!card) return "card";
  if (card.state === "failed-fetch") return "degraded";
  if (card.state === "source-offline") return "degraded";
  return "card";
}

export interface DegradedContent {
  body: string;
  pills: Array<[pillClass: string, label: string]>;
  action: string;
}

/**
 * Default body / pills / action for a degraded card. Per-type overrides
 * (mission "Fresh run", deploy "View raw logs", etc.) come in later
 * milestones when the API returns degraded payloads with reason codes.
 */
export function defaultDegradedContent(card: BoardCard): DegradedContent {
  if (card.state === "source-offline") {
    return {
      body: "Upstream unreachable. This card is the last successful read; values may be stale. Hermes is not paging until the upstream returns.",
      pills: [
        ["hm-pill--offline", "source · offline"],
        ["hm-pill--neutral", "cached"],
      ],
      action: "View last known",
    };
  }
  return {
    body: "Upstream returned an error. The card may have been removed, force-pushed, or the source temporarily unavailable.",
    pills: [
      ["hm-pill--err", "fetch failed"],
      ["hm-pill--neutral", "retry available"],
    ],
    action: "Retry now",
  };
}
