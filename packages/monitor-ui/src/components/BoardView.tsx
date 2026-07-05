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
//         <UtilitiesPanel />     collapsed strip ⇄ 2-col: usage | launcher+suites
//         <Board />              kanban lanes, cards via <CardRouter>
//       <CoPilotRail />          live narration + Ask-Hermes
//   <DetailDrawer />             when ?card= resolves
//   <KeyboardOverlay />          when ? is pressed

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { deriveBoardState, matchesBoardFilter, type BoardMode, type BoardFilter } from "../lib/monitor/board-state.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";
import type { BacklogSuggestionsResponse } from "../lib/monitor/backlog-suggestions.js";
import type { StreamStatus } from "../lib/monitor/live-stream.js";
import { LANES, type BoardCard, type CreateTaskInput } from "../lib/monitor/card-types.js";
import type { MissionSpawnInput, MissionLaunchOutcome, SaveTestSuiteInput } from "../lib/monitor/mission-launch.js";
import { UtilitiesPanel } from "./UtilitiesPanel.js";
import { laneFor, isDecision, tierFor, type KanbanTier } from "../lib/monitor/lane-rules.js";
import { deployStepsForCard } from "../lib/monitor/deploy-stepper.js";
import { inboxCards } from "../lib/monitor/board-columns.js";
import { relatedPrForCard } from "../lib/monitor/collaboration.js";
import { TopStrip } from "./TopStrip.js";
import { TopStripDegraded } from "./TopStripDegraded.js";
import { BoardNowBanner } from "./BoardNowBanner.js";
import { LanesBar } from "./LanesBar.js";
import { KanbanBoard } from "./KanbanBoard.js";
import type { LaneId } from "./Lane.js";
import { CardRouter } from "./cards/CardRouter.js";
import { PipelineMirrorCard } from "./PipelineMirrorCard.js";
import { HermesCheckingBody } from "./HermesCheckingBody.js";
import { DetailDrawer } from "./drawer/DetailDrawer.js";
import { missionReportText, type DrawerActionHandlers } from "../lib/monitor/drawer-footer.js";
import { CoPilotRail } from "./hermes/CoPilotRail.js";
import { KeyboardOverlay } from "./shortcuts/KeyboardOverlay.js";
import type { UseCollaborationOptions } from "../hooks/useCollaboration.js";
import { useBoardKeyboard } from "../hooks/useBoardKeyboard.js";
import { useProductHealth } from "../hooks/useProductHealth.js";
import { hasFreshRed, type ProductHealth } from "../lib/monitor/product-health.js";
import { BoardSurfaceSwitch, type BoardSurface } from "./ops/BoardSurfaceSwitch.js";
import { OpsBoard } from "./ops/OpsBoard.js";
import { Badge, Button } from "./ui.js";

// laneFor() promotes every isAction card into needs-attention, so the
// action preset expands that lane (not operator-review) to keep the
// action treatment — verdict + CTA — on screen.
const OPERATOR_CARD_SNOOZE_MS = 30 * 60_000;

const ALL_LANES = LANES as readonly LaneId[];

/** Lanes that currently hold at least one card. */
function lanesWithCards(grouped: Partial<Record<LaneId, BoardCard[]>>): LaneId[] {
  return ALL_LANES.filter((lane) => (grouped[lane]?.length ?? 0) > 0);
}

function mustSurfaceCard(card: BoardCard): boolean {
  const lane = laneFor(card);
  return (
    lane === "needs-attention" ||
    lane === "operator-review" ||
    card.isAction === true ||
    card.state === "failed-fetch" ||
    card.state === "source-offline"
  );
}

function mustSurfaceLanes(grouped: Partial<Record<LaneId, BoardCard[]>>): LaneId[] {
  return ALL_LANES.filter((lane) => (grouped[lane] ?? []).some(mustSurfaceCard));
}

// Kanban defaults: every lane with cards opens in the single horizontal board;
// empty lanes stay reachable as mini-rails. Degraded/action cards force their
// lane open even after a manual collapse attempt.
function expandedForBoard(
  _mode: BoardMode,
  grouped: Partial<Record<LaneId, BoardCard[]>>,
  alwaysOpen: readonly LaneId[] = [],
): Set<LaneId> {
  return new Set<LaneId>([
    ...lanesWithCards(grouped),
    ...mustSurfaceLanes(grouped),
    ...alwaysOpen,
  ]);
}

function matchesQuery(card: BoardCard, q: string): boolean {
  if (!q) return true;
  const hay = `${card.id} ${card.title} ${card.repo} ${card.branch ?? ""} ${card.summary ?? ""}`.toLowerCase();
  return hay.includes(q);
}

function scheduleInboxFocus(cardId: string) {
  if (typeof document === "undefined") return;
  const focus = () => {
    const anchors = Array.from(document.querySelectorAll<HTMLElement>("[data-inbox-card-id]"));
    const anchor = anchors.find((node) => node.dataset.inboxCardId === cardId);
    if (!anchor) return;
    anchor.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
    const target = anchor.querySelector<HTMLElement>(".hm-card") ?? anchor;
    target.focus?.({ preventScroll: true });
  };
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => window.requestAnimationFrame(focus));
    return;
  }
  setTimeout(focus, 0);
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
  onSpawnMission?: (input: MissionSpawnInput) => MissionLaunchOutcome;
  onSaveSuite?: (input: SaveTestSuiteInput) => void;
  onRunSuite?: (id: string) => void;
  onApproveSuite?: (id: string) => void;
  onDismissSuite?: (id: string) => void;
  /** Propose a greenfield Claude task (/claude <repo> <task>). */
  onSpawnClaudeTask?: (repo: string, prompt: string) => void;
  /** Propose a task — /task verb + the codex-needed create form (O3). */
  onCreateTask?: (input: CreateTaskInput) => void;
  /** Approve a proposed task card — the operator human gate (O3). */
  onApproveTask?: (id: string) => void;
  /** Approve a requested tester mission — the operator human gate (T6). */
  onApproveMission?: (id: string) => void;
  /** Dismiss a requested tester mission before the runner can claim it. */
  onDismissMission?: (id: string) => void;
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
  /** When false, skip the product-health poll (tests inject a board fetcher). Default true. */
  monitoringEnabled?: boolean;
}

export function BoardView({
  board,
  monitoringEnabled = true,
  backlogSuggestions,
  status,
  onRefresh,
  focusedCardId,
  onCardClick,
  onCardClose,
  onCardNavigate,
  onSpawnMission,
  onSaveSuite,
  onRunSuite,
  onApproveSuite,
  onDismissSuite,
  onSpawnClaudeTask,
  onCreateTask,
  onApproveTask,
  onApproveMission,
  onDismissMission,
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

  // ── The board switches Delivery ⇆ Ops at the top level (board-wide). ──
  const { health: productHealth } = useProductHealth({ enabled: monitoringEnabled });
  const [boardSurface, setBoardSurface] = useState<BoardSurface>(() => {
    try {
      const stored = localStorage.getItem("hm-board-surface");
      if (stored === "ops" || stored === "delivery") return stored;
      // Migrate the previous lane-level "monitoring" flag → the ops surface.
      if (localStorage.getItem("hm-lane-mode") === "monitoring") return "ops";
      return "delivery";
    } catch {
      return "delivery";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("hm-board-surface", boardSurface);
    } catch {
      /* ignore storage errors (private mode) */
    }
  }, [boardSurface]);
  // Auto-flip to Ops on a FRESH red (once per incident): a probe that was already
  // red doesn't re-trigger, so a manual switch back to Delivery sticks.
  const prevHealthRef = useRef<ProductHealth | undefined>(undefined);
  useEffect(() => {
    if (productHealth && hasFreshRed(prevHealthRef.current, productHealth)) {
      setBoardSurface("ops");
    }
    prevHealthRef.current = productHealth;
  }, [productHealth]);
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
  const surfacedExpanded = useMemo<ReadonlySet<LaneId>>(() => (
    new Set<LaneId>([...effectiveExpanded, ...mustSurfaceLanes(displayGrouped), ...alwaysOpen])
  ), [alwaysOpen, displayGrouped, effectiveExpanded]);

  const orderedCards = useMemo<BoardCard[]>(
    () => LANES.flatMap((lane) => displayGrouped[lane] ?? []),
    [displayGrouped],
  );
  const inboxIds = useMemo(
    () => new Set(inboxCards(displayGrouped).map((card) => card.id)),
    [displayGrouped],
  );

  const jumpToInbox = useCallback((card: BoardCard) => {
    setFilter("all");
    setBoardFocusId(card.id);
    scheduleInboxFocus(card.id);
  }, []);

  // Decision Inbox renderer — full CardRouter with action handlers. Pipeline
  // lanes use read-only mirrors below, so actionable buttons live only here.
  const renderCard = (card: BoardCard) => (
    <CardRouter
      key={card.id}
      card={card}
      focused={card.id === boardFocusId}
      onClick={onCardClick ? (c) => onCardClick(c.id) : undefined}
      onApprove={onApproveTask ? (c) => onApproveTask(c.id) : undefined}
      onApproveMission={onApproveMission ? (c) => onApproveMission(c.id) : undefined}
      onDismissMission={onDismissMission ? (c) => onDismissMission(c.correlationId ?? c.id) : undefined}
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
  const renderPipelineMirror = useCallback((
    card: BoardCard,
    tier: KanbanTier,
    inboxAvailable: boolean,
    showStepper = false,
  ) => (
    <PipelineMirrorCard
      key={card.id}
      card={card}
      tier={tier}
      focused={card.id === boardFocusId}
      inboxAvailable={inboxAvailable}
      onJumpToInbox={jumpToInbox}
      showStepper={showStepper}
    />
  ), [boardFocusId, jumpToInbox]);
  const renderPipelineCard = useCallback((
    card: BoardCard,
    context: { tier: KanbanTier; inboxAvailable: boolean },
  ) => renderPipelineMirror(card, context.tier, context.inboxAvailable), [renderPipelineMirror]);
  const renderPipelineCardForLane = useCallback((
    lane: LaneId,
    card: BoardCard,
  ) => renderPipelineMirror(card, tierFor(lane), inboxIds.has(card.id)), [inboxIds, renderPipelineMirror]);
  const renderLaneBody = (id: LaneId, laneCards: BoardCard[]) => {
    const renderMirror = (card: BoardCard) => renderPipelineCardForLane(id, card);
    // PR-F3: the Deploying lane surfaces the active/current deploy ungrouped, with
    // its verification stepper visible; older near-identical verifications still
    // group behind "N similar" so the dedupe no longer shadows the live deploy.
    if (id === "deploying") {
      const active = pickActiveDeploy(laneCards);
      const rest = active ? laneCards.filter((c) => c.id !== active.id) : laneCards;
      const restItems = groupLaneCards(id, rest);
      if (!active && !restItems.some((item) => item.kind === "group")) return undefined;
      return (
        <>
          {active
            ? renderPipelineMirror(active, tierFor(id), inboxIds.has(active.id), true)
            : null}
          <GroupedLaneBody items={restItems} renderCard={renderMirror} />
        </>
      );
    }
    const groupedItems = groupLaneCards(id, laneCards);
    const hasGroupedCards = groupedItems.some((item) => item.kind === "group");
    if (id === "hermes-checking" && !hasGroupedCards) {
      return <HermesCheckingBody cards={laneCards} renderCard={renderMirror} />;
    }
    if (!hasGroupedCards) return undefined;
    return <GroupedLaneBody items={groupedItems} renderCard={renderMirror} />;
  };
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
      // Triage a stuck/failed card off the board, then close the drawer (the
      // card is filtered out, so leaving it open would show a stale shell).
      onDismiss: (card) => {
        onDismissCard(card);
        onCardClose?.();
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
        // Testbed mission cards carry the synthetic repo "testbed/mission",
        // which is not a real GitHub repo and can't be cloned — the runner
        // rejects it, so the proposed task is un-buildable. A tester finding's
        // fix lives in the reference-agent (the adapter/workflow code), so
        // route the product-fix task there instead of the mission's repo.
        const repo = card.repo === "testbed/mission" ? "depre-dev/averray-reference-agent" : card.repo;
        onCreateTask({
          agent: "claude", // greenfield product fix — the worker opens its own PR
          repo,
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
  }, [onRerunMission, onApproveTask, onCreateTask, onCardClose, onDismissCard]);

  return (
    <div className="hm-board">
      {/* §14: assertive announcement of the action 0→>0 edge. */}
      <div className="hm-sr-only" role="status" aria-live="assertive">
        {announcement}
      </div>

      {/* Board-level Delivery ⇆ Ops switch — swaps the WHOLE board, above the
          lanes (not a per-lane toggle). Always present, including when the
          delivery SSE is degraded, since Ops reads product health from its own
          poll rather than the board stream. */}
      <div className="ops-switch-bar">
        <BoardSurfaceSwitch surface={boardSurface} onChange={setBoardSurface} health={productHealth} />
      </div>

      {boardSurface === "ops" ? (
        productHealth ? (
          <OpsBoard health={productHealth} />
        ) : (
          <div className="ops-board ops-board--empty" data-testid="ops-board-loading">
            <div className="ops-empty">
              <span className="ops-empty-title">Loading health…</span>
              <span className="ops-empty-detail">Polling the live product heartbeat.</span>
            </div>
          </div>
        )
      ) : (
        <>
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
          <UtilitiesPanel
            usage={board?.llmUsage}
            suites={board?.testbedSuites}
            onRunSuite={onRunSuite}
            onSaveSuite={onSaveSuite}
            onApproveSuite={onApproveSuite}
            onDismissSuite={onDismissSuite}
            onSpawnMission={onSpawnMission}
          />
          <KanbanBoard
            grouped={displayGrouped}
            ariaLabel="Kanban lane grid"
            expanded={surfacedExpanded}
            onToggleLane={onToggleLane}
            renderCard={renderCard}
            renderPipelineCard={renderPipelineCard}
            renderLaneBody={renderLaneBody}
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

      {/* PR-D1: fixed shell footer — the bottom edge of the no-scroll board.
          Real counts only (total cards, how many wait on the operator, how
          many are running). New --h4 surface. */}
      <BoardFooter cards={cards} />
        </>
      )}

      {/* P0-4: transient confirmation that an Ask-Hermes action was received.
          aria-live so it's announced; visually a small floating toast. It
          self-clears after a few seconds (the composer carries the durable
          thinking/error state). */}
      <div className="hm-ask-status" role="status" aria-live="polite">
        {askStatus ? <span className="hm-ask-status-toast">{askStatus}</span> : null}
      </div>

      {drawerCard && boardSurface === "delivery" ? (
        <DetailDrawer
          card={drawerCard}
          cards={orderedCards}
          onClose={() => onCardClose?.()}
          onNavigate={(id) => onCardNavigate?.(id)}
          actions={drawerActions}
        />
      ) : null}

      {/* The old `.hm-ask-float` FAB was a fallback "Ask Hermes" button for a
          layout with no co-pilot column. This board ALWAYS renders <CoPilotRail>
          (above) with its own always-on Ask-Hermes composer in the same
          bottom-right corner, so the FAB was permanently redundant — and its
          coral pill bled out from under the composer. Removed. The `a` shortcut
          still scopes + focuses the rail composer (useBoardKeyboard → onAsk →
          triggerAsk), and the drawer's "Ask Hermes" action does the same. */}

      {overlayOpen ? <KeyboardOverlay onClose={() => setOverlayOpen(false)} /> : null}
    </div>
  );
}

/**
 * PR-D1 — the fixed shell's bottom edge. Honest, real-data counts only:
 * total cards, how many wait on the operator (the DECIDE workload), and how
 * many are running. No fabricated "last sync" clock (we have no real board-sync
 * signal to show). Styled with the --h4 token system.
 */
function BoardFooter({ cards }: { cards: readonly BoardCard[] }) {
  const total = cards.length;
  // PR-F1: the footer "waiting on you" uses the shared isDecision predicate so
  // it agrees with the inbox, rail count, and banner (no release-history leak).
  const waiting = cards.filter((c) => isDecision(c)).length;
  const running = cards.filter((c) => c.state === "running").length;
  return (
    <footer className="h4-board-footer" aria-label="Board footer">
      <span className="h4-board-footer-end">
        <span className="dot" aria-hidden />
        End of board
      </span>
      <span className="h4-board-footer-stat">
        {total} {total === 1 ? "card" : "cards"} · {waiting} waiting on you · {running} running
      </span>
      <span className="h4-board-footer-meta">Hermes · Averray</span>
    </footer>
  );
}

type GroupedLaneItem =
  | { kind: "card"; card: BoardCard }
  | { kind: "group"; id: string; title: string; cards: BoardCard[] };

/**
 * PR-F3: the active/current deploy in the Deploying lane — the one being
 * verified now (a step in progress), else the most recent deploy. It renders
 * ungrouped with its stepper so the dedupe grouping can't shadow it.
 */
function pickActiveDeploy(cards: BoardCard[]): BoardCard | undefined {
  const deploys = cards.filter((c) => c.type === "deploy");
  if (deploys.length === 0) return undefined;
  const verifying = deploys.find((c) => deployStepsForCard(c).some((s) => s.state === "in-progress"));
  return verifying ?? deploys[0];
}

function groupLaneCards(lane: LaneId, cards: BoardCard[]): GroupedLaneItem[] {
  const buckets = new Map<string, BoardCard[]>();
  const orderedKeys: string[] = [];
  for (const card of cards) {
    const key = groupKeyForCard(lane, card);
    if (!key) continue;
    if (!buckets.has(key)) orderedKeys.push(key);
    buckets.set(key, [...(buckets.get(key) ?? []), card]);
  }

  const used = new Set<string>();
  const groups = new Map<string, GroupedLaneItem>();
  for (const key of orderedKeys) {
    const bucket = buckets.get(key) ?? [];
    if (bucket.length < 2) continue;
    for (const card of bucket) used.add(card.id);
    groups.set(key, {
      kind: "group",
      id: key,
      title: bucket[0]?.title ?? "Similar cards",
      cards: bucket,
    });
  }

  const out: GroupedLaneItem[] = [];
  const emittedGroups = new Set<string>();
  for (const card of cards) {
    if (!used.has(card.id)) {
      out.push({ kind: "card", card });
      continue;
    }
    const key = groupKeyForCard(lane, card);
    if (key && !emittedGroups.has(key)) {
      const group = groups.get(key);
      if (group) out.push(group);
      emittedGroups.add(key);
    }
  }
  return out;
}

function groupKeyForCard(lane: LaneId, card: BoardCard): string | null {
  if (mustSurfaceCard(card)) return null;
  if (card.type !== "deploy") return null;
  const normalized = card.title
    .toLowerCase()
    .replace(/#[0-9]+/g, "#")
    .replace(/[a-f0-9]{6,}/g, "<hash>")
    .replace(/\s+/g, " ")
    .trim();
  if (!/post[-\s](merge|production|deploy)|deploy verification|post-production-deploy/.test(normalized)) return null;
  return `${lane}:${card.type}:${normalized}`;
}

function GroupedLaneBody({
  items,
  renderCard,
}: {
  items: GroupedLaneItem[];
  renderCard: (card: BoardCard) => ReactNode;
}) {
  return (
    <>
      {items.map((item) => (
        item.kind === "group"
          ? <GroupedCard key={item.id} group={item} renderCard={renderCard} />
          : renderCard(item.card)
      ))}
    </>
  );
}

function GroupedCard({
  group,
  renderCard,
}: {
  group: Extract<GroupedLaneItem, { kind: "group" }>;
  renderCard: (card: BoardCard) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="hm-card hm-card-group" role="group" aria-label={`${group.title} group`}>
      <div className="hm-card-group-head">
        <div>
          <Badge variant="neutral">{group.cards.length} similar</Badge>
          <strong>{group.title}</strong>
          <span>{group.cards.length} near-identical verification cards grouped. Expand to inspect each one.</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Collapse" : "Expand"}
        </Button>
      </div>
      {expanded ? (
        <div className="hm-card-group-list">
          {group.cards.map((card) => renderCard(card))}
        </div>
      ) : null}
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
          Review most urgent <span className="hm-kbd">↵</span>
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
