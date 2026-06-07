// Hermes Handoff Monitor — Hermes-checking lane body (P1-1)
//
// The `hermes-checking` lane used to be a junk drawer: every legitimately
// in-flight card (a pre-check, a CI watch, a running mission) sat next to
// any *unrouted* card that only landed here through laneFor()'s fallback —
// all visually equal, none explained.
//
// This body splits the two:
//   - Legit in-flight cards each get a status label ("Pre-check" /
//     "CI watching" / "Mission running") so the operator reads them as
//     deliberate progress with a reason.
//   - Unrouted cards (a bug — the classifier/source dropped the lane) are
//     rolled into ONE de-emphasized, collapsed-by-default summary with a
//     count ("3 unrouted — source may be offline"). Honest, but quiet: the
//     cards are still inspectable on expand, they just don't shout.

import type { CSSProperties, ReactNode } from "react";
import type { BoardCard } from "../lib/monitor/card-types.js";
import { isUnroutedCard, inflightStatus } from "../lib/monitor/lane-rules.js";

export type HermesCheckingBodyProps = {
  cards: BoardCard[];
  /** The per-card renderer supplied by BoardView (pipeline mirror or full card, depending on caller). */
  renderCard: (card: BoardCard) => ReactNode;
};

const STATUS_LABEL_STYLE: CSSProperties = {
  display: "block",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--hm-muted)",
  margin: "0 0 2px 2px",
};

const SUMMARY_STYLE: CSSProperties = {
  cursor: "pointer",
  listStyle: "none",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
  color: "var(--hm-muted)",
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px dashed var(--hm-border, rgba(255,255,255,0.12))",
};

export function HermesCheckingBody({ cards, renderCard }: HermesCheckingBodyProps) {
  const routed = cards.filter((card) => !isUnroutedCard(card));
  const unrouted = cards.filter((card) => isUnroutedCard(card));

  return (
    <>
      {routed.map((card) => (
        <div key={card.id} className="hm-inflight">
          <span className="hm-inflight-status" style={STATUS_LABEL_STYLE}>
            {inflightStatus(card)}
          </span>
          {renderCard(card)}
        </div>
      ))}

      {unrouted.length > 0 ? (
        // Collapsed by default — native <details> with no `open` attribute.
        <details className="hm-unrouted">
          <summary className="hm-unrouted-summary" style={SUMMARY_STYLE}>
            <span
              className="fresh-dot"
              style={{ background: "var(--hm-offline)" }}
              aria-hidden
            />
            {unrouted.length} unrouted — source may be offline
          </summary>
          <div className="hm-unrouted-cards" style={{ marginTop: 6 }}>
            {unrouted.map((card) => renderCard(card))}
          </div>
        </details>
      ) : null}
    </>
  );
}
