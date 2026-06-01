// Hermes Handoff Monitor — a single collaboration turn (M8').

import type { CollaborationMessage } from "../../lib/monitor/collaboration.js";
import { actorLabelForMessage, formatTurnTime } from "../../lib/monitor/collaboration.js";

export function HermesTurn({ turn }: { turn: CollaborationMessage }) {
  const prHref = turn.relatedPr
    ? `https://github.com/${turn.relatedPr.repo}/pull/${turn.relatedPr.number}`
    : undefined;

  return (
    <div className={"hm-turn hm-turn--" + turn.author}>
      <div className="hm-turn-head">
        <span className="hm-turn-actor">
          <span className="actor-dot" aria-hidden />
          {actorLabelForMessage(turn)}
        </span>
        <span style={{ marginLeft: 4, opacity: 0.7, fontWeight: 500, letterSpacing: 0 }}>· {turn.kind}</span>
        <span className="hm-turn-time">{formatTurnTime(turn.ts)}</span>
      </div>
      <div className="hm-turn-body">{turn.text}</div>
      {turn.relatedPr ? (
        <a className="hm-turn-pin" href={prHref} target="_blank" rel="noreferrer">
          <span className="pin-id">#{turn.relatedPr.number}</span>
          <span className="pin-title">{turn.relatedPr.repo}</span>
        </a>
      ) : null}
    </div>
  );
}
