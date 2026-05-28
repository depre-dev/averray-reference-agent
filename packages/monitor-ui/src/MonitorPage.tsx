// Hermes Handoff Monitor — board page (M8')
//
// The live data container: wires useMonitorBoard() (SWR fetch of
// /monitor/v2/board + the SSE LiveStream against /monitor/v2/stream),
// useCardParam() (the ?card= drawer route), and the co-pilot rail's
// collaboration feed to the presentational <BoardView>. A spawned/updated
// card on the SSE feed flows event → applyEventToBoard → SWR cache →
// re-render; the Refresh button revalidates; clicking a card opens its
// drawer; the rail polls /monitor/collaboration and posts scoped
// questions.
//
// The Hermes composer's `/mission <url>` spawns a real browser mission
// by POSTing to /monitor/testbed-missions; the Playwright runner reports
// back through the same v2 board feed, so the new mission card appears
// and updates live.
//
// Auth is handled at the edge (Cloudflare Access), so there is no
// client-side guard here.
//
// Deferred, by milestone:
//   - the degraded TopStrip ("?" KPIs) → M11'

import { useMemo } from "react";
import { useMonitorBoard, type UseMonitorBoardOptions } from "./hooks/useMonitorBoard.js";
import { useCardParam } from "./hooks/useCardParam.js";
import type { UseCollaborationOptions } from "./hooks/useCollaboration.js";
import { useActionAlerts, type UseActionAlertsOptions } from "./hooks/useActionAlerts.js";
import { kpiCounts } from "./lib/monitor/board-state.js";
import { BoardView } from "./components/BoardView.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

const MISSIONS_URL = "/monitor/testbed-missions";

export interface MonitorPageProps {
  /** Override the live wiring (fetcher, EventSource, storage) for tests. */
  options?: UseMonitorBoardOptions;
  /** Override the /mission spawn (defaults to POST /monitor/testbed-missions). */
  onSpawnMission?: (url: string) => void;
  /** Override the co-pilot collaboration wiring (defaults to live polling). */
  collaboration?: UseCollaborationOptions;
  /** Override the action-alert wiring (audio/notification/storage) for tests. */
  alerts?: UseActionAlertsOptions;
}

export function MonitorPage({
  options,
  onSpawnMission = defaultSpawnMission,
  collaboration = {},
  alerts,
}: MonitorPageProps = {}) {
  const { board, status, refresh } = useMonitorBoard(options);
  const { cardId, setCard, clearCard } = useCardParam();

  // The action-needed count drives all three notification tiers (§17).
  const actionCount = useMemo(() => kpiCounts(board?.cards ?? []).action, [board?.cards]);
  const { muted, mute, unmute } = useActionAlerts(actionCount, alerts);

  return (
    <ErrorBoundary>
      <BoardView
        board={board}
        status={status}
        onRefresh={refresh}
        focusedCardId={cardId}
        onCardClick={setCard}
        onCardClose={clearCard}
        onCardNavigate={setCard}
        onSpawnMission={onSpawnMission}
        collaboration={collaboration}
        onMute={mute}
        onUnmute={unmute}
        muted={muted}
      />
    </ErrorBoundary>
  );
}

/**
 * Spawn a browser mission against `url`. The slack-operator's
 * /monitor/testbed-missions runner accepts `{ targetUrl }`, runs a fresh
 * Playwright agent, and surfaces the result as a mission card on the v2
 * board — so the spawned card appears and updates through the live feed.
 * Fire-and-forget: the board feed, not this call, drives the UI.
 */
function defaultSpawnMission(url: string): void {
  void fetch(MISSIONS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ targetUrl: url }),
  }).catch(() => {
    /* surfaced via the board feed / degraded state, not thrown here */
  });
}
