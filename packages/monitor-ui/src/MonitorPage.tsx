// The ops monitor container (docs/OPS_ONLY_PIVOT.md).
//
// Fetches the monitor snapshot, keeps it patched from the SSE feed, and hands
// it to the presentational <BoardView>. That is the whole job now.
//
// Gone with the delivery lane and the conversational surface: card params and
// the detail drawer, the collaboration feed, backlog suggestions, mission and
// suite spawning, board alerts (chime + favicon badge), and the autonomy
// toggle. All conversation happens in Buzz; the board shows what is true and
// gets out of the way.
//
// Auth is handled at the edge (Cloudflare Access), so there is no client-side
// guard here.

import { useMonitorBoard, type UseMonitorBoardOptions } from "./hooks/useMonitorBoard.js";
import { useColorProfile, type UseColorProfileOptions } from "./hooks/useColorProfile.js";
import { BoardView } from "./components/BoardView.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

export interface MonitorPageProps {
  options?: UseMonitorBoardOptions;
  colorProfile?: UseColorProfileOptions;
}

export function MonitorPage({ options, colorProfile }: MonitorPageProps = {}) {
  const { board, status, refresh } = useMonitorBoard(options ?? {});
  useColorProfile(colorProfile ?? {});

  return (
    <ErrorBoundary>
      <BoardView board={board} status={status} onRefresh={refresh} />
    </ErrorBoundary>
  );
}
