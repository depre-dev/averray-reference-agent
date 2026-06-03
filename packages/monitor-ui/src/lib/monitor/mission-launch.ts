export type MissionLaunchMode = "surface_sweep" | "gold_path" | "siwe_auth" | "citation_repair";
export type MissionInitialStatus = "ready" | "requested";
export type SavedTestSuiteAuthor = "predefined" | "operator" | "test-writer" | "platform";
export type SavedTestSuiteVerdict = "pass" | "partial" | "fail" | "requested" | "ready" | "running" | "failed" | "unknown";
export type SavedTestSuiteStatus = "requested" | "saved";

export interface MissionLaunchInput {
  targetUrl: string;
  mode: MissionLaunchMode;
  freshMemory: boolean;
  initialStatus: MissionInitialStatus;
  goal?: string;
  /** citation_repair only: the Wikipedia job to repair. Empty ⇒ the workflow
   *  auto-selects a claimable job. (Other modes key off targetUrl.) */
  jobId?: string;
}

export type MissionSpawnInput = string | MissionLaunchInput;

/**
 * Build the POST body for /monitor/testbed-missions from a launch input. Pure
 * so the mode→body mapping is unit-tested. citation_repair keys off jobId, not
 * a URL — it omits targetUrl and carries jobId (empty jobId ⇒ the server-side
 * workflow auto-selects a claimable job). The runner forces dryRun for
 * citation_repair, so the board run is read-only analysis.
 */
export function missionLaunchBody(input: MissionSpawnInput): Record<string, unknown> {
  if (typeof input === "string") return { targetUrl: input };
  if (input.mode === "citation_repair") {
    const body: Record<string, unknown> = {
      mode: input.mode,
      freshMemory: input.freshMemory,
      initialStatus: input.initialStatus,
    };
    if (input.jobId) body.jobId = input.jobId;
    if (input.goal) body.goal = input.goal;
    return body;
  }
  const body: Record<string, unknown> = {
    targetUrl: input.targetUrl,
    mode: input.mode,
    freshMemory: input.freshMemory,
    initialStatus: input.initialStatus,
  };
  if (input.goal) body.goal = input.goal;
  return body;
}

export interface SavedTestSuiteHistoryEntry {
  runId: string;
  verdict: SavedTestSuiteVerdict;
  ts: string;
}

export interface SavedTestSuite {
  schemaVersion: 1;
  kind: "testbed_suite";
  id: string;
  status?: SavedTestSuiteStatus;
  name: string;
  target: string;
  mode: MissionLaunchMode;
  goal?: string;
  role?: string;
  author: SavedTestSuiteAuthor;
  requesterAgent?: string;
  requestReason?: string;
  requestedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  history: SavedTestSuiteHistoryEntry[];
  lastRun?: SavedTestSuiteHistoryEntry;
}

export interface SaveTestSuiteInput {
  name: string;
  target: string;
  mode: MissionLaunchMode;
  goal?: string;
  role?: string;
  author: SavedTestSuiteAuthor;
}
