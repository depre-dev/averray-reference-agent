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
import {
  formatTurnTime,
  relatedPrForCard,
  type CollaborationMessage,
} from "../../lib/monitor/collaboration.js";
import { useCollaboration, type UseCollaborationOptions } from "../../hooks/useCollaboration.js";
import { derivePresence, activeCount, type PresencePeer } from "../../lib/monitor/presence.js";
import { railDigestCounts } from "../../lib/monitor/rail-digest.js";
import { isDecision } from "../../lib/monitor/lane-rules.js";
import { shortId } from "../../lib/monitor/card-id.js";
import { AgentTag, Badge, Button, EmptyState, StatusPill, type AgentTagAgent, type StateVariant } from "../ui.js";
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
  const digestPanelId = useId();
  const roomPanelId = useId();
  const [railTab, setRailTab] = useState<"digest" | "room">("digest");
  const [rosterOpen, setRosterOpen] = useState(false);
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
  // PR-D3c: who's in the room, from real signals only (workingNow → active,
  // recent collaboration authors → online). Recomputes as messages/cards move.
  const peers = useMemo(
    () => derivePresence({ messages, cards: boardCards ?? [], nowMs: Date.now() }),
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

      {templateModeObserved ? (
        <div className="hm-hermes-mode-banner" role="status">
          Hermes is offline — replies are templated until the live model key is configured.
        </div>
      ) : null}

      <div className="hm-rail-tabs" role="tablist" aria-label="Hermes rail views">
        <RailTab
          active={railTab === "digest"}
          badge={railDigestCounts(boardCards ?? []).needsYou}
          controls={digestPanelId}
          label="Digest"
          onClick={() => setRailTab("digest")}
        />
        <RailTab
          active={railTab === "room"}
          controls={roomPanelId}
          label="Agent room"
          onClick={() => setRailTab("room")}
        />
      </div>

      <div className="hm-rail-tabpanels">
        {railTab === "digest" ? (
          <section
            className="hm-rail-panel hm-rail-panel--digest"
            id={digestPanelId}
            role="tabpanel"
            aria-label="Hermes digest"
          >
            <RailDigest
              cards={boardCards ?? []}
              onCardClick={onCardClick}
              onGoRoom={() => setRailTab("room")}
              onOpenRoster={() => setRosterOpen(true)}
            />
            <BacklogSuggestionsRailBlock
              response={backlogSuggestions}
              boardCards={boardCards ?? []}
              onCardClick={onCardClick}
              onUseInComposer={fillComposer}
            />
          </section>
        ) : (
          <section
            className="hm-activity hm-rail-panel hm-rail-panel--room"
            id={roomPanelId}
            role="tabpanel"
            aria-label="Multi-agent collaboration room"
          >
            <div className="hm-activity-head">
              <span className="hm-kicker">Room</span>
              <strong>Agent collaboration</strong>
              <RoomPresence peers={peers} />
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
        )}
      </div>

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
      <RailRoster open={rosterOpen} onClose={() => setRosterOpen(false)} />
    </aside>
  );
}

function RailTab({
  active,
  badge,
  controls,
  label,
  onClick,
}: {
  active: boolean;
  badge?: number;
  controls: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`hm-rail-tab${active ? " is-active" : ""}`}
      role="tab"
      aria-selected={active}
      aria-controls={controls}
      onClick={onClick}
    >
      <span>{label}</span>
      {badge && badge > 0 ? <span className="hm-rail-tab-badge">{badge}</span> : null}
    </button>
  );
}

interface RoomThread {
  key: string;
  label: string;
  cardId?: string;
  latestTs: number;
  turns: CollaborationMessage[];
}

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

/**
 * PR-D3d — the "Hermes digest" at the top of the rail. Leads with the figures
 * we can compute from REAL board cards (needs-you, running). The
 * since-you-last-looked marker + session deltas need a backend session signal
 * we don't have, so they read as honest awaiting-data — never a fabricated
 * count.
 */
function RailDigest({
  cards,
  onCardClick,
  onGoRoom,
  onOpenRoster,
}: {
  cards: readonly BoardCard[];
  onCardClick?: (id: string) => void;
  onGoRoom: () => void;
  onOpenRoster: () => void;
}) {
  const { needsYou, running } = railDigestCounts(cards);
  // PR-F1: the rail "WAITING ON YOU" list shares the isDecision predicate with
  // the count (railDigestCounts) and the inbox — no release-history leak.
  const waiting = cards.filter(isDecision);
  return (
    <section className="hm-rail-digest" aria-label="Hermes digest">
      <div className="hm-rail-digest-head">
        <span className="hm-kicker">Digest</span>
        <strong>Hermes digest</strong>
        <span
          className="hm-rail-digest-since"
          title="The since-you-last-looked marker needs a real session backend — not wired yet."
        >
          session deltas · honest until wired
        </span>
      </div>
      <div className="hm-rail-digest-stats">
        <DigestStat label="NEEDS YOU" value={needsYou} tone="act" />
        <DigestStat label="RUNNING NOW" value={running} tone="ok" />
        <DigestStat label="ADVANCED (SESSION)" needsData />
        <DigestStat label="PROD CHANGES" needsData />
      </div>
      <p className="hm-rail-digest-note">
        Advanced and production-change deltas need a real session marker; they stay blank until that source is wired.
      </p>
      <div className="hm-rail-waiting-head">{needsYou} waiting on you</div>
      {waiting.length > 0 ? (
        <div className="hm-rail-waiting-list">
          {waiting.slice(0, 5).map((card) => (
            <DigestWaitingCard
              card={card}
              onCardClick={onCardClick}
              key={card.id}
            />
          ))}
        </div>
      ) : (
        <div className="hm-rail-waiting-empty">
          <strong>Inbox clear</strong>
          <span>Nothing needs your judgment right now.</span>
        </div>
      )}
      <div className="hm-rail-digest-actions">
        <Button variant="secondary" size="sm" onClick={onGoRoom}>Open agent room →</Button>
        <Button variant="ghost" size="sm" onClick={onOpenRoster}>Who&apos;s who</Button>
      </div>
    </section>
  );
}

function DigestStat({
  label,
  value,
  tone,
  needsData,
}: {
  label: string;
  value?: number;
  tone?: "act" | "ok";
  needsData?: boolean;
}) {
  return (
    <div className="hm-rail-digest-stat">
      <span className="hm-rail-digest-value" data-tone={tone ?? "neutral"} data-needs-data={needsData ? "true" : undefined}>
        {needsData ? "—" : value}
      </span>
      <span className="hm-rail-digest-label">{label}</span>
    </div>
  );
}

function DigestWaitingCard({
  card,
  onCardClick,
}: {
  card: BoardCard;
  onCardClick?: (id: string) => void;
}) {
  const rec = recommendationForCard(card);
  const risk = riskLabelForCard(card);
  const grants = grantsLabelForCard(card);
  return (
    <button
      type="button"
      className="hm-rail-waiting-card"
      onClick={() => onCardClick?.(card.id)}
      disabled={!onCardClick}
      aria-label={`Open ${card.id}`}
    >
      <span className="hm-rail-waiting-dot" aria-hidden />
      <span className="hm-rail-waiting-main">
        <strong>{card.title}</strong>
        <small>{card.agentType} · {shortId(card.id)}</small>
        {rec ? <span className="hm-rail-waiting-rec"><b>rec ·</b> {rec}</span> : null}
        <span className="hm-rail-waiting-chips">
          <Badge variant={risk.tone}>{risk.label}</Badge>
          <Badge variant={grants.tone}>{grants.label}</Badge>
        </span>
      </span>
      <span className="hm-rail-waiting-open">Open ›</span>
    </button>
  );
}

function recommendationForCard(card: BoardCard): string | undefined {
  if (card.decisionRecord?.decision) return card.decisionRecord.decision;
  if ("action" in card && card.action?.primary) return card.action.primary;
  return card.next ?? card.summary;
}

function riskLabelForCard(card: BoardCard): { label: string; tone: StateVariant } {
  if ("riskTier" in card && card.riskTier) {
    return { label: `risk · ${card.riskTier}`, tone: card.riskTier === "high" ? "risk" : "neutral" };
  }
  if (card.risk.length > 0) {
    const high = card.risk.some((tag) => tag === "contracts" || tag === "secrets" || tag === "xcm" || tag === "indexer");
    return { label: `risk · ${card.risk.slice(0, 2).join(", ")}`, tone: high ? "risk" : "pending" };
  }
  return { label: "risk · not recorded", tone: "neutral" };
}

function grantsLabelForCard(card: BoardCard): { label: string; tone: StateVariant } {
  const safety = card.decisionRecord?.safety;
  if (!safety) return { label: "grants · not recorded", tone: "neutral" };
  if (!safety.mutates) return { label: "grants · read-only", tone: "pass" };
  return { label: "grants · gated mutation", tone: "pending" };
}

function RailRoster({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  if (!open) return null;

  const roles = [
    {
      agent: "hermes" as const,
      title: "Orchestrator",
      body: "Reads the board, narrates handoffs, reviews evidence, and routes the next safe step.",
      can: ["observe", "recommend", "route"],
      cannot: ["merge", "deploy"],
    },
    {
      agent: "codex" as const,
      title: "Builder",
      body: "Implements code fixes and opens PRs when a task is approved.",
      can: ["branch", "test", "PR"],
      cannot: ["merge"],
    },
    {
      agent: "claude" as const,
      title: "Builder / reviewer",
      body: "Handles UI, docs, review, and collaboration turns when assigned.",
      can: ["branch", "review", "PR"],
      cannot: ["deploy"],
    },
    {
      agent: "operator" as const,
      title: "Final authority",
      body: "Owns risky decisions, approvals, merge/deploy gates, and production judgment.",
      can: ["approve", "merge", "deploy"],
      cannot: ["be bypassed"],
    },
  ];

  return (
    <div className="hm-roster-layer" role="presentation">
      <button type="button" className="hm-roster-scrim" aria-label="Close who's who" onClick={onClose} />
      <section className="hm-roster-dialog" role="dialog" aria-modal="true" aria-label="Who's who">
        <div className="hm-roster-head">
          <div>
            <strong>Who&apos;s who</strong>
            <span>observe · mutate · approve</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
        <div className="hm-roster-list">
          {roles.map((role) => (
            <div className="hm-roster-row" key={role.agent}>
              <AgentTag agent={role.agent} label={role.agent === "operator" ? "You" : role.agent} />
              <div>
                <strong>{role.title}</strong>
                <p>{role.body}</p>
                <span>
                  {role.can.map((capability) => <Badge variant="pass" key={capability}>✓ {capability}</Badge>)}
                  {role.cannot.map((capability) => <Badge variant="neutral" key={capability}>not {capability}</Badge>)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/**
 * PR-D3c — multi-agent presence tiles for the room header. Renders only agents
 * with a real live signal (active in-flight work, or a recent message); an
 * empty room reads honestly as "quiet", never a fabricated always-on roster.
 */
function RoomPresence({ peers }: { peers: readonly PresencePeer[] }) {
  if (peers.length === 0) {
    return <span className="hm-room-presence hm-room-presence--quiet">quiet · no agents active</span>;
  }
  const active = activeCount(peers);
  return (
    <div className="hm-room-presence" role="list" aria-label="Agents present">
      {peers.map((peer) => (
        <span
          className="hm-room-peer"
          role="listitem"
          key={peer.agent}
          title={peer.detail ? `${peer.agent} · ${peer.detail}` : `${peer.agent} · ${peer.presence}`}
        >
          <span className={`hm-room-peer-dot is-${peer.presence}`} aria-hidden />
          <span className="hm-room-peer-name">{peer.agent}</span>
        </span>
      ))}
      {active > 0 ? <span className="hm-room-presence-count">{active} active</span> : null}
    </div>
  );
}

function RoomThreadBlock({
  thread,
  onCardClick,
}: {
  thread: RoomThread;
  onCardClick?: (id: string) => void;
}) {
  return (
    <div className="hm-room-thread">
      <div className="hm-room-thread-head">
        <span className="hm-room-thread-label">
          Thread · {thread.label}
        </span>
        <StatusPill variant="neutral" className="hm-room-thread-count">
          {thread.turns.length} turn{thread.turns.length === 1 ? "" : "s"}
        </StatusPill>
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
    <EmptyState className="hm-turn hm-turn--system hm-turn--kind-status hm-room-empty">
      <div className="hm-turn-head">
        <AgentTag agent="room" label="Room" className="hm-turn-actor" />
        <span className="hm-turn-kind">· empty</span>
      </div>
      <div className="hm-turn-body">
        No agent chatter yet.
        <small>Real Hermes, Codex, Claude, and specialist turns will appear here when recorded.</small>
      </div>
    </EmptyState>
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
    <div className="hm-turn hm-turn--system hm-turn--kind-status hm-board-summary-row">
      <div className="hm-turn-head">
        <AgentTag agent="board" label="Board" className="hm-turn-actor" />
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
        <AgentTag agent={suggestionOwnerAgent(suggestion.suggestedOwner)} label={suggestion.suggestedOwner} />
        <Badge variant={suggestion.riskTier === "high" ? "risk" : "neutral"}>{suggestion.riskTier}</Badge>
        <Badge variant={confidenceVariant(suggestion.confidence)}>{Math.round(suggestion.confidence * 100)}%</Badge>
      </span>
      {relatedCard ? (
        onCardClick ? (
          <Button
            variant="ghost"
            size="xs"
            className="hm-backlog-link"
            onClick={() => onCardClick(relatedCard.id)}
            aria-label={`Open related card ${relatedCard.id}`}
          >
            Open card
          </Button>
        ) : (
          <span className="hm-backlog-link">linked card</span>
        )
      ) : null}
      {suggestion.suggestedPrompt && onUseInComposer ? (
        <Button
          variant="secondary"
          size="xs"
          className="hm-backlog-use"
          onClick={() => onUseInComposer(suggestion.suggestedPrompt!)}
        >
          Use in composer
        </Button>
      ) : null}
      {suggestion.suggestedPrompt ? (
        <Button variant="ghost" size="xs" className="hm-backlog-copy" onClick={copyPrompt}>
          Copy prompt
        </Button>
      ) : null}
    </div>
  );
}

function suggestionOwnerAgent(owner: BacklogSuggestion["suggestedOwner"]): AgentTagAgent {
  if (owner === "codex" || owner === "claude" || owner === "operator" || owner === "hermes") return owner;
  return "system";
}

function confidenceVariant(confidence: number): StateVariant {
  if (confidence >= 0.8) return "pass";
  if (confidence >= 0.5) return "pending";
  return "degraded";
}
