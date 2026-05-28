// Hermes Handoff Monitor — board page (M4')
//
// Composes the Direction A layout against fixtures and renders the
// rich-mix board (artboard A1): every card type and state is on screen,
// dispatched through <CardRouter> so degraded cards never masquerade as
// fresh ones.
//
//   <div.hm-board>
//     <TopStrip />               KPI pills + LIVE indicator + refresh
//     <BoardNowBanner />         hero sentence (tone follows board mode)
//     <div.hm-main>              grid: lanes-wrap | hermes rail (420px)
//       <div.hm-lanes-wrap>
//         <LanesBar />           search + filter chips + urgency label
//         <Board renderCard />   the eight lanes, cards via <CardRouter>
//       <aside.hm-hermes>        co-pilot rail chrome (full rail = M8')
//
// What's deferred, by milestone:
//   - live SSE data + real refresh → M5'
//   - the detail drawer (card click) → M6'
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
import { Board } from "./components/Board.js";
import type { LaneId } from "./components/Lane.js";
import { CardRouter } from "./components/cards/CardRouter.js";

// Expansion preset for the rich-mix demo. Note `laneFor()` promotes
// every `isAction` card into needs-attention, so that lane (not
// operator-review) holds the action cards — expand it so the action
// treatment (verdict + CTA) is on screen. M5' will derive the preset
// from live board mode.
const RICH_MIX_EXPANDED: ReadonlySet<LaneId> = new Set<LaneId>([
  "needs-attention",
  "hermes-checking",
  "release-queue",
  "deploying",
  "done",
]);

export function MonitorPage() {
  // Rich-mix / A1 state: the full fixture board (PR, mission, task,
  // deploy, draft, done) so every card type and state is exercised.
  // M5' swaps fixtures for the live SSE feed and drives the expansion
  // preset off board mode.
  const cards: BoardCard[] = useMemo(() => FIXTURE_CARDS, []);
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
          <Board
            grouped={state.grouped}
            initialExpanded={RICH_MIX_EXPANDED}
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

/** Render the current UTC time as "HH:MM:SS utc". */
function buildNowLabel(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} utc`;
}
