// Hermes Handoff Monitor — BoardView (presentational board + keyboard).
//
// Renders the Direction A board from a MonitorBoard + stream status, and
// owns the board's view interaction: keyboard navigation (§12), the
// cheat-sheet overlay, lane spotlight, and client-side search filtering.
// Data fetching stays in the page container; this component takes the
// result + callbacks and is deterministic to test against fixtures.
//
//   <div.hm-board>
//     <TopStrip />               KPI pills + LIVE indicator + refresh
//     <BoardNowBanner />         hero sentence (tone follows board mode)
//     <div.hm-main>              grid: lanes-wrap | hermes rail (420px)
//       <div.hm-lanes-wrap>
//         <LanesBar />           search + filter chips + urgency label
//         <Board renderCard />   the eight lanes, cards via <CardRouter>
//       <CoPilotRail />          live narration + Ask-Hermes
//   <DetailDrawer />             when ?card= resolves
//   <KeyboardOverlay />          when ? is pressed

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { deriveBoardState, matchesBoardFilter, type BoardMode, type BoardFilter } from "../lib/monitor/board-state.js";
import type { LlmUsageAggregate, MonitorBoard } from "../lib/monitor/board-cache.js";
import type { BacklogSuggestionsResponse } from "../lib/monitor/backlog-suggestions.js";
import type { StreamStatus } from "../lib/monitor/live-stream.js";
import { LANES, type BoardCard, type CreateTaskInput } from "../lib/monitor/card-types.js";
import { CreateTaskForm } from "./CreateTaskForm.js";
import { laneFor } from "../lib/monitor/lane-rules.js";
import { relatedPrForCard } from "../lib/monitor/collaboration.js";
import { TopStrip } from "./TopStrip.js";
import { TopStripDegraded } from "./TopStripDegraded.js";
import { BoardNowBanner } from "./BoardNowBanner.js";
import { LanesBar } from "./LanesBar.js";
import { Board, CALM_EXPANDED, DEFAULT_EXPANDED } from "./Board.js";
import type { LaneId } from "./Lane.js";
import { CardRouter } from "./cards/CardRouter.js";
import { HermesCheckingBody } from "./HermesCheckingBody.js";
import { DetailDrawer } from "./drawer/DetailDrawer.js";
import { missionReportText, type DrawerActionHandlers } from "../lib/monitor/drawer-footer.js";
import { CoPilotRail } from "./hermes/CoPilotRail.js";
import { KeyboardOverlay } from "./shortcuts/KeyboardOverlay.js";
import type { UseCollaborationOptions } from "../hooks/useCollaboration.js";
import { useBoardKeyboard } from "../hooks/useBoardKeyboard.js";

// laneFor() promotes every isAction card into needs-attention, so the
// action preset expands that lane (not operator-review) to keep the
// action treatment — verdict + CTA — on screen.
const ACTION_EXPANDED: ReadonlySet<LaneId> = new Set<LaneId>([
  "needs-attention",
  "hermes-checking",
  "release-queue",
  "deploying",
  "done",
]);
const OPERATOR_CARD_SNOOZE_MS = 30 * 60_000;

function expandedForMode(mode: BoardMode): ReadonlySet<LaneId> {
  if (mode === "calm") return CALM_EXPANDED;
  if (mode === "degraded") return DEFAULT_EXPANDED;
  return ACTION_EXPANDED;
}

const ALL_LANES = LANES as readonly LaneId[];

/** Lanes that currently hold at least one card. */
function lanesWithCards(grouped: Partial<Record<LaneId, BoardCard[]>>): LaneId[] {
  return ALL_LANES.filter((lane) => (grouped[lane]?.length ?? 0) > 0);
}

// A lane with cards is always shown — only empty lanes collapse to rails. The
// mode preset just decides which EMPTY lanes stay open (e.g. Done as release
// history). This is why a calm board with automation in flight still shows
// those lanes' cards instead of hiding everything but Done.
function expandedForBoard(
  mode: BoardMode,
  grouped: Partial<Record<LaneId, BoardCard[]>>,
  alwaysOpen: readonly LaneId[] = [],
): Set<LaneId> {
  return new Set<LaneId>([...expandedForMode(mode), ...lanesWithCards(grouped), ...alwaysOpen]);
}

function matchesQuery(card: BoardCard, q: string): boolean {
  if (!q) return true;
  const hay = `${card.id} ${card.title} ${card.repo} ${card.branch ?? ""} ${card.summary ?? ""}`.toLowerCase();
  return hay.includes(q);
}

export interface BoardViewProps {
  board: MonitorBoard | undefined;
  backlogSuggestions?: BacklogSuggestionsResponse;
  status: StreamStatus;
  onRefresh?: () => void;
  /** Focused card id (drives the detail drawer); null/undefined = closed. */
  focusedCardId?: string | null;
  /** A card was clicked / Enter pressed — open its drawer (sets ?card=). */
  onCardClick?: (id: string) => void;
  onCardClose?: () => void;
  onCardNavigate?: (id: string) => void;
  onSpawnMission?: (url: string) => void;
  /** Propose a greenfield Claude task (/claude <repo> <task>). */
  onSpawnClaudeTask?: (repo: string, prompt: string) => void;
  /** Propose a task — /task verb + the codex-needed create form (O3). */
  onCreateTask?: (input: CreateTaskInput) => void;
  /** Approve a proposed task card — the operator human gate (O3). */
  onApproveTask?: (id: string) => void;
  /** Approve a requested tester mission — the operator human gate (T6). */
  onApproveMission?: (id: string) => void;
  /** Persist operator dismissal for cards backed by server-side state. */
  onDismissCard?: (card: BoardCard) => void;
  /** Persist operator snooze for cards backed by server-side state. */
  onSnoozeCard?: (card: BoardCard, untilMs: number) => void;
  /** Re-run a mission (drawer footer) via POST /monitor/testbed-missions. */
  onRerunMission?: (targetUrl: string, freshness: "fresh" | "memory") => void;
  /** Accept/acknowledge a failed mission via POST /monitor/testbed-missions/:id/accept-failure. */
  onAcceptMissionFailure?: (id: string) => void;
  /** File a GitHub issue for a failed mission via POST /monitor/testbed-missions/:id/open-issue. */
  onOpenMissionIssue?: (id: string) => void;
  collaboration?: UseCollaborationOptions;
  onMute?: (untilMs: number) => void;
  onUnmute?: () => void;
  muted?: boolean;
  /** Engage autopilot until `untilMs` (undefined → server 4h cap). */
  onSetAutopilot?: (untilMs?: number) => void;
  /** Revert to supervised. */
  onSetSupervised?: () => void;
  /** Current autonomy mode (drives the composer toggle chip). */
  autonomyMode?: "supervised" | "autopilot";
  /** Disable the global keyboard handler (tests rendering many boards). */
  keyboard?: boolean;
}

export function BoardView({
  board,
  backlogSuggestions,
  status,
  onRefresh,
  focusedCardId,
  onCardClick,
  onCardClose,
  onCardNavigate,
  onSpawnMission,
  onSpawnClaudeTask,
  onCreateTask,
  onApproveTask,
  onApproveMission,
  onDismissCard: persistDismissCard,
  onSnoozeCard: persistSnoozeCard,
  onRerunMission,
  onAcceptMissionFailure,
  onOpenMissionIssue,
  collaboration,
  onMute,
  onUnmute,
  muted,
  onSetAutopilot,
  onSetSupervised,
  autonomyMode,
  keyboard = true,
}: BoardViewProps) {
  const degraded = status === "reconnecting" || status === "closed";
  // Keep the dispatch lane (codex-needed) open when its create form is wired,
  // so the operator can propose the first task even when the lane is empty.
  const alwaysOpen: readonly LaneId[] = onCreateTask ? ["codex-needed"] : [];
  const streamOnline = !degraded;
  const rawCards = board?.cards ?? [];
  const [dismissedCardIds, setDismissedCardIds] = useState<ReadonlySet<string>>(() => new Set());
  const [snoozedUntilById, setSnoozedUntilById] = useState<ReadonlyMap<string, number>>(() => new Map());
  // "Keep watching" cancels a card's archive hint for this session — the
  // operator opted to keep it, so we suppress the "archive in 4h?" prompt.
  const [keptCardIds, setKeptCardIds] = useState<ReadonlySet<string>>(() => new Set());
  const cards = useMemo(() => {
    const nowMs = Date.now();
    return rawCards
      .filter((card) => {
        if (dismissedCardIds.has(card.id)) return false;
        const snoozedUntil = snoozedUntilById.get(card.id);
        return snoozedUntil === undefined || snoozedUntil <= nowMs;
      })
      .map((card) => (card.archiveHint && keptCardIds.has(card.id) ? { ...card, archiveHint: false } : card));
  }, [dismissedCardIds, rawCards, snoozedUntilById, keptCardIds]);
  const liveLabel = useMemo(() => formatClock(board?.at), [board?.at]);

  // ── view state ──────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [boardFocusId, setBoardFocusId] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [askToken, setAskToken] = useState(0);
  const [hermesFocusConversationActive, setHermesFocusConversationActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // P0-4: every Ask-Hermes trigger must produce immediate visible feedback.
  // We bump askToken (focuses the composer, which scrolls it into view),
  // explicitly scroll the composer into view, and show a transient
  // aria-live line ("Asking Hermes about {card}").
  const [askStatus, setAskStatus] = useState<string | null>(null);
  const askStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerAsk = useCallback((focusId: string | null, label?: string) => {
    if (focusId) setBoardFocusId(focusId);
    setAskToken((t) => t + 1);
    // Scroll the composer into view so the operator sees where their
    // question lands. Guarded + querySelector so it doesn't depend on the
    // rail's internal structure and is a safe no-op under jsdom/tests.
    if (typeof document !== "undefined") {
      const composer = document.querySelector(".hm-compose-input");
      (composer as HTMLElement | null)?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    }
    setAskStatus(label ? `Asking Hermes about ${label}` : "Asking Hermes…");
    if (askStatusTimer.current) clearTimeout(askStatusTimer.current);
    askStatusTimer.current = setTimeout(() => setAskStatus(null), 4000);
  }, []);
  useEffect(() => () => {
    if (askStatusTimer.current) clearTimeout(askStatusTimer.current);
  }, []);

  // KPIs / banner / mode reflect the whole board, regardless of search.
  const state = useMemo(
    () => deriveBoardState(cards, {
      streamOnline,
      nowLabel: liveLabel,
      lastGoodLabel: liveLabel || undefined,
      ...(hermesFocusConversationActive && scopeCandidateId(cards, focusedCardId, boardFocusId)
        ? { hermesFocusCardId: scopeCandidateId(cards, focusedCardId, boardFocusId) }
        : {}),
      ...(board?.calmMetrics ? { calmMetrics: board.calmMetrics } : {}),
    }),
    [board?.calmMetrics, boardFocusId, cards, focusedCardId, hermesFocusConversationActive, streamOnline, liveLabel],
  );

  // §14: announce the action-needed 0→>0 edge once, assertively, for
  // screen-reader users (the visual cue is the amber banner).
  const [announcement, setAnnouncement] = useState("");
  const prevActionRef = useRef<number | null>(null);
  useEffect(() => {
    const prev = prevActionRef.current;
    prevActionRef.current = state.counts.action;
    if (prev !== null && prev <= 0 && state.counts.action > 0) {
      setAnnouncement(
        state.counts.action === 1
          ? "1 card now needs your review."
          : `${state.counts.action} cards now need your review.`,
      );
    }
  }, [state.counts.action]);

  // Controlled lane expansion: seed so every lane WITH cards is open (plus the
  // mode preset's empty lanes, e.g. Done). Re-seed when the mode flips OR the
  // set of lanes-with-cards changes — so in-flight work that arrives while the
  // board stays "calm" (action == 0) still surfaces instead of hiding behind a
  // rail. Manual toggles / spotlight persist until the next such change.
  const [expanded, setExpanded] = useState<ReadonlySet<LaneId>>(
    () => expandedForBoard(state.mode, state.grouped, alwaysOpen),
  );
  const seedRef = useRef<string>("");
  useEffect(() => {
    const sig = `${state.mode}|${lanesWithCards(state.grouped).join(",")}|${alwaysOpen.join(",")}`;
    if (seedRef.current !== sig) {
      seedRef.current = sig;
      setExpanded(expandedForBoard(state.mode, state.grouped, alwaysOpen));
    }
    // alwaysOpen is derived from the stable onCreateTask prop.
  }, [state.mode, state.grouped, onCreateTask]); // eslint-disable-line react-hooks/exhaustive-deps

  // Search + filter chip narrow what's shown + focusable (not the KPI counts —
  // the chip counts stay live off the whole board).
  const q = query.trim().toLowerCase();
  const displayGrouped = useMemo(() => {
    if (!q && filter === "all") return state.grouped;
    const out = {} as Record<LaneId, BoardCard[]>;
    for (const lane of LANES) {
      out[lane] = (state.grouped[lane] ?? []).filter(
        (c) => (!q || matchesQuery(c, q)) && matchesBoardFilter(c, filter, { todayIso: board?.at }),
      );
    }
    return out;
  }, [board?.at, state.grouped, q, filter]);

  // A non-"all" filter reveals every lane that has a match, regardless of the
  // operator's manual collapse state, so chip results are never hidden. Clearing
  // back to "all" restores the normal expansion.
  const effectiveExpanded = useMemo<ReadonlySet<LaneId>>(() => {
    if (filter === "all") return expanded;
    return new Set(LANES.filter((lane) => (displayGrouped[lane]?.length ?? 0) > 0));
  }, [filter, expanded, displayGrouped]);

  const orderedCards = useMemo<BoardCard[]>(
    () => LANES.flatMap((lane) => displayGrouped[lane] ?? []),
    [displayGrouped],
  );

  // Shared per-card renderer — used directly by most lanes and re-used by the
  // hermes-checking lane body (P1-1) so unrouted cards still render the same way.
  const renderCard = (card: BoardCard) => (
    <CardRouter
      key={card.id}
      card={card}
      focused={card.id === boardFocusId}
      onClick={onCardClick ? (c) => onCardClick(c.id) : undefined}
      onApprove={onApproveTask ? (c) => onApproveTask(c.id) : undefined}
      onApproveMission={onApproveMission ? (c) => onApproveMission(c.id) : undefined}
      onApproveMerge={onApproveMergeCard}
      onRerunMission={onRerunMission ? (c, freshness) => {
        const target = c.type === "mission" ? c.mission?.target : undefined;
        if (target) onRerunMission(target, freshness);
      } : undefined}
      onAcceptMissionFailure={onAcceptMissionFailure ? (c) => onAcceptMissionFailure(c.correlationId ?? c.id) : undefined}
      onOpenMissionIssue={onOpenMissionIssue ? (c) => onOpenMissionIssue(c.correlationId ?? c.id) : undefined}
      onKeepWatching={(c) => onKeepWatchingCard(c.id)}
    />
  );

  const drawerCard = focusedCardId ? orderedCards.find((c) => c.id === focusedCardId) : undefined;
  const boardFocusedCard = boardFocusId ? orderedCards.find((c) => c.id === boardFocusId) : undefined;
  const scopeCard = drawerCard ?? boardFocusedCard;
  const bannerCta = renderBannerCta({
    bannerMode: state.banner.tone,
    primaryActionId: state.banner.primaryActionId,
    cards,
    onOpenCard: onCardClick ? (card) => {
      setFilter("all");
      setBoardFocusId(card.id);
      setExpanded(new Set<LaneId>([laneFor(card), "done"]));
      onCardClick(card.id);
    } : undefined,
    onReviewToday: () => {
      setFilter("today-done");
      setExpanded(new Set<LaneId>(["done"]));
    },
    onMuteOneHour: onMute ? () => onMute(Date.now() + 60 * 60_000) : undefined,
  });

  const onToggleLane = useCallback((id: LaneId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onDismissCard = useCallback((card: BoardCard) => {
    setDismissedCardIds((prev) => {
      const next = new Set(prev);
      next.add(card.id);
      return next;
    });
    persistDismissCard?.(card);
  }, [persistDismissCard]);

  const onSnoozeCard = useCallback((card: BoardCard) => {
    const untilMs = Date.now() + OPERATOR_CARD_SNOOZE_MS;
    setSnoozedUntilById((prev) => {
      const next = new Map(prev);
      next.set(card.id, untilMs);
      return next;
    });
    persistSnoozeCard?.(card, untilMs);
  }, [persistSnoozeCard]);

  const onKeepWatchingCard = useCallback((id: string) => {
    setKeptCardIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const onApproveMergeCard = useCallback((card: BoardCard) => {
    const pr = relatedPrForCard(card);
    if (pr && typeof window !== "undefined") {
      window.open(`https://github.com/${pr.repo}/pull/${pr.number}`, "_blank", "noopener,noreferrer");
    }
  }, []);

  // ── keyboard (§12) ──────────────────────────────────────────────
  useBoardKeyboard({
    enabled: keyboard,
    cards: orderedCards,
    focusedId: boardFocusId,
    drawerOpen: Boolean(drawerCard),
    overlayOpen,
    onFocusChange: setBoardFocusId,
    onToggleOverlay: () => setOverlayOpen((o) => !o),
    onCloseOverlay: () => setOverlayOpen(false),
    onFocusSearch: () => searchInputRef.current?.focus(),
    onOpenFocused: (id) => onCardClick?.(id),
    onSpotlight: (id) => {
      const card = orderedCards.find((c) => c.id === id);
      if (card) setExpanded(new Set<LaneId>([laneFor(card), "done"]));
    },
    onOpenPr: (id) => {
      const pr = relatedPrForCard(orderedCards.find((c) => c.id === id));
      if (pr && typeof window !== "undefined") {
        window.open(`https://github.com/${pr.repo}/pull/${pr.number}`, "_blank", "noopener,noreferrer");
      }
    },
    onAsk: (id) => {
      const card = orderedCards.find((c) => c.id === id);
      triggerAsk(id, card?.title ?? id);
    },
  });

  // G2: compose the drawer footer's backend actions from the EXISTING board
  // handlers. A handler is provided only when its real action is wired (and the
  // footer further disables a button when the card lacks the data it needs) —
  // so a footer button is never live-but-no-op. No new authority: it only
  // proposes / approves / opens GitHub through paths the board already uses.
  const drawerActions = useMemo<DrawerActionHandlers>(() => {
    const a: DrawerActionHandlers = {
      // Ask Hermes: close the modal drawer, scope the rail composer to the
      // card, scroll it into view, and surface immediate "Asking Hermes
      // about {card}" feedback (P0-4 — the action used to be silent).
      onAskHermes: (card) => {
        onCardClose?.();
        triggerAsk(card.id, card.title ?? card.id);
      },
    };
    if (onRerunMission) {
      a.onRerunMission = (card, freshness) => {
        const target = card.type === "mission" ? card.mission?.target : undefined;
        if (target) onRerunMission(target, freshness);
      };
    }
    if (onApproveTask) {
      // Records operator approval; the merge itself happens on GitHub (the
      // footer opens it). The board never merges.
      a.onApproveAndMerge = (card) => onApproveTask(card.id);
    }
    if (onCreateTask) {
      a.onCreateProductFix = (card) => {
        const report = missionReportText(card);
        onCreateTask({
          agent: "claude", // greenfield product fix — the worker opens its own PR
          repo: card.repo,
          prompt: `Product fix proposed from a failed testbed mission.\n\n${card.title}\n\n${report ?? card.summary}`,
        });
      };
      a.onSendBackToCodex = (card) => {
        const pr = "pullRequestNumber" in card ? (card as { pullRequestNumber?: number }).pullRequestNumber : undefined;
        if (typeof pr === "number") {
          onCreateTask({
            agent: "codex",
            repo: card.repo,
            pullRequestNumber: pr,
            prompt: `Operator sent this PR back to Codex for another pass: ${card.title}`,
          });
        }
      };
    }
    return a;
  }, [onRerunMission, onApproveTask, onCreateTask, onCardClose]);

  return (
    <div className="hm-board">
      {/* §14: assertive announcement of the action 0→>0 edge. */}
      <div className="hm-sr-only" role="status" aria-live="assertive">
        {announcement}
      </div>

      {degraded ? (
        <TopStripDegraded
          lastKnownAt={liveLabel || undefined}
          reason={
            liveLabel
              ? `Live SSE ${status} · last good read ${liveLabel} · KPIs unknown until reconnect · auto-reconnecting`
              : `Live SSE ${status} · no good read yet · KPIs unknown until reconnect · auto-reconnecting`
          }
          onReconnect={onRefresh}
        />
      ) : (
        <TopStrip
          counts={state.counts}
          liveAt={status === "open" ? liveLabel || undefined : undefined}
          automationHealth={board?.automationHealth}
          onRefresh={onRefresh}
        />
      )}

      <BoardNowBanner banner={state.banner} cta={bannerCta} />

      <div className="hm-main">
        <div className="hm-lanes-wrap">
          <LanesBar
            counts={state.counts}
            mode={state.mode}
            searchValue={query}
            onSearchChange={setQuery}
            searchInputRef={searchInputRef}
            activeFilter={filter}
            onFilterChange={setFilter}
          />
          <LlmUsagePanel usage={board?.llmUsage} />
          <Board
            grouped={displayGrouped}
            expanded={effectiveExpanded}
            onToggleLane={onToggleLane}
            renderLaneHeader={
              onCreateTask
                ? (id) => (id === "codex-needed" ? <CreateTaskForm onCreate={onCreateTask} /> : null)
                : undefined
            }
            renderCard={renderCard}
            renderLaneBody={(id, laneCards) =>
              id === "hermes-checking"
                ? <HermesCheckingBody cards={laneCards} renderCard={renderCard} />
                : undefined
            }
          />
        </div>

        <CoPilotRail
          onSpawnMission={onSpawnMission}
          onSpawnClaudeTask={onSpawnClaudeTask}
          onCreateTask={onCreateTask}
          backlogSuggestions={backlogSuggestions}
          boardCards={cards}
          boardBanner={state.banner}
          focusedCard={scopeCard}
          onCardClick={onCardClick}
          collaboration={collaboration}
          onMute={onMute}
          onUnmute={onUnmute}
          muted={muted}
          onSetAutopilot={onSetAutopilot}
          onSetSupervised={onSetSupervised}
          autonomyMode={autonomyMode}
          composerFocusToken={askToken}
          onScopedConversationChange={setHermesFocusConversationActive}
        />
      </div>

      {/* P0-4: transient confirmation that an Ask-Hermes action was received.
          aria-live so it's announced; visually a small floating toast. It
          self-clears after a few seconds (the composer carries the durable
          thinking/error state). */}
      <div className="hm-ask-status" role="status" aria-live="polite">
        {askStatus ? <span className="hm-ask-status-toast">{askStatus}</span> : null}
      </div>

      {drawerCard ? (
        <DetailDrawer
          card={drawerCard}
          cards={orderedCards}
          onClose={() => onCardClose?.()}
          onNavigate={(id) => onCardNavigate?.(id)}
          actions={drawerActions}
        />
      ) : null}

      {!drawerCard ? (
        <button
          type="button"
          className="hm-ask-float"
          onClick={() => {
            const nextFocusId = boardFocusId ?? state.banner.primaryActionId ?? state.mostUrgent?.id ?? orderedCards[0]?.id ?? null;
            const card = nextFocusId ? orderedCards.find((c) => c.id === nextFocusId) : undefined;
            triggerAsk(nextFocusId, card?.title ?? card?.id);
          }}
          aria-label="Ask Hermes"
        >
          <span className="mark" aria-hidden>H</span>
          Ask Hermes <span className="hm-kbd">A</span>
        </button>
      ) : null}

      {overlayOpen ? <KeyboardOverlay onClose={() => setOverlayOpen(false)} /> : null}
    </div>
  );
}

function scopeCandidateId(cards: BoardCard[], focusedCardId: string | null | undefined, boardFocusId: string | null): string | undefined {
  const id = focusedCardId ?? boardFocusId ?? undefined;
  if (!id) return undefined;
  return cards.some((card) => card.id === id) ? id : undefined;
}

function renderBannerCta({
  bannerMode,
  primaryActionId,
  cards,
  onOpenCard,
  onReviewToday,
  onMuteOneHour,
}: {
  bannerMode: BoardMode;
  primaryActionId: string | undefined;
  cards: readonly BoardCard[];
  onOpenCard?: (card: BoardCard) => void;
  onReviewToday: () => void;
  onMuteOneHour?: () => void;
}) {
  if (bannerMode === "degraded") return null;
  if (bannerMode === "calm") {
    return (
      <>
        <div className="button-row">
          <button type="button" className="hm-btn hm-btn--primary" onClick={onReviewToday}>
            Review today <span className="hm-kbd">R</span>
          </button>
          {onMuteOneHour ? (
            <button type="button" className="hm-btn hm-btn--ghost" onClick={onMuteOneHour}>
              Mute for 1 hour
            </button>
          ) : null}
        </div>
        <span className="hm-now-quick">Hermes will tone an alert if action goes from 0 to 1</span>
      </>
    );
  }

  const card = primaryActionId ? cards.find((candidate) => candidate.id === primaryActionId) : undefined;
  if (!card || !onOpenCard) return null;
  const openCard = () => onOpenCard(card);
  return (
    <>
      <div className="button-row">
        <button type="button" className="hm-btn hm-btn--action" onClick={openCard}>
          Jump to {card.id} <span className="hm-kbd">↵</span>
        </button>
        <button type="button" className="hm-btn hm-btn--ghost" onClick={openCard}>
          Open review checklist
        </button>
      </div>
      <span className="hm-now-quick">scoped to the current review decision</span>
    </>
  );
}

/** Format an ISO timestamp as a UTC "HH:MM:SS" clock label, or "" if absent. */
function formatClock(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function LlmUsagePanel({ usage }: { usage?: LlmUsageAggregate }) {
  const [showIdle, setShowIdle] = useState(false);
  const recorded = usage?.status === "recorded";
  const latestDay = usage?.byDay?.[0];
  // Active sources get the space — every (agent, model) that actually reported.
  const models = usage?.byModel?.length ? usage.byModel : latestDay?.byModel ?? [];
  // Idle sources collapse into ONE line; their honest reasons stay reachable on expand.
  const idleSources = (usage?.sourceStatus ?? []).filter((entry) => entry.status === "not_reported");
  const activeCalls = usage?.activeCalls ?? [];
  const emptyMessage = usage?.message
    ?? "No LLM usage counters have been recorded yet. Sources stay not reported until a real provider or runner emits whitelisted counters.";

  return (
    <section className="hm-llm-usage" aria-label="LLM usage">
      {/* Headline: total tokens · calls, with the window/last-active context. */}
      <div className="hm-llm-usage-head">
        <span className="hm-kicker">LLM usage</span>
        <strong className="hm-llm-usage-headline">
          {recorded
            ? `${formatCompactNumber(usage!.totalTokens)} tokens · ${formatNumber(usage!.runs)} calls`
            : "usage not reported"}
        </strong>
        {recorded ? (
          <span className="hm-llm-usage-window">
            board window{usage!.lastActiveAt ? ` · last ${formatRelativeTime(usage!.lastActiveAt)}` : ""}
          </span>
        ) : null}
      </div>

      {/* What's running now (in-flight). */}
      <div className="hm-llm-usage-active">
        <span>What's running now</span>
        {activeCalls.length > 0 ? (
          <strong>{activeCalls.map((call) => `${call.agent} · ${call.model}`).join(" · ")}</strong>
        ) : (
          <strong>No in-flight LLM calls</strong>
        )}
      </div>

      {/* Active sources — prominent: per-(agent, model) tokens + in/out bar. */}
      {recorded && models.length > 0 ? (
        <div className="hm-llm-usage-sources">
          {models.map((entry) => {
            const split = Math.max(1, entry.inputTokens + entry.outputTokens);
            const inPct = Math.round((entry.inputTokens / split) * 100);
            return (
              <div className="hm-llm-usage-source" key={`${entry.agent}:${entry.model}`}>
                <div className="hm-llm-usage-source-head">
                  <strong>{entry.agent} · {entry.model}</strong>
                  <span>{formatCompactNumber(entry.totalTokens)} tokens</span>
                </div>
                <div
                  className="hm-llm-usage-bar"
                  role="img"
                  aria-label={`${formatCompactNumber(entry.inputTokens)} in, ${formatCompactNumber(entry.outputTokens)} out`}
                >
                  <span className="hm-llm-usage-bar-in" style={{ width: `${inPct}%` }} />
                  <span className="hm-llm-usage-bar-out" style={{ width: `${100 - inPct}%` }} />
                </div>
                <div className="hm-llm-usage-source-foot">
                  <small>{formatCompactNumber(entry.inputTokens)} in · {formatCompactNumber(entry.outputTokens)} out</small>
                  <small>{formatNumber(entry.runs)} calls · last {formatRelativeTime(entry.lastActiveAt)}</small>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Idle sources — one muted, expandable line; reasons honest but quiet. */}
      {idleSources.length > 0 ? (
        <div className="hm-llm-usage-idle">
          <button
            type="button"
            className="hm-llm-usage-idle-toggle"
            aria-expanded={showIdle}
            onClick={() => setShowIdle((value) => !value)}
          >
            <span aria-hidden>{showIdle ? "▾" : "▸"}</span>
            {idleSources.length} source{idleSources.length === 1 ? "" : "s"} idle: {idleSources.map((entry) => entry.agent).join(" · ")}
          </button>
          {showIdle ? (
            <ul className="hm-llm-usage-idle-list">
              {idleSources.map((entry) => (
                <li key={entry.agent}>
                  <strong>{entry.agent}</strong>
                  <span>{entry.reason ?? `${entry.agent} usage counters have not arrived.`}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Truth-boundary explanation when nothing reported and no idle list to carry it. */}
      {!recorded && models.length === 0 ? (
        <div className="hm-llm-usage-empty">{emptyMessage}</div>
      ) : null}
    </section>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "last active unknown";
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "last active unknown";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
