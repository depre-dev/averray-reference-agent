export type MissionLaunchMode = "surface_sweep" | "gold_path" | "siwe_auth";
export type MissionInitialStatus = "ready" | "requested";
export type SavedTestSuiteAuthor = "predefined" | "operator" | "test-writer" | "platform";
export type SavedTestSuiteVerdict = "pass" | "partial" | "fail" | "requested" | "ready" | "running" | "failed" | "unknown";

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
  name: string;
  target: string;
  mode: MissionLaunchMode;
  goal?: string;
  author: SavedTestSuiteAuthor;
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
  author: SavedTestSuiteAuthor;
}
