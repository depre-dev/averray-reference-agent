// Hermes Handoff Monitor — board page (M5')
//
// The live data container: wires useMonitorBoard() (SWR fetch of
// /monitor/v2/board + the SSE LiveStream against /monitor/v2/stream) to
// the presentational <BoardView>. A spawned/updated card on the SSE
// feed flows event → applyEventToBoard → SWR cache → re-render; the
// Refresh button revalidates the HTTP snapshot.
//
// Auth is handled at the edge (Cloudflare Access), so there is no
// client-side guard here.
//
// Deferred, by milestone:
//   - the detail drawer (card click)   → M6'
//   - the working Hermes co-pilot rail → M8'
//   - the degraded TopStrip ("?" KPIs) → M11'

import { useMonitorBoard, type UseMonitorBoardOptions } from "./hooks/useMonitorBoard.js";
import { BoardView } from "./components/BoardView.js";

export interface MonitorPageProps {
  /** Override the live wiring (fetcher, EventSource, storage) for tests. */
  options?: UseMonitorBoardOptions;
}

export function MonitorPage({ options }: MonitorPageProps = {}) {
  const { board, status, refresh } = useMonitorBoard(options);
  return <BoardView board={board} status={status} onRefresh={refresh} />;
}
