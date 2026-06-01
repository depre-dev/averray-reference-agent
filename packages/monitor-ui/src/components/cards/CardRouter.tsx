// Hermes Handoff Monitor — CardRouter
//
// React-side dispatch between <Card> and <DegradedCard>. The decision
// logic lives in lib/monitor/card-router.ts (pure, tested); this
// component just consumes it. The dispatch is the gate that enforces
// "we never silently fall back to a fresh-looking card when the data is
// broken" (§16).

import type { BoardCard } from "../../lib/monitor/card-types.js";
import { pickRenderer, defaultDegradedContent } from "../../lib/monitor/card-router.js";
import { Card } from "./Card.js";
import { DegradedCard } from "./DegradedCard.js";

export type CardRouterProps = {
  card: BoardCard;
  focused?: boolean;
  onClick?: (card: BoardCard) => void;
  /** Click handler for the degraded card's primary action (Retry / View last known). */
  onDegradedAction?: (card: BoardCard) => void;
  /** Approve a proposed task card (O3 dispatch). */
  onApprove?: (card: BoardCard) => void;
  /** Approve a board-gated requested tester mission (T6). */
  onApproveMission?: (card: BoardCard) => void;
  /** Approve a PR for merge review. Opens/records only; humans still merge. */
  onApproveMerge?: (card: BoardCard) => void;
  /** Re-run a failed tester mission. */
  onRerunMission?: (card: BoardCard, freshness: "fresh" | "memory") => void;
  /** "Keep watching" on the archive hint — cancel this card's auto-archive. */
  onKeepWatching?: (card: BoardCard) => void;
};

export function CardRouter({
  card,
  focused,
  onClick,
  onDegradedAction,
  onApprove,
  onApproveMission,
  onApproveMerge,
  onRerunMission,
  onKeepWatching,
}: CardRouterProps) {
  const renderer = pickRenderer(card);

  if (renderer === "degraded") {
    const content = defaultDegradedContent(card);
    return (
      <DegradedCard
        card={card}
        body={content.body}
        pills={content.pills}
        action={content.action}
        onClick={onClick}
        onAction={onDegradedAction ? () => onDegradedAction(card) : undefined}
      />
    );
  }

  return (
    <Card
      card={card}
      focused={focused}
      onClick={onClick}
      onApprove={onApprove}
      onApproveMission={onApproveMission}
      onApproveMerge={onApproveMerge}
      onRerunMission={onRerunMission}
      onKeepWatching={onKeepWatching}
    />
  );
}
