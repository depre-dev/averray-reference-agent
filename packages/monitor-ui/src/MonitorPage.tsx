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

import { useMonitorBoard, type UseMonitorBoardOptions } from "./hooks/useMonitorBoard.js";
import { useCardParam } from "./hooks/useCardParam.js";
import type { UseCollaborationOptions } from "./hooks/useCollaboration.js";
import { BoardView } from "./components/BoardView.js";

const MISSIONS_URL = "/monitor/testbed-missions";

export interface MonitorPageProps {
  /** Override the live wiring (fetcher, EventSource, storage) for tests. */
  options?: UseMonitorBoardOptions;
  /** Override the /mission spawn (defaults to POST /monitor/testbed-missions). */
  onSpawnMission?: (url: string) => void;
  /** Override the co-pilot collaboration wiring (defaults to live polling). */
  collaboration?: UseCollaborationOptions;
}

export function MonitorPage({
  options,
  onSpawnMission = defaultSpawnMission,
  collaboration = {},
}: MonitorPageProps = {}) {
  const { board, status, refresh } = useMonitorBoard(options);
  const { cardId, setCard, clearCard } = useCardParam();

  return (
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
    />
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
