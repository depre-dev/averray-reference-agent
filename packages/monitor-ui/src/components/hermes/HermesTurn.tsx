// Hermes Handoff Monitor — a single collaboration turn (M8').

import type { CollaborationAuthor, CollaborationMessage, CollaborationTarget } from "../../lib/monitor/collaboration.js";
import { actorLabel, actorLabelForMessage, formatTurnTime } from "../../lib/monitor/collaboration.js";
import type { CSSProperties } from "react";

const PROMINENT_TURN_STYLE: CSSProperties = {
  borderLeftColor: "var(--hm-amber)",
  background: "var(--hm-amber-soft, #fff3df)",
};

const MUTED_TURN_STYLE: CSSProperties = {
  opacity: 0.72,
  background: "rgba(255, 253, 247, 0.58)",
};

const DEFAULT_TURN_STYLE: CSSProperties = {};

export function HermesTurn({
  turn,
  cardId,
  onCardClick,
}: {
  turn: CollaborationMessage;
  cardId?: string;
  onCardClick?: (id: string) => void;
}) {
  const prHref = turn.relatedPr
    ? `https://github.com/${turn.relatedPr.repo}/pull/${turn.relatedPr.number}`
    : undefined;
  const pending = turn.id.startsWith("optimistic-");
  const rank = rankForKind(turn.kind);

  return (
    <div
      className={`hm-turn hm-turn--${turn.author} hm-turn--kind-${turn.kind} hm-turn--rank-${rank}`}
      style={turnStyleForKind(turn.kind)}
    >
      <div className="hm-turn-head">
        <span className="hm-turn-actor">
          <span className="actor-dot" aria-hidden />
          {roomActorLabel(turn)}
        </span>
        <span className="hm-turn-kind">
          · {kindLabel(turn.kind)}
          {pending ? " · pending" : ""}
        </span>
        <span className="hm-turn-time">{formatTurnTime(turn.ts)}</span>
      </div>
      <div className="hm-turn-body">{turn.text}</div>
      {cardId ? (
        <CardPin cardId={cardId} onCardClick={onCardClick} />
      ) : turn.relatedPr ? (
        <a className="hm-turn-pin" href={prHref} target="_blank" rel="noreferrer">
          <span className="pin-id">#{turn.relatedPr.number}</span>
          <span className="pin-title">{turn.relatedPr.repo}</span>
        </a>
      ) : null}
    </div>
  );
}

function CardPin({
  cardId,
  onCardClick,
}: {
  cardId: string;
  onCardClick?: (id: string) => void;
}) {
  const content = (
    <>
      <span className="pin-id">{cardId}</span>
      <span className="pin-title">Referenced card</span>
      <span className="pin-arrow">{onCardClick ? "open ›" : "referenced"}</span>
    </>
  );
  if (!onCardClick) return <div className="hm-turn-pin">{content}</div>;
  return (
    <button
      type="button"
      className="hm-turn-pin"
      onClick={() => onCardClick(cardId)}
      aria-label={`Open referenced card ${cardId}`}
    >
      {content}
    </button>
  );
}

function roomActorLabel(turn: CollaborationMessage): string {
  return `${authorLabel(turn.author, turn)} → ${targetLabel(turn.addressedTo)}`;
}

function authorLabel(author: CollaborationAuthor, turn: CollaborationMessage): string {
  if (author === "operator") return "You";
  return actorLabelForMessage(turn);
}

function targetLabel(target: CollaborationTarget): string {
  if (target === "everyone") return "everyone";
  if (target === "operator") return "You";
  return actorLabel(target);
}

function kindLabel(kind: CollaborationMessage["kind"]): string {
  if (kind === "request_help") return "request help";
  return kind;
}

function rankForKind(kind: CollaborationMessage["kind"]): "prominent" | "normal" | "muted" {
  if (kind === "request_help" || kind === "proposal") return "prominent";
  if (kind === "status") return "muted";
  return "normal";
}

function turnStyleForKind(kind: CollaborationMessage["kind"]): CSSProperties {
  if (kind === "request_help" || kind === "proposal") {
    return PROMINENT_TURN_STYLE;
  }
  if (kind === "status") {
    return MUTED_TURN_STYLE;
  }
  return DEFAULT_TURN_STYLE;
}
