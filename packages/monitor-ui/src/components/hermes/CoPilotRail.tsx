// Hermes Handoff Monitor — co-pilot rail (M8').
//
// The right-hand rail: header + the live collaboration turn stream +
// the Ask-Hermes composer. Questions are scoped to the focused card
// (relatedPr), recorded via /monitor/collaboration, and Hermes's reply
// shows up on the next poll. `/mission <url>` still spawns a browser
// mission (M7').

import { useEffect, useRef } from "react";
import type { BoardCard, CreateTaskInput } from "../../lib/monitor/card-types.js";
import { relatedPrForCard } from "../../lib/monitor/collaboration.js";
import { useCollaboration, type UseCollaborationOptions } from "../../hooks/useCollaboration.js";
import { AskHermesComposer } from "./AskHermesComposer.js";
import { HermesTurn } from "./HermesTurn.js";

export interface CoPilotRailProps {
  onSpawnMission?: (url: string) => void;
  /** Propose a greenfield Claude task (/claude <repo> <task>). */
  onSpawnClaudeTask?: (repo: string, prompt: string) => void;
  /** Propose a task (/task <agent> [<repo>#<pr>] <prompt>). */
  onCreateTask?: (input: CreateTaskInput) => void;
  /** Focused card — scopes Ask-Hermes questions + the scope chip. */
  focusedCard?: BoardCard;
  /** Collaboration wiring. Omit to keep the rail inert (e.g. in BoardView tests). */
  collaboration?: UseCollaborationOptions;
  /** Mute action alerts until a timestamp (/mute). */
  onMute?: (untilMs: number) => void;
  /** Clear the mute (/unmute). */
  onUnmute?: () => void;
  /** Whether action alerts are currently muted. */
  muted?: boolean;
  /** Bump to focus the composer (the board's `a` shortcut). */
  composerFocusToken?: number;
}

export function CoPilotRail({
  onSpawnMission,
  onSpawnClaudeTask,
  onCreateTask,
  focusedCard,
  collaboration,
  onMute,
  onUnmute,
  muted,
  composerFocusToken,
}: CoPilotRailProps) {
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
            Ask about any card · context: {focusedCard?.id ?? "whole board"}
          </div>
        </div>
      </div>

      <div className="hm-hermes-stream" ref={streamRef} aria-live="polite">
        {messages.length === 0 ? (
          <div className="hm-lane-empty">
            Nothing asked yet. Ask Hermes about a card or the board below — replies show up here.
          </div>
        ) : (
          messages.map((m) => <HermesTurn key={m.id} turn={m} />)
        )}
      </div>

      <AskHermesComposer
        onSpawnMission={onSpawnMission}
        onSpawnClaudeTask={onSpawnClaudeTask}
        onCreateTask={onCreateTask}
        onAsk={(text) => ask(text, relatedPr)}
        onMute={onMute}
        onUnmute={onUnmute}
        muted={muted}
        focusedCardId={focusedCard?.id ?? null}
        focusToken={composerFocusToken}
      />
    </aside>
  );
}
