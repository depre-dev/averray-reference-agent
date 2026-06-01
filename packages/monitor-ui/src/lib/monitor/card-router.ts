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

export function defaultDegradedContent(card: BoardCard): DegradedContent {
  const reason = card.sourceFailure;
  const source = reason?.source ?? "source";
  const code = reason?.code;
  const lastGood = reason?.lastGoodAt;

  if (card.state === "source-offline") {
    return {
      body: reason?.message
        ?? "Upstream unreachable. This card is the last successful read; values may be stale. Hermes is not paging until the upstream returns.",
      pills: [
        ["hm-pill--offline", `${source} · offline${code ? ` · ${code}` : ""}`],
        ["hm-pill--neutral", lastGood ? `last good ${lastGood}` : "cached"],
      ],
      action: "View last known",
    };
  }
  return {
    body: reason?.message
      ?? "Upstream returned an error. The card may have been removed, force-pushed, or the source temporarily unavailable.",
    pills: [
      ["hm-pill--err", `${source} · ${code ?? "fetch failed"}`],
      ["hm-pill--neutral", lastGood ? `last good ${lastGood}` : "retry available"],
    ],
    action: "Retry now",
  };
}
