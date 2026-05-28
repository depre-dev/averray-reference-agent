// Hermes Handoff Monitor — shared card-type definitions.
//
// Mirrors the data shapes the slack-operator /monitor/v2/board endpoint
// returns (see services/slack-operator/src/monitor-v2.ts). This is the
// frontend's copy of the contract; the two cross an HTTP/JSON boundary,
// so they're intentionally independent declarations rather than a shared
// import.
//
// Data model documented in §5 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.
// Lane derivation: lane-rules.ts. Freshness math: urgency.ts.

export type Lane =
  | "needs-attention"
  | "drafts"
  | "codex-needed"
  | "hermes-checking"
  | "operator-review"
  | "release-queue"
  | "deploying"
  | "done";

export type CardType = "pr" | "mission" | "task" | "deploy" | "draft" | "done";

export type AgentType = "claude" | "codex" | "hermes" | "ext";

export type RiskTag =
  | "workflow"
  | "config"
  | "review-gated"
  | "contracts"
  | "secrets"
  | "indexer"
  | "xcm"
  | "docs"
  | "testbed"
  | "ui-only"
  | "deps"
  | "quality";

export type CardState =
  | "fresh"
  | "stale"
  | "failed-fetch"
  | "source-offline"
  | "running";

export interface WaitingOn {
  actor: "operator" | "author" | "agent" | "CI" | "relay" | "branch-protection";
  tone: "warn" | "info" | "neutral";
}

export interface CardChecks {
  pass: number;
  running: number;
  fail: number;
  pending: number;
  total: number;
}

export interface CardFile {
  path: string;
  /** e.g. "+18 -4" */
  diff: string;
  critical: boolean;
}

export interface CardAction {
  kind: "operator-review" | "codex-approve" | "deploy-verify" | "mission-rerun";
  primary: string;
  secondary?: string;
}

/** Shared fields across every card type. */
export interface CardBase {
  id: string;
  lane: Lane;
  type: CardType;
  agentType: AgentType;
  title: string;
  summary: string;
  repo: string;
  branch?: string;
  /** minutes since entering current lane */
  freshness: number;
  state: CardState;
  risk: RiskTag[];
  checks?: CardChecks;
  waitingOn: WaitingOn;
  /** true ⇒ this card drives the needs-attention lane */
  isAction?: boolean;
  /** true ⇒ render in drafts regardless of other state */
  isDraft?: boolean;
  /** stale-card "want to archive?" prompt */
  archiveHint?: boolean;
  /** free-form "next action" copy from the classifier */
  next?: string;
}

/** PR card — file changes, Hermes verdict, operator-review action. */
export interface PRCard extends CardBase {
  type: "pr";
  files: CardFile[];
  verdict?: string;
  action?: CardAction;
}

export interface MissionStep {
  n: number;
  status: "ok" | "warn" | "fail";
  desc: string;
  /** latency string, e.g. "320ms" / "12.4s" */
  lat: string;
}

export interface MissionBlocker {
  head: string;
  body: string;
}

export interface MissionEvidence {
  kind: "screenshot" | "trace" | "console" | "video";
  label: string;
  href: string;
}

export interface MissionReport {
  verdict: "OK" | "PARTIAL" | "FAILED";
  verdictTone: "ok" | "warn" | "fail";
  /** 0..1 */
  confidence: number;
  /** e.g. "2m 14s" */
  latency: string;
  /** URL under test */
  target: string;
  /** e.g. "fresh · no memory" */
  seed: string;
  runs: number;
  /** 0..10 */
  successScore: number;
  /** 0..10 */
  clarityScore: number;
  /** 0..10 */
  latencyScore: number;
  path: MissionStep[];
  blockers: MissionBlocker[];
  evidence: MissionEvidence[];
  mutationBoundary: string;
  recommendations: string[];
}

/** Browser mission card (testbed). */
export interface MissionCard extends CardBase {
  type: "mission";
  mission: MissionReport;
}

/** Codex task card. Lifecycle: proposed → approved → running → succeeded/failed. */
export interface CodexTaskCard extends CardBase {
  type: "task";
  prompt: string;
  action?: CardAction;
  runnerHeartbeat?: { lastSeen: string; online: boolean };
  output?: string;
  failureReason?: string;
}

/** Deploy verification card. */
export interface DeployCard extends CardBase {
  type: "deploy";
  deployId: string;
  verification: { current: number; total: number; label: string };
}

/** Draft card — author hasn't marked ready yet. */
export interface DraftCard extends CardBase {
  type: "draft";
  isDraft: true;
}

/** Closed card — release history. */
export interface DoneCard extends CardBase {
  type: "done";
  closedAt: string;
  mergeStatus: "MERGED" | "CLOSED";
  verdictText?: string;
}

/** Discriminated union of every card type the monitor renders. */
export type BoardCard =
  | PRCard
  | MissionCard
  | CodexTaskCard
  | DeployCard
  | DraftCard
  | DoneCard;

/** The eight valid lane IDs, in display order. */
export const LANES = [
  "needs-attention",
  "drafts",
  "codex-needed",
  "hermes-checking",
  "operator-review",
  "release-queue",
  "deploying",
  "done",
] as const satisfies readonly Lane[];

/** The valid card-state values. */
export const CARD_STATES = [
  "fresh",
  "stale",
  "failed-fetch",
  "source-offline",
  "running",
] as const satisfies readonly CardState[];

/** The valid card-type values. */
export const CARD_TYPES = [
  "pr",
  "mission",
  "task",
  "deploy",
  "draft",
  "done",
] as const satisfies readonly CardType[];
