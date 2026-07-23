// Hermes Handoff Monitor — shared card-type definitions.
//
// Mirrors the data shapes the slack-operator /monitor/v2/board endpoint
// returns (see services/slack-operator/src/monitor-v2.ts). Most UI fields are
// boundary-local; the generic Harness projection stays on the shared INT-0
// contract so the browser cannot drift into a second definition.
//
// Data model documented in §5 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.
// Lane derivation: lane-rules.ts. Freshness math: urgency.ts.

import type { AgentRunProjectionV1 } from "@avg/schemas";

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

export type AgentType = "claude" | "codex" | "test-writer" | "security" | "docs" | "hermes" | "harness" | "ext";

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

/**
 * Mirrors the backend CardGroundTruth (monitor-v2.ts). The REAL signals of the
 * PR a proposed task's prompt cites, joined server-side from the already-fetched
 * PR summary. `verified:false` carries ONLY the honest "couldn't verify" reason
 * — the drawer must render that as a muted note, never a green/consistent state.
 */
export interface CardGroundTruth {
  pr: number;
  repo: string;
  verified: boolean;
  reason?: string;
  mergeableState?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  checks?: { passed: number; failed: number; total: number };
  touchedAreas?: string[];
  verdict?: string;
}

/** Mirrors the backend CardClaimFlag — a conservative, high-confidence mismatch
 *  between a task's claim and the PR's real signals. */
export interface CardClaimFlag {
  kind: "claimed_blocked_but_mergeable" | "claimed_category_absent";
  detail: string;
}

export interface CardReviewRequest {
  id: string;
  requestedBy: "hermes" | "operator" | "codex" | "claude" | "test-writer" | "security" | "docs";
  reviewer: "codex" | "claude" | "test-writer" | "security" | "docs" | "hermes" | "operator";
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

export type CardDiscussionAuthor = "claude" | "codex" | "test-writer" | "security" | "docs" | "hermes";

export interface CardDiscussionMessage {
  id: string;
  ts: number;
  author: CardDiscussionAuthor;
  kind: "chat" | "proposal" | "request_help" | "status";
  text: string;
  addressedTo: "everyone" | "claude" | "codex" | "test-writer" | "security" | "docs" | "hermes" | "operator";
  hermesMode?: "live" | "templated";
}

export interface CardSourceFailure {
  code: string;
  source: "github" | "runner" | "deploy" | "codex" | "harness";
  message: string;
  lastGoodAt?: string;
}

export interface CardWorkingNow {
  agent: AgentType;
  label: string;
  source: "runner" | "mission" | "classifier" | "harness";
  runnerId?: string;
  taskId?: string;
  since?: string;
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
  /** C4: real Hermes/agent discussion scoped to this card. */
  discussion?: CardDiscussionMessage[];
  /** Source read / heartbeat failure behind a degraded card. */
  sourceFailure?: CardSourceFailure;
  /** Agent currently working this in-flight card, backed by live runner/classifier state. */
  workingNow?: CardWorkingNow;
  /** Shared, schema-validated read projection for an allowlisted generic Harness run. */
  harnessRun?: AgentRunProjectionV1;
  /**
   * Hermes's grounded, agentic read of WHY a failed decision card likely failed
   * plus a recommended next step. Present only on failure cards when the
   * (flag-gated) failure-analysis routine produced one and it is still fresh for
   * the card's current failure. Absent otherwise — the drawer then keeps its
   * existing "Ask Hermes" pointer. Tagged as an agentic analysis in the UI.
   */
  hermesAnalysis?: { text: string; model?: string; at: string };
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
  lat?: string;
}

export interface MissionBlocker {
  head: string;
  body?: string;
}

export interface MissionEvidence {
  kind: "screenshot" | "trace" | "console" | "video";
  label: string;
  href: string;
}

/** One labeled 0..10 score from the structured report (beyond the fixed three). */
export interface MissionScore {
  label: string;
  value: number;
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
  /** What the mission was asked to test — surfaced as "Scope" at the top. */
  goal?: string;
  /** The agent's "what I tried" trace, newline-separated, as readable text. */
  narrative?: string;
  /** One-line "VERDICT — why" conclusion derived from the report. */
  conclusion?: string;
  /** All labeled scores the report carried (0..10), beyond the fixed three. */
  scores?: MissionScore[];
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

/** Live snapshot of a RUNNING mission (the rolling ~2s poll) — not a report. */
export interface MissionProgress {
  /** Latest stage line. */
  message?: string;
  /** Sanitized recent runner output — a rolling tail (older lines scroll off). */
  output?: string;
  /** When the latest progress was recorded (ISO). */
  at?: string;
  /** Latest screenshot URL — present only when a servable URL exists. */
  screenshot?: string;
  /** Optional P3b stream metadata. Missing means fall back to the P3 step-view. */
  liveScreencast?: {
    status: "running" | "ended" | "unavailable";
    streamUrl?: string;
    latestFrameUrl?: string;
    frameCount?: number;
    updatedAt?: string;
    reason?: string;
  };
}

/** Browser mission card (testbed). */
export interface MissionCard extends CardBase {
  type: "mission";
  mission?: MissionReport;
  /** requested missions are board-gated and cannot be claimed until approved. */
  missionStatus?: "requested" | "ready" | "running" | "completed" | "failed";
  /** Live progress while running; absent once the terminal report lands. */
  missionProgress?: MissionProgress;
}

/** Task lifecycle status (mirrors the serializer's TaskStatus). */
export type TaskStatus =
  | "proposed"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskTimelineEvent {
  at: string;
  status: TaskStatus | "progress";
  message: string;
}

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
  /** Real task lifecycle events recorded by the queue, used for Hermes timeline narration. */
  taskEvents?: TaskTimelineEvent[];
  output?: string;
  failureReason?: string;
  /** Ground-truth of the PR this task's prompt cites (when it cites one). Drives
   *  the drawer's "verify the claim against the real PR" panel. */
  groundTruth?: CardGroundTruth;
  /** Conservative, high-confidence claim-vs-reality mismatches for that PR. */
  claimFlags?: CardClaimFlag[];
}

/** Payload for proposing a task from the board (O3 dispatch). */
export interface CreateTaskInput {
  agent: "codex" | "claude" | "test-writer" | "security" | "docs";
  repo: string;
  prompt: string;
  pullRequestNumber?: number;
}

/** Deploy verification card. */
export interface DeployCard extends CardBase {
  type: "deploy";
  deployId?: string;
  /**
   * Legacy deploy progress. The live backend may omit it, and the numeric
   * current/total values are not step-specific enough to prove completed named
   * stages. The UI may use the label as a current-stage hint only.
   */
  verification?: { current: number; total: number; label: string };
  /** Future exact deploy-step source. Omitted until the backend wires it. */
  deploySteps?: {
    id?: string;
    label: string;
    state: "done" | "in-progress" | "pending" | "current" | "running" | "pass" | "success";
    detail?: string;
    source?: string;
  }[];
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
