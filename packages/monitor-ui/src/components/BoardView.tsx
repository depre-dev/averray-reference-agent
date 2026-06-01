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
import { DetailDrawer } from "./drawer/DetailDrawer.js";
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
  const cards = useMemo(() => {
    const nowMs = Date.now();
    return rawCards.filter((card) => {
      if (dismissedCardIds.has(card.id)) return false;
      const snoozedUntil = snoozedUntilById.get(card.id);
      return snoozedUntil === undefined || snoozedUntil <= nowMs;
    });
  }, [dismissedCardIds, rawCards, snoozedUntilById]);
  const liveLabel = useMemo(() => formatClock(board?.at), [board?.at]);

  // KPIs / banner / mode reflect the whole board, regardless of search.
  const state = useMemo(
    () => deriveBoardState(cards, { streamOnline, nowLabel: liveLabel, lastGoodLabel: liveLabel || undefined }),
    [cards, streamOnline, liveLabel],
  );

  // ── view state ──────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<BoardFilter>("all");
  const [boardFocusId, setBoardFocusId] = useState<string | null>(null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [askToken, setAskToken] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
        (c) => (!q || matchesQuery(c, q)) && matchesBoardFilter(c, filter),
      );
    }
    return out;
  }, [state.grouped, q, filter]);

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

  const drawerCard = focusedCardId ? orderedCards.find((c) => c.id === focusedCardId) : undefined;
  const boardFocusedCard = boardFocusId ? orderedCards.find((c) => c.id === boardFocusId) : undefined;
  const scopeCard = drawerCard ?? boardFocusedCard;

  const onToggleLane = useCallback((id: LaneId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onDismissCard = useCallback((id: string) => {
    setDismissedCardIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const onSnoozeCard = useCallback((id: string) => {
    setSnoozedUntilById((prev) => {
      const next = new Map(prev);
      next.set(id, Date.now() + OPERATOR_CARD_SNOOZE_MS);
      return next;
    });
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
      setBoardFocusId(id);
      setAskToken((t) => t + 1);
    },
  });

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
          onRefresh={onRefresh}
        />
      )}

      <BoardNowBanner banner={state.banner} />

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
            renderCard={(card) => (
              <CardRouter
                key={card.id}
                card={card}
                focused={card.id === boardFocusId}
                onClick={onCardClick ? (c) => onCardClick(c.id) : undefined}
                onApprove={onApproveTask ? (c) => onApproveTask(c.id) : undefined}
                onApproveMission={onApproveMission ? (c) => onApproveMission(c.id) : undefined}
                onDismiss={(c) => onDismissCard(c.id)}
                onSnooze={(c) => onSnoozeCard(c.id)}
                onInvestigate={onCardClick ? (c) => onCardClick(c.id) : undefined}
              />
            )}
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
        />
      </div>

      {drawerCard ? (
        <DetailDrawer
          card={drawerCard}
          cards={orderedCards}
          onClose={() => onCardClose?.()}
          onNavigate={(id) => onCardNavigate?.(id)}
        />
      ) : null}

      {overlayOpen ? <KeyboardOverlay onClose={() => setOverlayOpen(false)} /> : null}
    </div>
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
  const latestDay = usage?.byDay?.[0];
  const models = latestDay?.byModel?.slice(0, 4) ?? [];
  const missingSources = (usage?.sourceStatus ?? [])
    .filter((entry) => entry.status === "not_reported")
    .slice(0, Math.max(0, 4 - models.length));
  const hasRows = models.length > 0 || missingSources.length > 0;
  const emptyMessage = usage?.message
    ?? "No runner has reported LLM usage counters yet. Claude/test-writer counters depend on SDK output; Codex CLI and Hermes/Ollama do not reliably report usage today.";
  return (
    <section className="hm-llm-usage" aria-label="LLM usage">
      <div className="hm-llm-usage-head">
        <div>
          <span className="hm-kicker">LLM usage</span>
          <strong>{latestDay?.day ?? "usage not reported"}</strong>
        </div>
        <span className="hm-llm-usage-total">
          {usage?.status === "recorded" ? `${formatNumber(latestDay?.totalTokens ?? 0)} tokens` : "not reported"}
        </span>
      </div>
      <div className="hm-llm-usage-grid">
        {hasRows ? (
          <>
            {models.map((entry) => (
              <div className="hm-llm-usage-row" key={`${entry.agent}:${entry.model}`}>
                <span>
                  <strong>{entry.agent}</strong>
                  <small>{entry.model}</small>
                </span>
                <span>{formatNumber(entry.totalTokens)} tok</span>
                <span>{entry.costStatus === "recorded" && entry.costUsd !== null ? `$${entry.costUsd.toFixed(4)}` : "cost not reported"}</span>
              </div>
            ))}
            {missingSources.map((entry) => (
              <div className="hm-llm-usage-row hm-llm-usage-row--muted" key={`missing:${entry.agent}`}>
                <span>
                  <strong>{entry.agent}</strong>
                  <small>{entry.reason ?? `${entry.agent} usage counters have not arrived.`}</small>
                </span>
                <span>not reported</span>
                <span>no live metric</span>
              </div>
            ))}
          </>
        ) : (
          <div className="hm-llm-usage-empty">{emptyMessage}</div>
        )}
      </div>
    </section>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
