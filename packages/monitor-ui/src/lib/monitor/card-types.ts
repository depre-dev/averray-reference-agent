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

/** One CI check run, for the per-check breakdown under the checks bar. */
export interface CardCheckRun {
  name: string;
  status: "pass" | "fail" | "running" | "neutral";
}

/** A Hermes review finding — the "why this needs review" detail. */
export interface CardRiskSignal {
  severity: "low" | "medium" | "high";
  code: string;
  message: string;
}

export interface CardReviewRequest {
  id: string;
  requestedBy: "hermes" | "operator" | "codex" | "claude";
  reviewer: "codex" | "claude" | "hermes" | "operator";
  reason: string;
  status: "requested" | "responded" | "cancelled";
  reviewMode?: "single" | "panel";
  panelId?: string;
  panelSize?: number;
  response?: {
    verdict: "pass" | "concern" | "block";
    reasoning: string;
    respondedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface HermesDecisionSubject {
  type: "task" | "card" | "repo" | "pr" | "mission" | "digest" | "autopilot_session";
  id: string;
  repo?: string;
  pullRequestNumber?: number;
}

export interface HermesDecisionRecord {
  schemaVersion: 1;
  recordType: "hermes_decision_record";
  id: string;
  kind: "routing" | "auto_approval" | "escalation" | "anomaly_pause" | "away_digest";
  subject: HermesDecisionSubject;
  decision: string;
  reasons: string[];
  inputs: Record<string, unknown>;
  outcome: {
    summary: string;
    waitingNext?: string;
    changed?: string[];
  };
  safety: {
    readOnly: boolean;
    mutates: boolean;
    mutatesGithub?: boolean;
    mutatesAverray?: boolean;
    editsWikipedia?: boolean;
  };
  generatedAt: string;
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
  /** Per-check CI breakdown — the list under the checks bar. */
  checkRuns?: CardCheckRun[];
  /** Hermes review findings — the "why this needs review" detail. */
  riskSignals?: CardRiskSignal[];
  waitingOn: WaitingOn;
  /** true ⇒ this card drives the needs-attention lane */
  isAction?: boolean;
  /** true ⇒ render in drafts regardless of other state */
  isDraft?: boolean;
  /** stale-card "want to archive?" prompt */
  archiveHint?: boolean;
  /** free-form "next action" copy from the classifier */
  next?: string;
  /** Stable correlation id for non-PR cards (mission/task/deploy), when present. */
  correlationId?: string;
  /** D2: latest durable explanation associated with the card. */
  decisionRecord?: HermesDecisionRecord;
  /** C1: active cross-agent review requests scoped to this card. */
  reviewRequests?: CardReviewRequest[];
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
  /** e.g. "2m 14s". Optional — a live agent report may not carry it. */
  latency?: string;
  /** URL under test */
  target: string;
  /** e.g. "fresh · no memory" */
  seed: string;
  /** Attempt count. Optional — not carried by a live agent report. */
  runs?: number;
  /** 0..10. Optional — only the scores the agent actually reported. */
  successScore?: number;
  /** 0..10 */
  clarityScore?: number;
  /** 0..10 */
  latencyScore?: number;
  path: MissionStep[];
  blockers: MissionBlocker[];
  evidence: MissionEvidence[];
  mutationBoundary: string;
  recommendations: string[];
}

/** Browser mission card (testbed). */
export interface MissionCard extends CardBase {
  type: "mission";
  mission?: MissionReport;
  /** requested missions are board-gated and cannot be claimed until approved. */
  missionStatus?: "requested" | "ready" | "running" | "completed" | "failed";
}

/** Task lifecycle status (mirrors the serializer's TaskStatus). */
export type TaskStatus =
  | "proposed"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Codex/Claude task card. Lifecycle: proposed → approved → running → succeeded/failed. */
export interface CodexTaskCard extends CardBase {
  type: "task";
  prompt: string;
  action?: CardAction;
  /** Lifecycle status — drives the board's approve affordance (proposed only). */
  taskStatus?: TaskStatus;
  /** O4 routing risk tier (PR3's autopilot reads it; surfaced in the summary too). */
  riskTier?: "high" | "low";
  runnerHeartbeat?: { lastSeen: string; online: boolean };
  output?: string;
  failureReason?: string;
}

/** Payload for proposing a task from the board (O3 dispatch). */
export interface CreateTaskInput {
  agent: "codex" | "claude";
  repo: string;
  prompt: string;
  pullRequestNumber?: number;
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
