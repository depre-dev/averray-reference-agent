// Hermes Handoff Monitor — co-pilot rail (M8').
//
// The right-hand rail: header + the live collaboration turn stream +
// the Ask-Hermes composer. Questions are scoped to the focused card
// (relatedPr), recorded via /monitor/collaboration, and Hermes's reply
// shows up on the next poll. `/mission <url>` still spawns a browser
// mission (M7').

import { useEffect, useRef } from "react";
import type { BoardCard } from "../../lib/monitor/card-types.js";
import { relatedPrForCard } from "../../lib/monitor/collaboration.js";
import { useCollaboration, type UseCollaborationOptions } from "../../hooks/useCollaboration.js";
import { AskHermesComposer } from "./AskHermesComposer.js";
import { HermesTurn } from "./HermesTurn.js";

export interface CoPilotRailProps {
  onSpawnMission?: (url: string) => void;
  /** Focused card — scopes Ask-Hermes questions + the scope chip. */
  focusedCard?: BoardCard;
  /** Collaboration wiring. Omit to keep the rail inert (e.g. in BoardView tests). */
  collaboration?: UseCollaborationOptions;
}

export function CoPilotRail({ onSpawnMission, focusedCard, collaboration }: CoPilotRailProps) {
  const { messages, ask } = useCollaboration(collaboration ?? { enabled: false });
  const relatedPr = relatedPrForCard(focusedCard);
  const streamRef = useRef<HTMLDivElement>(null);

  // Keep the newest turn in view as the feed grows.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <aside className="hm-hermes" role="complementary" aria-label="Hermes co-pilot">
      {/* A <div>, not <header>: only the TopStrip is the page banner landmark. */}
      <div className="hm-hermes-head">
        <div className="hm-hermes-mark" aria-hidden>
          H
        </div>
        <div>
          <div className="hm-hermes-title">Hermes co-pilot</div>
          <div className="hm-hermes-sub">
            <span className="pulse" aria-hidden />
            Live · narrating the board · context: {focusedCard?.id ?? "everywhere"}
          </div>
        </div>
      </div>

      <div className="hm-hermes-stream" ref={streamRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className="hm-lane-empty">No board chatter yet.</div>
        ) : (
          messages.map((m) => <HermesTurn key={m.id} turn={m} />)
        )}
      </div>

      <AskHermesComposer
        onSpawnMission={onSpawnMission}
        onAsk={(text) => ask(text, relatedPr)}
        focusedCardId={focusedCard?.id ?? null}
      />
    </aside>
  );
}
