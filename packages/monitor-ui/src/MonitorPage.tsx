// Hermes Handoff Monitor — board page (M3')
//
// Composes the Direction A layout against fixtures and renders the
// calm / "you're done for now" state (artboard A5): every live lane
// collapses to a mini-rail, only Done stays expanded, and the BoardNow
// banner reads the calm prose.
//
//   <div.hm-board>
//     <TopStrip />               KPI pills + LIVE indicator + refresh
//     <BoardNowBanner />         sage calm hero sentence
//     <div.hm-main>              grid: lanes-wrap | hermes rail (420px)
//       <div.hm-lanes-wrap>
//         <LanesBar />           search + filter chips + urgency label
//         <Board />              the eight lanes (mini-rails + Done)
//       <aside.hm-hermes>        co-pilot rail chrome (full rail = M8')
//
// What's deferred, by milestone:
//   - card bodies inside lanes → M4' (the <Card> vocabulary)
//   - live SSE data + real refresh → M5'
//   - the working Hermes co-pilot rail → M8'
//
// Auth is handled at the edge (Cloudflare Access), so there is no
// client-side guard here.

import { useMemo } from "react";
import { deriveBoardState } from "./lib/monitor/board-state.js";
import { FIXTURE_CARDS } from "./lib/monitor/fixtures.js";
import type { BoardCard } from "./lib/monitor/card-types.js";
import { TopStrip } from "./components/TopStrip.js";
import { BoardNowBanner } from "./components/BoardNowBanner.js";
import { LanesBar } from "./components/LanesBar.js";
import { Board, CALM_EXPANDED } from "./components/Board.js";

export function MonitorPage() {
  // Calm / A5 state: only the day's release history exists — every live
  // lane is empty. Reading against fixtures (rather than an empty list)
  // proves the data pipeline end-to-end: counts, banner prose, and lane
  // grouping all derive from real card shapes.
  const cards: BoardCard[] = useMemo(() => FIXTURE_CARDS.filter((c) => c.lane === "done"), []);
  const nowLabel = useMemo(() => buildNowLabel(), []);

  const state = useMemo(
    () => deriveBoardState(cards, { nowLabel, streamOnline: true }),
    [cards, nowLabel],
  );

  return (
    <div className="hm-board">
      <TopStrip counts={state.counts} liveAt={nowLabel.replace(/ utc$/i, "")} />

      <BoardNowBanner banner={state.banner} />

      <div className="hm-main">
        <div className="hm-lanes-wrap">
          <LanesBar counts={state.counts} mode={state.mode} />
          <Board grouped={state.grouped} initialExpanded={CALM_EXPANDED} />
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

/** Render the current UTC time as "HH:MM:SS utc". */
function buildNowLabel(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} utc`;
}
