// Hermes Handoff Monitor — co-pilot rail (M8').
//
// The right-hand rail: header + the live collaboration turn stream +
// the Ask-Hermes composer. Questions are scoped to the focused card
// (relatedPr), recorded via /monitor/collaboration, and Hermes's reply
// shows up on the next poll. `/mission <url>` still spawns a browser
// mission (M7').

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { BoardCard, CreateTaskInput } from "../../lib/monitor/card-types.js";
import type { BacklogSuggestion, BacklogSuggestionsResponse } from "../../lib/monitor/backlog-suggestions.js";
import type { BoardNowBanner as BoardNowBannerData } from "../../lib/monitor/board-state.js";
import { relatedPrForCard, type CollaborationMessage } from "../../lib/monitor/collaboration.js";
import {
  buildHermesActivityFeed,
  type HermesActivityEntry,
} from "../../lib/monitor/activity-feed.js";
import { useCollaboration, type UseCollaborationOptions } from "../../hooks/useCollaboration.js";
import { AskHermesComposer } from "./AskHermesComposer.js";

export interface CoPilotRailProps {
  onSpawnMission?: (url: string) => void;
  /** Propose a greenfield Claude task (/claude <repo> <task>). */
  onSpawnClaudeTask?: (repo: string, prompt: string) => void;
  /** Propose a task (/task <agent> [<repo>#<pr>] <prompt>). */
  onCreateTask?: (input: CreateTaskInput) => void;
  /** Planner-only B1 follow-up suggestions. Read-only; never creates tasks. */
  backlogSuggestions?: BacklogSuggestionsResponse;
  /** Board cards used to link suggestions to their source card. */
  boardCards?: readonly BoardCard[];
  /** Current board "what needs you" summary. Appended to the activity feed. */
  boardBanner?: BoardNowBannerData;
  /** Focused card — scopes Ask-Hermes questions + the scope chip. */
  focusedCard?: BoardCard;
  /** Open a related card from a linked follow-up suggestion. */
  onCardClick?: (id: string) => void;
  /** Collaboration wiring. Omit to keep the rail inert (e.g. in BoardView tests). */
  collaboration?: UseCollaborationOptions;
  /** Mute action alerts until a timestamp (/mute). */
  onMute?: (untilMs: number) => void;
  /** Clear the mute (/unmute). */
  onUnmute?: () => void;
  /** Whether action alerts are currently muted. */
  muted?: boolean;
  /** Engage autopilot until `untilMs` (undefined → server 4h cap). */
  onSetAutopilot?: (untilMs?: number) => void;
  /** Revert to supervised. */
  onSetSupervised?: () => void;
  /** Current autonomy mode (drives the toggle chip). */
  autonomyMode?: "supervised" | "autopilot";
  /** Bump to focus the composer (the board's `a` shortcut). */
  composerFocusToken?: number;
  /** True only when real collaboration messages are scoped to a pending review card. */
  onScopedConversationChange?: (active: boolean) => void;
}

export function CoPilotRail({
  onSpawnMission,
  onSpawnClaudeTask,
  onCreateTask,
  backlogSuggestions,
  boardCards,
  boardBanner,
  focusedCard,
  onCardClick,
  collaboration,
  onMute,
  onUnmute,
  muted,
  onSetAutopilot,
  onSetSupervised,
  autonomyMode,
  composerFocusToken,
  onScopedConversationChange,
}: CoPilotRailProps) {
  const { messages, ask } = useCollaboration(collaboration ?? { enabled: false });
  const relatedPr = relatedPrForCard(focusedCard);
  const streamRef = useRef<HTMLDivElement>(null);
  const activity = useMemo(
    () => buildHermesActivityFeed({
      cards: boardCards ?? [],
      messages,
      banner: boardBanner ?? {
        tone: "calm",
        eyebrow: "Board now",
        headline: "Nothing waits on you. Hermes will narrate real board events when they arrive.",
        sub: "No current board summary was provided to the rail.",
        primaryActionId: undefined,
      },
    }),
    [boardBanner, boardCards, messages],
  );

  const scopedConversationActive = useMemo(
    () => hasScopedConversation(messages, focusedCard),
    [focusedCard, messages],
  );
  useEffect(() => {
    onScopedConversationChange?.(scopedConversationActive);
  }, [onScopedConversationChange, scopedConversationActive]);

  // Keep the newest turn in view as the feed grows.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity.length]);

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
            Live activity · context: {focusedCard?.id ?? "whole board"}
          </div>
        </div>
      </div>

      <BacklogSuggestionsRailBlock
        response={backlogSuggestions}
        boardCards={boardCards ?? []}
        onCardClick={onCardClick}
      />

      <section className="hm-activity" aria-label="Hermes activity">
        <div className="hm-activity-head">
          <span className="hm-kicker">Activity</span>
          <strong>What Hermes sees</strong>
        </div>
        <div className="hm-hermes-stream hm-activity-stream" ref={streamRef} aria-live="polite">
          {activity.map((entry) => (
            <ActivityEntryRow entry={entry} onCardClick={onCardClick} key={entry.id} />
          ))}
        </div>
      </section>

      <AskHermesComposer
        onSpawnMission={onSpawnMission}
        onSpawnClaudeTask={onSpawnClaudeTask}
        onCreateTask={onCreateTask}
        onAsk={(text) => ask(text, relatedPr)}
        onMute={onMute}
        onUnmute={onUnmute}
        muted={muted}
        onSetAutopilot={onSetAutopilot}
        onSetSupervised={onSetSupervised}
        autonomyMode={autonomyMode}
        focusedCardId={focusedCard?.id ?? null}
        focusToken={composerFocusToken}
      />
    </aside>
  );
}

function hasScopedConversation(messages: readonly CollaborationMessage[], card: BoardCard | undefined): boolean {
  if (!card || card.waitingOn?.actor !== "operator" || (card.lane !== "operator-review" && card.isAction !== true)) {
    return false;
  }
  return messages.some((message) => (
    (message.author === "operator" || message.author === "hermes")
    && messageMatchesCard(message, card)
  ));
}

function messageMatchesCard(message: CollaborationMessage, card: BoardCard): boolean {
  const relatedPr = relatedPrForCard(card);
  if (
    relatedPr
    && message.relatedPr?.repo === relatedPr.repo
    && message.relatedPr.number === relatedPr.number
  ) {
    return true;
  }
  const correlation = card.correlationId ?? card.id;
  return Boolean(message.relatedCorrelationId && message.relatedCorrelationId === correlation);
}

function ActivityEntryRow({
  entry,
  onCardClick,
}: {
  entry: HermesActivityEntry;
  onCardClick?: (id: string) => void;
}) {
  const body = (
    <>
      <span className="hm-activity-dot" aria-hidden />
      <span>
        <strong>{entry.text}</strong>
        {entry.meta ? <small>{entry.meta}</small> : null}
      </span>
    </>
  );
  if (entry.cardId && onCardClick) {
    return (
      <button
        type="button"
        className={`hm-activity-row hm-activity-row--${entry.tone}`}
        onClick={() => onCardClick(entry.cardId!)}
        aria-label={`Open card ${entry.cardId}`}
      >
        {body}
        <span className="hm-activity-link">{entry.cardId}</span>
      </button>
    );
  }
  return (
    <div className={`hm-activity-row hm-activity-row--${entry.tone}`}>
      {body}
      {entry.cardId ? <span className="hm-activity-link">{entry.cardId}</span> : null}
    </div>
  );
}

function BacklogSuggestionsRailBlock({
  response,
  boardCards,
  onCardClick,
}: {
  response?: BacklogSuggestionsResponse;
  boardCards: readonly BoardCard[];
  onCardClick?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const suggestions = response?.suggestions?.slice(0, 3) ?? [];
  const cardsById = useMemo(() => new Map(boardCards.map((card) => [card.id, card])), [boardCards]);

  if (!response) return null;

  return (
    <section className="hm-backlog-suggestions hm-backlog-suggestions--rail" aria-label="Suggested follow-ups">
      <button
        type="button"
        className="hm-backlog-suggestions-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span>
        <span>
          <span className="hm-kicker">Suggested follow-ups ({suggestions.length})</span>
          <strong>planner-only · read-only</strong>
        </span>
        <span className="hm-backlog-suggestions-safety">no tasks created</span>
      </button>
      {open ? (
        <div className="hm-backlog-suggestions-grid" id={bodyId}>
          {suggestions.length > 0 ? suggestions.map((suggestion) => (
            <BacklogSuggestionRow
              suggestion={suggestion}
              relatedCard={cardsById.get(suggestion.related.cardId)}
              onCardClick={onCardClick}
              key={suggestion.id}
            />
          )) : (
            <div className="hm-backlog-suggestion-empty">No follow-up suggestions right now.</div>
          )}
        </div>
      ) : null}
    </section>
  );
}

function BacklogSuggestionRow({
  suggestion,
  relatedCard,
  onCardClick,
}: {
  suggestion: BacklogSuggestion;
  relatedCard?: BoardCard;
  onCardClick?: (id: string) => void;
}) {
  const copyPrompt = () => {
    if (!suggestion.suggestedPrompt || typeof navigator === "undefined") return;
    void navigator.clipboard?.writeText(suggestion.suggestedPrompt);
  };
  return (
    <div className="hm-backlog-suggestion-row">
      <span>
        <strong>{suggestion.title}</strong>
        <small>{suggestion.reason}</small>
      </span>
      <span className="hm-backlog-suggestion-meta">
        {suggestion.suggestedOwner} · {suggestion.riskTier} · {Math.round(suggestion.confidence * 100)}%
      </span>
      {relatedCard ? (
        onCardClick ? (
          <button
            type="button"
            className="hm-backlog-link"
            onClick={() => onCardClick(relatedCard.id)}
            aria-label={`Open related card ${relatedCard.id}`}
          >
            Open card
          </button>
        ) : (
          <span className="hm-backlog-link">linked card</span>
        )
      ) : null}
      {suggestion.suggestedPrompt ? (
        <button type="button" className="hm-backlog-copy" onClick={copyPrompt}>
          Copy prompt
        </button>
      ) : null}
    </div>
  );
}
