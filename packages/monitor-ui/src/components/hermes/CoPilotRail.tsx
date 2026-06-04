// Hermes Handoff Monitor — co-pilot rail (M8').
//
// The right-hand rail: header + the live collaboration turn stream +
// the Ask-Hermes composer. Questions are scoped to the focused card
// (relatedPr), recorded via /monitor/collaboration, and Hermes's reply
// shows up on the next poll. `/mission <url>` still spawns a browser
// mission (M7').

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { BoardCard, CreateTaskInput } from "../../lib/monitor/card-types.js";
import type { BacklogSuggestion, BacklogSuggestionsResponse } from "../../lib/monitor/backlog-suggestions.js";
import type { BoardNowBanner as BoardNowBannerData } from "../../lib/monitor/board-state.js";
import {
  formatTurnTime,
  relatedPrForCard,
  type CollaborationMessage,
} from "../../lib/monitor/collaboration.js";
import { useCollaboration, type UseCollaborationOptions } from "../../hooks/useCollaboration.js";
import { AskHermesComposer } from "./AskHermesComposer.js";
import { HermesTurn } from "./HermesTurn.js";

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
  const { messages, ask, enabled, pending, sendError } = useCollaboration(
    collaboration ?? { enabled: false },
  );
  const relatedPr = relatedPrForCard(focusedCard);
  const streamRef = useRef<HTMLDivElement>(null);
  // Suggestion chips fill the composer: hold the text + a bump token.
  const [prefill, setPrefill] = useState("");
  const [prefillToken, setPrefillToken] = useState(0);
  const fillComposer = (text: string) => {
    setPrefill(text);
    setPrefillToken((t) => t + 1);
  };
  const roomThreads = useMemo(
    () => buildRoomThreads(messages, boardCards ?? []),
    [boardCards, messages],
  );

  const scopedConversationActive = useMemo(
    () => hasScopedConversation(messages, focusedCard),
    [focusedCard, messages],
  );
  const templateModeObserved = useMemo(
    () => messages.some((message) => message.author === "hermes" && message.hermesMode === "templated"),
    [messages],
  );
  useEffect(() => {
    onScopedConversationChange?.(scopedConversationActive);
  }, [onScopedConversationChange, scopedConversationActive]);

  // Keep the newest turn in view as the feed grows.
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, roomThreads.length]);

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
        onUseInComposer={fillComposer}
      />

      {templateModeObserved ? (
        <div className="hm-hermes-mode-banner" role="status">
          Hermes is offline — replies are templated until the live model key is configured.
        </div>
      ) : null}

      <section className="hm-activity" aria-label="Multi-agent collaboration room">
        <div className="hm-activity-head">
          <span className="hm-kicker">Room</span>
          <strong>Agent collaboration</strong>
        </div>
        <div className="hm-hermes-stream hm-activity-stream" ref={streamRef} aria-live="polite">
          {roomThreads.length > 0 ? (
            roomThreads.map((thread) => (
              <RoomThreadBlock
                thread={thread}
                onCardClick={onCardClick}
                key={thread.key}
              />
            ))
          ) : (
            <RoomEmptyState />
          )}
          <BoardSummaryRow
            banner={boardBanner}
            onCardClick={onCardClick}
          />
        </div>
      </section>

      <AskHermesComposer
        onSpawnMission={onSpawnMission}
        onSpawnClaudeTask={onSpawnClaudeTask}
        onCreateTask={onCreateTask}
        onAsk={(text, opts) => ask(text, opts?.scope === "board" ? undefined : relatedPr, opts?.target ?? "everyone")}
        onMute={onMute}
        onUnmute={onUnmute}
        muted={muted}
        onSetAutopilot={onSetAutopilot}
        onSetSupervised={onSetSupervised}
        autonomyMode={autonomyMode}
        prefill={prefill}
        prefillToken={prefillToken}
        focusedCardId={focusedCard?.id ?? null}
        focusToken={composerFocusToken}
        collaborationEnabled={enabled}
        pending={pending}
        sendError={sendError}
      />
    </aside>
  );
}

interface RoomThread {
  key: string;
  label: string;
  cardId?: string;
  latestTs: number;
  turns: CollaborationMessage[];
}

const ROOM_THREAD_STYLE: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: 8,
  border: "1px solid var(--hm-line)",
  borderRadius: 8,
  background: "rgba(255, 253, 247, 0.7)",
};

const ROOM_THREAD_HEAD_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  color: "var(--hm-muted)",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: ".08em",
};

const ROOM_THREAD_LABEL_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ROOM_EMPTY_STYLE: CSSProperties = { opacity: 0.78 };
const BOARD_SUMMARY_STYLE: CSSProperties = { opacity: 0.86 };

function buildRoomThreads(messages: readonly CollaborationMessage[], cards: readonly BoardCard[]): RoomThread[] {
  const threads = new Map<string, RoomThread>();
  const sorted = [...messages].sort((a, b) => a.ts - b.ts);
  for (const message of sorted) {
    const key = threadKeyForMessage(message);
    const existing = threads.get(key);
    const label = threadLabelForMessage(message);
    const cardId = cardIdForMessage(message, cards);
    if (existing) {
      existing.turns.push(message);
      existing.latestTs = Math.max(existing.latestTs, message.ts);
      if (!existing.cardId && cardId) existing.cardId = cardId;
    } else {
      threads.set(key, {
        key,
        label,
        ...(cardId ? { cardId } : {}),
        latestTs: message.ts,
        turns: [message],
      });
    }
  }
  return [...threads.values()].sort((a, b) => a.latestTs - b.latestTs);
}

function threadKeyForMessage(message: CollaborationMessage): string {
  if (message.relatedPr) return `pr:${message.relatedPr.repo}#${message.relatedPr.number}`;
  if (message.relatedCorrelationId) return `correlation:${message.relatedCorrelationId}`;
  return "room:whole-board";
}

function threadLabelForMessage(message: CollaborationMessage): string {
  if (message.relatedPr) return `${message.relatedPr.repo} #${message.relatedPr.number}`;
  if (message.relatedCorrelationId) return message.relatedCorrelationId;
  return "Whole board";
}

function cardIdForMessage(message: CollaborationMessage, cards: readonly BoardCard[]): string | undefined {
  if (message.relatedPr) {
    const messagePr = message.relatedPr;
    const card = cards.find((candidate) => {
      const cardPr = relatedPrForCard(candidate);
      return cardPr?.repo === messagePr.repo && cardPr.number === messagePr.number;
    });
    if (card) return card.id;
  }
  if (message.relatedCorrelationId) {
    const card = cards.find((candidate) => (
      candidate.id === message.relatedCorrelationId || candidate.correlationId === message.relatedCorrelationId
    ));
    if (card) return card.id;
  }
  return undefined;
}

function RoomThreadBlock({
  thread,
  onCardClick,
}: {
  thread: RoomThread;
  onCardClick?: (id: string) => void;
}) {
  return (
    <div
      className="hm-room-thread"
      style={ROOM_THREAD_STYLE}
    >
      <div
        className="hm-room-thread-head"
        style={ROOM_THREAD_HEAD_STYLE}
      >
        <span style={ROOM_THREAD_LABEL_STYLE}>
          Thread · {thread.label}
        </span>
        <span>{thread.turns.length} turn{thread.turns.length === 1 ? "" : "s"}</span>
      </div>
      {thread.cardId ? (
        <ActivityPin cardId={thread.cardId} onCardClick={onCardClick} />
      ) : null}
      {thread.turns.map((turn) => (
        <HermesTurn
          turn={turn}
          onCardClick={onCardClick}
          key={turn.id}
        />
      ))}
    </div>
  );
}

function RoomEmptyState() {
  return (
    <div
      className="hm-turn hm-turn--system hm-turn--kind-status"
      style={ROOM_EMPTY_STYLE}
    >
      <div className="hm-turn-head">
        <span className="hm-turn-actor">
          <span className="actor-dot" aria-hidden />
          Room
        </span>
        <span className="hm-turn-kind">· empty</span>
      </div>
      <div className="hm-turn-body">
        No agent chatter yet.
        <small>Real Hermes, Codex, Claude, and specialist turns will appear here when recorded.</small>
      </div>
    </div>
  );
}

function BoardSummaryRow({
  banner,
  onCardClick,
}: {
  banner?: BoardNowBannerData;
  onCardClick?: (id: string) => void;
}) {
  const summary = boardSummaryCopy(banner);
  return (
    <div className="hm-turn hm-turn--system hm-turn--kind-status" style={BOARD_SUMMARY_STYLE}>
      <div className="hm-turn-head">
        <span className="hm-turn-actor">
          <span className="actor-dot" aria-hidden />
          Board
        </span>
        <span className="hm-turn-kind">· current summary</span>
        <span className="hm-turn-time">{formatTurnTime(Date.now())}</span>
      </div>
      <div className="hm-turn-body">
        <b>{summary.headline}:</b> {summary.text}
        {banner?.sub ? <small>{banner.sub}</small> : null}
      </div>
      {banner?.primaryActionId ? (
        <ActivityPin cardId={banner.primaryActionId} onCardClick={onCardClick} />
      ) : null}
    </div>
  );
}

function boardSummaryCopy(banner: BoardNowBannerData | undefined): { headline: string; text: string } {
  if (!banner) {
    return {
      headline: "Board summary",
      text: "No current board summary was provided to the rail.",
    };
  }
  if (banner.tone === "action") {
    return {
      headline: "Needs you",
      text: `Operator review is waiting${banner.primaryActionId ? ` on ${banner.primaryActionId}` : " in the action lane"}.`,
    };
  }
  if (banner.tone === "degraded") {
    return {
      headline: "Freshness warning",
      text: "Reconnect or verify freshness before approving board state.",
    };
  }
  if (banner.tone === "hermes-focus") {
    return {
      headline: "Active review thread",
      text: `A scoped review conversation is active${banner.primaryActionId ? ` on ${banner.primaryActionId}` : ""}.`,
    };
  }
  return {
    headline: "Nothing urgent",
    text: "No operator decision is waiting in the room right now.",
  };
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

function ActivityPin({
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
  if (!onCardClick) {
    return <div className="hm-turn-pin">{content}</div>;
  }
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

function BacklogSuggestionsRailBlock({
  response,
  boardCards,
  onCardClick,
  onUseInComposer,
}: {
  response?: BacklogSuggestionsResponse;
  boardCards: readonly BoardCard[];
  onCardClick?: (id: string) => void;
  onUseInComposer?: (text: string) => void;
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
              onUseInComposer={onUseInComposer}
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
  onUseInComposer,
}: {
  suggestion: BacklogSuggestion;
  relatedCard?: BoardCard;
  onCardClick?: (id: string) => void;
  onUseInComposer?: (text: string) => void;
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
      {suggestion.suggestedPrompt && onUseInComposer ? (
        <button
          type="button"
          className="hm-backlog-use"
          onClick={() => onUseInComposer(suggestion.suggestedPrompt!)}
        >
          Use in composer
        </button>
      ) : null}
      {suggestion.suggestedPrompt ? (
        <button type="button" className="hm-backlog-copy" onClick={copyPrompt}>
          Copy prompt
        </button>
      ) : null}
    </div>
  );
}
