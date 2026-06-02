export type MissionLaunchMode = "surface_sweep" | "gold_path" | "siwe_auth";
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
}

export type MissionSpawnInput = string | MissionLaunchInput;

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
