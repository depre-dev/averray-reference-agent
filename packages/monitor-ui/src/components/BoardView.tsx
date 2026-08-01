// The ops board shell (docs/OPS_ONLY_PIVOT.md) — data in, one screen out.
//
// This used to compose a top strip, a hero banner, the ops zone grid and a tall
// LLM-usage rail as four independent bands, each unaware of the others. The
// redesign folds all four into <OpsBoard>, because the hierarchy only works if
// one component decides it: the verdict has to know the stream is down in order
// to relabel itself, and the LLM spend has to be demoted relative to the money
// it was competing with.
//
// So this file is now just the seam: resolve health (polled, or injected by a
// test), decide whether the transport is trustworthy, and hand both to the
// board. Phone width routes to the separate mobile surface, which is designed
// independently and is deliberately untouched here.

import type { MonitorBoard } from "../lib/monitor/board-cache.js";
import type { ProductHealth } from "../lib/monitor/product-health.js";
import type { StreamStatus } from "../lib/monitor/live-stream.js";
import { useProductHealth } from "../hooks/useProductHealth.js";
import { useIsMobileViewport } from "../lib/monitor/use-mobile-viewport.js";
import { MobileBoard } from "./mobile/MobileBoard.js";
import { OpsBoard } from "./ops/OpsBoard.js";

export interface BoardViewProps {
  /** The monitor snapshot. Only its clock and LLM usage are read now. */
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
  // rule applied to the transport itself. <OpsBoard> takes this as an input
  // rather than inferring it, so the override happens where the verdict is
  // decided instead of in a banner bolted above it.
  const degraded = status === "reconnecting" || status === "closed";

  // The phone gets the transport state too — its whole stale treatment (band,
  // re-captioned verdict, "still true?" honesty) depends on knowing whether the
  // stream is alive, and it used to be handed health alone.
  if (isMobileViewport) {
    return (
      <MobileBoard health={productHealth} streamStatus={status} streamDegraded={degraded} />
    );
  }

  // No health payload yet. A dead stream STILL has to say so here — "loading"
  // over a disconnected transport is the calmest possible lie, and the earlier
  // cut of this branch shipped exactly that.
  if (!productHealth) {
    return (
      <div className="hm-shell">
        <div className="ops-board ops-board--empty" data-testid="ops-board-loading">
          {degraded ? (
            <div className="ops-stale" role="alert" data-testid="ops-stale-banner">
              <strong>STREAM DISCONNECTED</strong>
              <span>no health data received — nothing on this screen is confirmed</span>
              <span className="ops-stale-right">reconnecting · {status}</span>
            </div>
          ) : null}
          <div className="ops-empty">
            <span className="ops-empty-title">
              {degraded ? "Health unknown" : "Loading health…"}
            </span>
            <span className="ops-empty-detail">
              {degraded
                ? "The live stream is down. Values will return when it reconnects."
                : "Polling the live product heartbeat."}
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="hm-shell">
      <OpsBoard
        health={productHealth}
        board={board}
        streamStatus={status}
        streamDegraded={degraded}
        onRefresh={onRefresh}
      />
    </div>
  );
}
