// The ops board — the whole product surface (docs/OPS_ONLY_PIVOT.md).
//
// This replaced a 1,016-line shell that wired a kanban grid, a decision inbox,
// card renderers, a detail drawer, card keyboard-traversal and a conversational
// co-pilot rail. All of it is retired:
//
//   · the DELIVERY LANE, because a kanban board models work moving through
//     stages while ops is state you watch and act on — forcing one into the
//     other produced a decision inbox nobody could decide from;
//   · the CO-PILOT RAIL, because all conversation now happens in Buzz. The
//     board does not talk. It shows what is true and gets out of the way.
//
// The payoff is the layout: with no lanes column and no rail competing for the
// canvas, the ops board gets the whole of it.
//
// Hermes is not absent — it is simply not HERE. It reads the same health
// snapshot this renders (`/monitor/product-health`) and speaks in Buzz.

import { useMemo } from "react";

import type { MonitorBoard } from "../lib/monitor/board-cache.js";
import type { ProductHealth } from "../lib/monitor/product-health.js";
import type { StreamStatus } from "../lib/monitor/live-stream.js";
import { useProductHealth } from "../hooks/useProductHealth.js";
import { useIsMobileViewport } from "../lib/monitor/use-mobile-viewport.js";
import { BoardNowBanner } from "./BoardNowBanner.js";
import { MobileBoard } from "./mobile/MobileBoard.js";
import { OpsBoard } from "./ops/OpsBoard.js";
import { opsBannerData, pillarStatuses } from "./ops/ops-frame.js";
import { TopStrip } from "./TopStrip.js";
import { TopStripDegraded } from "./TopStripDegraded.js";
import { UsagePanel } from "./UsagePanel.js";

export interface BoardViewProps {
  /** The monitor snapshot. Only its clock and usage are read now. */
  board: MonitorBoard | undefined;
  status: StreamStatus;
  onRefresh?: () => void;
  /** Test seam: inject health instead of polling. */
  health?: ProductHealth;
}

export function BoardView({ board, status, onRefresh, health }: BoardViewProps) {
  const polled = useProductHealth({ enabled: health === undefined });
  const productHealth = health ?? polled.health;
  const isMobileViewport = useIsMobileViewport();

  // A stream we cannot trust must not render as a calm board — the fake-green
  // rule applied to the transport itself.
  const degraded = status === "reconnecting" || status === "closed";

  const liveLabel = useMemo(() => {
    if (!board?.at) return "";
    const d = new Date(board.at);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(11, 19);
  }, [board?.at]);

  if (isMobileViewport) return <MobileBoard health={productHealth} />;

  return (
    <div className="hm-shell">
      {degraded ? (
        <TopStripDegraded
          lastKnownAt={liveLabel || undefined}
          reason={
            liveLabel
              ? `Live SSE ${status} · last good read ${liveLabel} · health unknown until reconnect · auto-reconnecting`
              : `Live SSE ${status} · no good read yet · health unknown until reconnect · auto-reconnecting`
          }
          onReconnect={onRefresh}
        />
      ) : (
        <TopStrip
          liveAt={status === "open" ? liveLabel || undefined : undefined}
          onRefresh={onRefresh}
          opsPillars={productHealth ? pillarStatuses(productHealth.probes) : undefined}
        />
      )}

      {/* The hero banner is the ops verdict — EXCEPT when the stream itself is
          untrusted. A verdict computed from data we cannot trust is not a
          verdict, so a degraded stream OVERRIDES it rather than rendering calm
          over stale numbers. (Regression caught by BoardView.ops.test.tsx.) */}
      <BoardNowBanner
        banner={
          degraded
            ? {
                tone: "degraded",
                eyebrow: "STREAM",
                headline: "Live stream disconnected — board data is UNTRUSTED",
                sub: "Anything below is the last snapshot received, not the product now.",
                primaryActionId: undefined,
              }
            : productHealth
              ? opsBannerData(productHealth, Date.now())
              : {
                  tone: "calm",
                  eyebrow: "OPS NOW",
                  headline: "Loading health…",
                  sub: "Polling the live product heartbeat.",
                  primaryActionId: undefined,
                }
        }
      />

      <div className="hm-main hm-main--ops">
        {productHealth ? (
          <OpsBoard health={productHealth} />
        ) : (
          <div className="ops-board ops-board--empty" data-testid="ops-board-loading">
            <div className="ops-empty">
              <span className="ops-empty-title">Loading health…</span>
              <span className="ops-empty-detail">Polling the live product heartbeat.</span>
            </div>
          </div>
        )}
        <UsagePanel usage={board?.llmUsage} />
      </div>

    </div>
  );
}
