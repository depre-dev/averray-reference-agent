// Hermes Handoff Monitor — BoardView (presentational board)
//
// Pure render of the Direction A board from a MonitorBoard + stream
// status. No data fetching — the live wiring lives in useMonitorBoard()
// and the page container passes the result down. Keeping this component
// data-free makes it deterministic to test and storybook against
// fixtures.
//
//   <div.hm-board>
//     <TopStrip />               KPI pills + LIVE indicator + refresh
//     <BoardNowBanner />         hero sentence (tone follows board mode)
//     <div.hm-main>              grid: lanes-wrap | hermes rail (420px)
//       <div.hm-lanes-wrap>
//         <LanesBar />           search + filter chips + urgency label
//         <Board renderCard />   the eight lanes, cards via <CardRouter>
//       <aside.hm-hermes>        co-pilot rail chrome (full rail = M8')

import { useMemo } from "react";
import { deriveBoardState, type BoardMode } from "../lib/monitor/board-state.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";
import type { StreamStatus } from "../lib/monitor/live-stream.js";
import { TopStrip } from "./TopStrip.js";
import { BoardNowBanner } from "./BoardNowBanner.js";
import { LanesBar } from "./LanesBar.js";
import { Board, CALM_EXPANDED, DEFAULT_EXPANDED } from "./Board.js";
import type { LaneId } from "./Lane.js";
import { CardRouter } from "./cards/CardRouter.js";

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

function expandedForMode(mode: BoardMode): ReadonlySet<LaneId> {
  if (mode === "calm") return CALM_EXPANDED;
  if (mode === "degraded") return DEFAULT_EXPANDED;
  return ACTION_EXPANDED;
}

export interface BoardViewProps {
  board: MonitorBoard | undefined;
  status: StreamStatus;
  /** Refresh handler (the top-strip Refresh button). */
  onRefresh?: () => void;
}

export function BoardView({ board, status, onRefresh }: BoardViewProps) {
  // The stream is "degraded" only on a real drop (reconnecting/closed);
  // idle/connecting are pre-live transients, not disconnections. The
  // LIVE indicator, by contrast, only lights on a confirmed open stream.
  const degraded = status === "reconnecting" || status === "closed";
  const streamOnline = !degraded;
  const cards = board?.cards ?? [];
  const liveLabel = useMemo(() => formatClock(board?.at), [board?.at]);

  const state = useMemo(
    () =>
      deriveBoardState(cards, {
        streamOnline,
        nowLabel: liveLabel,
        lastGoodLabel: liveLabel || undefined,
      }),
    [cards, streamOnline, liveLabel],
  );

  return (
    <div className="hm-board">
      <TopStrip
        counts={state.counts}
        liveAt={status === "open" ? liveLabel || undefined : undefined}
        onRefresh={onRefresh}
      />

      <BoardNowBanner banner={state.banner} />

      <div className="hm-main">
        <div className="hm-lanes-wrap">
          <LanesBar counts={state.counts} mode={state.mode} />
          {/* Key by mode: <Board> seeds its expansion state from
              initialExpanded only on mount, so when the board transitions
              (e.g. empty→action as live data arrives) we remount to apply
              the new preset. Manual collapse/expand toggles persist within
              a mode; a mode change is a significant enough event to reset. */}
          <Board
            key={state.mode}
            grouped={state.grouped}
            initialExpanded={expandedForMode(state.mode)}
            renderCard={(card) => <CardRouter key={card.id} card={card} />}
          />
        </div>

        <HermesRailPlaceholder />
      </div>
    </div>
  );
}

/**
 * Minimal Hermes co-pilot rail chrome so the `.hm-main` two-column grid
 * (1fr | 420px) renders end-to-end. The narrating stream + composer are
 * wired in M8'; this stub only holds the column and the rail header.
 */
function HermesRailPlaceholder() {
  return (
    <aside className="hm-hermes" role="complementary" aria-label="Hermes co-pilot">
      {/* A <div>, not <header>: only the TopStrip is the page banner
          landmark — the rail's own header must not register as a second. */}
      <div className="hm-hermes-head">
        <div className="hm-hermes-mark" aria-hidden>
          H
        </div>
        <div>
          <div className="hm-hermes-title">Hermes co-pilot</div>
          <div className="hm-hermes-sub">
            <span className="pulse" aria-hidden />
            Live · narrating the board · context: everywhere
          </div>
        </div>
      </div>

      <div className="hm-hermes-stream">
        <div className="hm-lane-empty">Hermes narration lands in M8'.</div>
      </div>
    </aside>
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
