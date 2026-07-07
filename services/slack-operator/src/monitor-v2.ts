// Hermes Handoff Monitor — v2 typed board snapshot.
//
// M1' of the monitor redesign (see docs/HERMES_MONITOR_REDESIGN_SPEC.md).
//
// The legacy HTML monitor reads `buildHermesBoardSnapshotFromMonitor()`,
// which classifies the raw monitor snapshot into lanes + slim cards
// (HermesBoardCardSnapshot). The redesigned React UI needs a richer,
// strongly-typed card shape (BoardCard) with a stable id, a type
// discriminator, freshness in minutes, a card state, structured
// waiting-on info, and risk tags.
//
// This module does NOT re-implement classification — it builds on the
// existing classified board and enriches each slim card into a
// BoardCard. That keeps lane/owner/verdict logic in one place
// (monitor-hermes-board.ts) and makes the v2 mapper a thin, testable
// transform.
//
// The output is what `GET /monitor/v2/board` serializes and what the
// SSE `board.snapshot` event carries.

import {
  buildHermesBoardSnapshotFromMonitor,
  isQuietAutomationCapacityReason,
} from "./monitor-hermes-board.js";
import {
  aggregateLlmUsage,
  listActiveLlmUsageCalls,
  resolveOllamaPlan,
  type LlmUsageAggregate,
  type LlmUsageEvent,
} from "@avg/averray-mcp/llm-usage";
import { buildAgentScorecard } from "@avg/averray-mcp/agent-scorecard";
import type { TestbedSuite } from "./monitor-testbed-suites.js";
import type {
  HermesBoardCardSnapshot,
  HermesBoardSnapshot,
} from "./monitor-hermes-voice.js";
import type { CodexRunnerHeartbeat, CodexTask } from "./codex-task-queue.js";
import { summarizeTaskHealth, type TaskHealthDiagnostics } from "./task-health.js";
import {
  testbedMissionStructuredReport,
  type TestbedMissionRun,
} from "./monitor-testbed-missions.js";
import { testbedSurfaceKey, surfaceLabel } from "./self-healing.js";
import {
  isHermesDecisionRecord,
  type HermesDecisionRecord,
} from "@avg/averray-mcp/decision-records";
import {
  evaluateReviewPanel,
  type ReviewPanelEvaluation,
  type ReviewPanelResponse,
  type ReviewPanelReviewer,
} from "./reviewer-panel.js";
import { hashFailureContext, type FailureAnalysisCard } from "./monitor-failure-analysis.js";

// ── v2 typed model ──────────────────────────────────────────────────

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

export type AgentType = "claude" | "codex" | "test-writer" | "security" | "docs" | "hermes" | "ext";

export type CardState = "fresh" | "stale" | "failed-fetch" | "source-offline" | "running";

export type RiskTag =
  | "workflow" | "config" | "review-gated"
  | "contracts" | "secrets" | "indexer" | "xcm"
  | "docs" | "testbed" | "ui-only" | "deps" | "quality";

export interface WaitingOn {
  actor: "operator" | "author" | "agent" | "CI" | "relay" | "branch-protection";
  tone: "warn" | "info" | "neutral";
}

/** Task lifecycle status, mirrors codex-task-queue CodexTaskStatus. */
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

export type MissionStatus =
  | "requested"
  | "ready"
  | "running"
  | "completed"
  | "failed";

/** CI check rollup for the card's checks bar. Mirrors the UI CardChecks. */
export interface CardChecks {
  pass: number;
  running: number;
  fail: number;
  pending: number;
  total: number;
}

/**
 * One changed file + its risk classification. `diff` is the "+N -M" line;
 * it is left empty when the upstream review signal didn't capture
 * additions/deletions (the monitor fetch keeps only the filename).
 */
export interface CardFile {
  path: string;
  diff: string;
  critical: boolean;
}

/** Codex runner liveness for a task card. */
export interface CardRunnerHeartbeat {
  lastSeen: string;
  online: boolean;
}

export interface CardWorkingNow {
  agent: AgentType;
  label: string;
  source: "runner" | "mission" | "classifier";
  runnerId?: string;
  taskId?: string;
  since?: string;
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
  source: "github" | "runner" | "deploy" | "codex";
  message: string;
  lastGoodAt?: string;
}

/**
 * The REAL signals of the PR a proposed task's prompt cites, joined from the
 * already-fetched PR summary (zero new network calls). Lets the operator judge
 * a task's free-text premise against the PR's actual state at the decision
 * point. `verified:false` carries ONLY the honest "couldn't verify" reason —
 * never a partial/fabricated signal set (see reconcileTaskClaim).
 */
export interface CardGroundTruth {
  /** The PR number cited in the task prompt/reason (or task.pullRequestNumber). */
  pr: number;
  repo: string;
  /** true ⇒ the PR was found among the fetched open PRs and its signals are real. */
  verified: boolean;
  /** Only when verified:false — why the PR state couldn't be confirmed. */
  reason?: string;
  mergeableState?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  checks?: { passed: number; failed: number; total: number };
  touchedAreas?: string[];
  verdict?: string;
}

/**
 * A CONSERVATIVE, high-confidence mismatch between the task's free-text claim
 * and the PR's real signals. Emitted only when unambiguous — a false "no
 * mismatch" is fine (the operator still sees the real ground truth), a false
 * "MISMATCH!" cries wolf, so when unsure we emit nothing.
 */
export interface CardClaimFlag {
  kind: "claimed_blocked_but_mergeable" | "claimed_category_absent";
  detail: string;
}

// ── Mission report (testbed browser missions) ───────────────────────
// Mirrors the UI MissionReport. The optional numeric fields (runs,
// latency, per-step latency, and the 0–10 scores) are populated only
// when the agent's structured report actually carries them.
export interface CardMissionStep {
  n: number;
  status: "ok" | "warn" | "fail";
  desc: string;
  lat?: string;
}
export interface CardMissionBlocker {
  head: string;
  body?: string;
}
export interface CardMissionScore {
  label: string;
  value: number;
}
export interface CardMissionEvidence {
  kind: "screenshot" | "trace" | "console" | "video";
  label: string;
  href: string;
}
/** Live snapshot of a RUNNING mission (rolling ~2s poll), not a final report. */
export interface CardMissionProgress {
  /** Latest stage line (`progressMessage`). */
  message?: string;
  /** Sanitized recent runner output — a rolling tail (older lines scroll off). */
  output?: string;
  /** When the latest progress was recorded (ISO). */
  at?: string;
  /** Latest screenshot URL — present only when an absolute, servable URL exists.
   *  P3b screencast frames use relative monitor-authenticated URLs instead and
   *  are exposed through `liveScreencast`. */
  screenshot?: string;
  /** Optional P3b stream metadata. Present only when the runner published a
   *  real bounded screencast stream or an honest unavailable reason. */
  liveScreencast?: {
    status: "running" | "ended" | "unavailable";
    streamUrl?: string;
    latestFrameUrl?: string;
    frameCount?: number;
    updatedAt?: string;
    reason?: string;
  };
}
export interface CardMissionReport {
  verdict: "OK" | "PARTIAL" | "FAILED";
  verdictTone: "ok" | "warn" | "fail";
  /** 0..1 */
  confidence: number;
  target: string;
  /** What the mission was asked to test (run.goal) — the operator's "Scope". */
  goal?: string;
  /** The agent's "what I tried" trace (newline-separated), pulled out of the
   *  evidence list so it reads as a narrative rather than a buried trace row. */
  narrative?: string;
  /** One-line "VERDICT — why" conclusion derived from the report. */
  conclusion?: string;
  /** All labeled scores the report carried (0..10), beyond the fixed three. */
  scores?: CardMissionScore[];
  seed: string;
  path: CardMissionStep[];
  blockers: CardMissionBlocker[];
  evidence: CardMissionEvidence[];
  mutationBoundary: string;
  recommendations: string[];
  runs?: number;
  latency?: string;
  successScore?: number;
  clarityScore?: number;
  latencyScore?: number;
}

export interface BoardCard {
  id: string;
  lane: Lane;
  type: CardType;
  agentType: AgentType;
  title: string;
  summary: string;
  repo: string;
  branch?: string;
  freshness: number; // minutes since entering current lane; 0 when unknown
  state: CardState;
  risk: RiskTag[];
  waitingOn: WaitingOn;
  isAction?: boolean;
  isDraft?: boolean;
  archiveHint?: boolean;
  /** Free-form "next action" copy carried from the classifier. */
  next?: string;
  /** Stable correlation id for non-PR cards (mission/task/deploy), when present. */
  correlationId?: string;
  /** Hermes verdict / reasoning carried from the classifier. */
  verdict?: string;

  // ── Enriched fields ─────────────────────────────────────────────
  // Populated by enrichBoardCard() from the raw monitor snapshot.
  // All optional and omitted when the underlying real data isn't
  // present, so a card never claims detail it doesn't actually have.
  /** CI checks rollup (non-done cards, when GitHub checks were fetched). */
  checks?: CardChecks;
  /** Changed files + risk flags (non-done cards). */
  files?: CardFile[];
  /** Done cards: merged vs. closed-without-merge. */
  mergeStatus?: "MERGED" | "CLOSED";
  /**
   * Done cards: when the PR last changed. This is the PR's updatedAt —
   * the monitor PR state doesn't carry an exact merged/closed timestamp,
   * and for a terminal PR updatedAt is the closest real signal.
   */
  closedAt?: string;
  /** Done cards: short verdict line ("merged" / "closed"). */
  verdictText?: string;
  /** Codex/Claude task cards: lifecycle status (drives the board's
   *  approve affordance — only `proposed` tasks show "Approve"). */
  taskStatus?: TaskStatus;
  /** Task cards: O4 routing risk tier (PR3's autopilot reads it). */
  riskTier?: "high" | "low";
  /** Codex task cards: the dispatched prompt. */
  prompt?: string;
  /** Codex task cards: tail of stdout / completion summary. */
  output?: string;
  /** Codex task cards: failure reason when the task failed. */
  failureReason?: string;
  /** Source read / heartbeat failure behind a degraded card. */
  sourceFailure?: CardSourceFailure;
  /** Codex task cards: runner liveness. */
  runnerHeartbeat?: CardRunnerHeartbeat;
  /** Real task lifecycle events recorded by the queue, used for Hermes timeline narration. */
  taskEvents?: TaskTimelineEvent[];
  /**
   * Proposed-task cards: the REAL signals of the PR the task's prompt cites,
   * joined from the already-fetched PR summary (no new fetch). Present only when
   * the task prose (or pullRequestNumber) references a PR. Lets the operator
   * catch a fabricated premise at the decision point. Absent ⇒ no PR cited.
   */
  groundTruth?: CardGroundTruth;
  /**
   * Proposed-task cards: conservative, high-confidence mismatches between the
   * task's claim and the PR's real signals. Only ever set alongside a
   * `verified:true` groundTruth; empty/absent when the claim is consistent or
   * the PR couldn't be verified.
   */
  claimFlags?: CardClaimFlag[];
  /** Agent currently working this in-flight card, backed by live runner/classifier state. */
  workingNow?: CardWorkingNow;
  /** Per-check CI breakdown (non-done cards) — the list under the bar. */
  checkRuns?: CardCheckRun[];
  /** Hermes review findings (non-done cards) — the "why review" detail. */
  riskSignals?: CardRiskSignal[];
  /** Mission cards: the browser agent's structured report, when posted. */
  mission?: CardMissionReport;
  /** Mission lifecycle status; requested missions are board-gated and not runner-claimable. */
  missionStatus?: MissionStatus;
  /** Live progress while a mission is RUNNING (the rolling ~2s poll snapshot):
   *  stage message + a sanitized recent-output tail. No verdict — the agent
   *  posts that only in the terminal report. */
  missionProgress?: CardMissionProgress;
  /** D2: latest durable explanation associated with this card. */
  decisionRecord?: HermesDecisionRecord;
  /** C1: active cross-agent review requests scoped to this card. */
  reviewRequests?: CardReviewRequest[];
  /** C4: real Hermes/agent discussion scoped to this card. */
  discussion?: CardDiscussionMessage[];
  /**
   * Hermes's grounded, agentic read of WHY this failed decision card likely
   * failed + a recommended next step. Threaded on from the failure-analysis
   * cache ONLY for failure cards, and ONLY when the cached analysis is still
   * fresh for the card's current failure context. Absent otherwise.
   */
  hermesAnalysis?: { text: string; model?: string; at: string };
}

export interface BoardSnapshotV2 {
  cards: BoardCard[];
  at: string;
  repo: string;
  llmUsage: LlmUsageAggregate;
  testbedSuites: TestbedSuite[];
  automationHealth?: AutomationHealth;
}

export type BoardCardStreamEvent =
  | { type: "board.card.added"; card: BoardCard; at: string }
  | { type: "board.card.updated"; id: string; partial: BoardCard; card: BoardCard; at: string }
  | { type: "board.card.moved"; id: string; fromLane: Lane; toLane: Lane; card: BoardCard; at: string }
  | { type: "board.card.archived"; id: string; fromLane?: Lane; at: string };

export interface AutomationHealth {
  /** Whether task-queue backed automation counts are known for this snapshot. */
  sourceStatus: "ok" | "degraded";
  /** Non-terminal self-healing fix proposals currently open. */
  selfHealingOpen: number | null;
  /** Hermes/system-managed task proposals created today. */
  dispatchUsedToday: number | null;
  /** Same cap used by the dispatch/self-healing backstops. */
  dispatchPerDayCap: number;
  /** Slack-only capacity/escalation signals kept off the decision lanes. */
  quietSignalCount: number | null;
  selfHealingCapacitySignals: number | null;
  taskHealthCapacitySignals: number | null;
  /** O5 read-only task health summary: stuck means runner evidence says the task is not actually progressing. */
  taskHealth: TaskHealthDiagnostics;
  /** ORCH-P4c routing memory summary for auditability; hard taxonomy/policy still win. */
  routing: {
    status: "baseline_available" | "insufficient_data" | "unknown";
    decisionsToday: number | null;
    surfaces: number | null;
    baselineSurfaces: number | null;
    insufficientSurfaces: number | null;
    top?: {
      surface: string;
      agent: string;
      score: number;
      samples: number;
    };
  };
  guardrails: {
    dispatchPolicy: "enforced";
    haltInterlock: "enforced";
    anomalyPause: "enforced";
    authority: "human_merge_gate";
  };
}

// ── Lane normalization ──────────────────────────────────────────────

const LANE_BY_LABEL: Record<string, Lane> = {
  "needs attention": "needs-attention",
  "waiting / drafts": "drafts",
  "drafts": "drafts",
  "codex needed": "codex-needed",
  "hermes checking": "hermes-checking",
  "operator review": "operator-review",
  "release queue": "release-queue",
  "deploying": "deploying",
  "done": "done",
};

/**
 * Map a classifier lane label (Title Case, e.g. "Operator Review")
 * to the kebab-case Lane enum the redesign uses. Unknown labels fall
 * back to "hermes-checking" — visible but not claiming operator
 * attention.
 */
export function normalizeLane(label: string | undefined): Lane {
  if (!label) return "hermes-checking";
  return LANE_BY_LABEL[label.trim().toLowerCase()] ?? "hermes-checking";
}

// ── Card-type inference ─────────────────────────────────────────────

const RISK_TAGS = new Set<RiskTag>([
  "workflow", "config", "review-gated",
  "contracts", "secrets", "indexer", "xcm",
  "docs", "testbed", "ui-only", "deps", "quality",
]);

/**
 * Filter a free-form tags array down to the recognized RiskTag enum.
 * Unrecognized tags are dropped (rather than rendered as risk pills
 * the UI doesn't have styling for).
 */
export function mapTagsToRisk(tags: ReadonlyArray<string> | undefined): RiskTag[] {
  if (!Array.isArray(tags)) return [];
  const out: RiskTag[] = [];
  for (const t of tags) {
    const norm = String(t).trim().toLowerCase();
    if (RISK_TAGS.has(norm as RiskTag)) out.push(norm as RiskTag);
  }
  return out;
}

/**
 * Infer the card type from the classifier output. Heuristics:
 *   - testbed tag or "mission" in the title → mission
 *   - codex-needed lane or owner Codex with a task shape → task
 *   - done lane → done
 *   - a deploy-flavored title/owner → deploy
 *   - otherwise → pr (the common case)
 */
export function inferCardType(item: HermesBoardCardSnapshot, lane: Lane): CardType {
  const tags = (item.tags ?? []).map((t) => String(t).toLowerCase());
  const title = (item.title ?? "").toLowerCase();
  if (tags.includes("testbed") || /\bmission\b/.test(title)) return "mission";
  if (lane === "done") return "done";
  if (lane === "codex-needed") return "task";
  if (lane === "deploying" || /post-merge verify|deploy verif/.test(title)) return "deploy";
  if (lane === "drafts") return "draft";
  return "pr";
}

/**
 * Map a PR head branch to the agent that opened it via the branch-prefix
 * convention (codex/* → codex, claude/* → claude, case-insensitive).
 * Returns undefined for non-agent branches so callers fall back to the
 * owner heuristic.
 */
export function agentTypeFromBranch(headBranch?: string): AgentType | undefined {
  const b = (headBranch ?? "").trim().toLowerCase();
  if (b.startsWith("codex/")) return "codex";
  if (b.startsWith("claude/")) return "claude";
  if (b.startsWith("test-writer/")) return "test-writer";
  if (b.startsWith("security/")) return "security";
  if (b.startsWith("docs/")) return "docs";
  return undefined;
}

/**
 * Infer the agent that owns the card. Missions are always Hermes; then
 * the PR head branch wins (codex/*, claude/*) since the branch-prefix
 * convention is authoritative for who opened the PR; otherwise fall back
 * to the classifier `owner` heuristic, defaulting to "ext".
 */
export function inferAgentType(item: HermesBoardCardSnapshot, type: CardType): AgentType {
  if (type === "mission") return "hermes";
  const fromBranch = agentTypeFromBranch(item.headBranch);
  if (fromBranch) return fromBranch;
  const owner = (item.owner ?? "").toLowerCase();
  if (owner.includes("codex")) return "codex";
  if (owner.includes("hermes")) return "hermes";
  if (owner.includes("claude")) return "claude";
  if (owner.includes("test-writer") || owner.includes("test writer")) return "test-writer";
  if (owner.includes("security")) return "security";
  if (owner.includes("docs")) return "docs";
  return "ext";
}

/**
 * Map the classifier `owner` string to a structured WaitingOn.
 * Tone escalates to "warn" only when the operator is the blocker
 * (so the UI's amber treatment fires for the right cases).
 */
export function mapOwnerToWaitingOn(owner: string | undefined, isAction: boolean): WaitingOn {
  const o = (owner ?? "").toLowerCase();
  if (o.includes("operator")) return { actor: "operator", tone: isAction ? "warn" : "neutral" };
  if (o.includes("pr author") || o.includes("author")) return { actor: "author", tone: "neutral" };
  if (o.includes("merge steward") || o.includes("steward")) return { actor: "branch-protection", tone: "neutral" };
  if (o.includes("codex")) return { actor: "agent", tone: "info" };
  if (o.includes("hermes")) return { actor: "agent", tone: "info" };
  if (o.includes("history")) return { actor: "operator", tone: "neutral" };
  return { actor: "agent", tone: "info" };
}

/**
 * Parse a free-form age label ("4m", "2h", "3d", "12 minutes ago")
 * into minutes. Returns 0 when unparseable so the card renders
 * calmly rather than claiming a freshness we can't prove.
 */
export function parseAgeToMinutes(ageLabel: string | undefined): number {
  if (!ageLabel || typeof ageLabel !== "string") return 0;
  const s = ageLabel.trim().toLowerCase();
  // Match the leading number + unit (m/min, h/hr, d/day).
  const match = s.match(/(\d+(?:\.\d+)?)\s*(m|min|minute|h|hr|hour|d|day)/);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2];
  if (unit.startsWith("m")) return Math.round(value);
  if (unit.startsWith("h")) return Math.round(value * 60);
  if (unit.startsWith("d")) return Math.round(value * 60 * 24);
  return 0;
}

// ── The mapper ──────────────────────────────────────────────────────

/**
 * Build a stable id for a card. Prefers `repo #number`; falls back
 * to a slug of the title when no PR identity exists (e.g. missions,
 * tasks). Ids must be stable across snapshots so the SSE diff +
 * the drawer URL param resolve correctly.
 */
export function cardId(item: HermesBoardCardSnapshot): string {
  if (item.repo && typeof item.number === "number") {
    return `${shortRepo(item.repo)} #${item.number}`;
  }
  const slug = slugify(item.title ?? "card").slice(0, 40);
  // Identity-less cards (deploy verifications, missions, tasks) often
  // share a generic title — e.g. every "post-deploy verification" card.
  // Without a discriminator they'd collapse onto one id, which breaks
  // React keys, SSE card diffing, and drawer routing. Append a short,
  // stable suffix from the classifier correlationId so distinct items
  // get distinct ids.
  if (item.correlationId) {
    const suffix = slugify(item.correlationId).slice(-12);
    if (suffix) return (slug ? `${slug}-${suffix}` : suffix).slice(0, 64);
  }
  return slug || "card";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shortRepo(repo: string): string {
  // "depre-dev/agent" → "agent"; keep the bare repo name for the id.
  const idx = repo.lastIndexOf("/");
  return idx === -1 ? repo : repo.slice(idx + 1);
}

/**
 * Map one classified slim card to the rich BoardCard. The single
 * unit-test boundary for the v2 transform.
 */
export function toBoardCard(item: HermesBoardCardSnapshot): BoardCard {
  const lane = normalizeLane(item.lane);
  const type = inferCardType(item, lane);
  const isAction = lane === "needs-attention";
  const isDraft = lane === "drafts";
  let waitingOn = mapOwnerToWaitingOn(item.owner, isAction);
  // A deploy card is post-merge (verifying the deploy), so it can never be
  // waiting on branch protection — that owner label is a pre-merge artifact
  // from the producer. Correct it to CI (the post-merge verification it
  // actually awaits). Other owners (operator / agent) are left untouched.
  if (type === "deploy" && waitingOn.actor === "branch-protection") {
    waitingOn = { actor: "CI", tone: "info" };
  }

  const card: BoardCard = {
    id: cardId(item),
    lane,
    type,
    agentType: inferAgentType(item, type),
    title: item.title || "Untitled handoff",
    summary: item.why ?? item.verdict ?? "",
    repo: item.repo ?? "",
    freshness: parseAgeToMinutes(item.ageLabel),
    state: "fresh",
    risk: mapTagsToRisk(item.tags),
    waitingOn,
  };

  if (isAction) card.isAction = true;
  if (isDraft) card.isDraft = true;
  if (item.next) card.next = item.next;
  if (item.verdict) card.verdict = item.verdict;
  if (item.headBranch) card.branch = item.headBranch;
  if (item.correlationId) card.correlationId = item.correlationId;

  return card;
}

// ── Card enrichment ─────────────────────────────────────────────────
//
// The slim classified card (HermesBoardCardSnapshot) drops the rich
// per-PR detail that the raw monitor snapshot already carries on each
// item's `summary` (githubLive check totals, reviewSignals touched
// files, the PR merge state) and on the top-level `codexTasks`. The
// redesigned UI can render all of it. We project that already-fetched
// data onto the BoardCard here — zero new network calls — so the live
// board shows real checks bars, file lists, merge verdicts, and Codex
// task detail instead of bare cards.
//
// Everything is best-effort + defensive: the raw snapshot is `unknown`,
// so each field is guarded and simply omitted when absent.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mapTaskEvents(task: Record<string, unknown>): TaskTimelineEvent[] {
  return asArray(task.events).flatMap((entry) => {
    const event = asRecord(entry);
    if (!event) return [];
    const at = asString(event.at);
    const status = asTaskTimelineStatus(event.status);
    const message = asString(event.message);
    return at && status && message ? [{ at, status, message }] : [];
  });
}

function asTaskTimelineStatus(value: unknown): TaskTimelineEvent["status"] | undefined {
  if (
    value === "proposed"
    || value === "approved"
    || value === "running"
    || value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "progress"
  ) {
    return value;
  }
  return undefined;
}

const WATCH_LANES = new Set<Lane>(["codex-needed", "hermes-checking", "release-queue", "deploying"]);

function isWatchLane(lane: Lane): boolean {
  return WATCH_LANES.has(lane);
}

function defaultWorkingNowLabel(agent: AgentType): string {
  if (agent === "codex") return "Codex fixing";
  if (agent === "claude") return "Claude fixing";
  if (agent === "test-writer") return "Test-writer writing tests";
  if (agent === "security") return "Security reviewing";
  if (agent === "docs") return "Docs updating";
  if (agent === "hermes") return "Hermes reviewing";
  return "External agent working";
}

function workingNowFromRunningTask(
  task: Record<string, unknown>,
  runner: Record<string, unknown> | undefined,
): CardWorkingNow | undefined {
  if (asString(task.status) !== "running") return undefined;
  if (!runner || asString(runner.status) !== "running") return undefined;
  const taskId = asString(task.id);
  if (!taskId || asString(runner.activeTaskId) !== taskId) return undefined;
  const persisted = asRecord(task.workingNow);
  const agent = agentTypeFromTaskAgent(asString(persisted?.agent) ?? task.agent);
  const label = asString(persisted?.label) ?? defaultWorkingNowLabel(agent);
  const runnerId = asString(persisted?.runnerId) ?? asString(task.runnerId) ?? asString(runner.runnerId);
  const since = asString(persisted?.since) ?? asString(task.startedAt) ?? asString(runner.updatedAt);
  return {
    agent,
    label,
    source: "runner",
    taskId,
    ...(runnerId ? { runnerId } : {}),
    ...(since ? { since } : {}),
  };
}

/** Project a running mission's live poll snapshot (stage + recent output). */
function missionRunProgress(run: Record<string, unknown> | undefined): CardMissionProgress | undefined {
  if (!run) return undefined;
  const message = asString(run.progressMessage);
  const output = asString(run.stdoutTail);
  const at = asString(run.progressAt) ?? asString(run.updatedAt);
  // A servable absolute screenshot URL only — never a local artifact path.
  const screenshotRaw = asString(run.progressScreenshotUrl) ?? asString(run.liveScreenshotUrl);
  const screenshot = screenshotRaw && /^https?:\/\//i.test(screenshotRaw) ? screenshotRaw : undefined;
  const liveScreencast = missionLiveScreencast(run);
  if (!message && !output && !screenshot && !liveScreencast) return undefined;
  return {
    ...(message ? { message } : {}),
    ...(output ? { output } : {}),
    ...(at ? { at } : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(liveScreencast ? { liveScreencast } : {}),
  };
}

function missionLiveScreencast(run: Record<string, unknown>): CardMissionProgress["liveScreencast"] | undefined {
  const source = asRecord(run.liveScreencast);
  if (!source) return undefined;
  const status = asString(source.status);
  if (status !== "running" && status !== "ended" && status !== "unavailable") return undefined;
  const streamUrl = asString(source.streamUrl);
  const latestFrameUrl = asString(source.latestFrameUrl);
  return {
    status,
    ...(streamUrl && streamUrl.startsWith("/monitor/testbed-missions/") ? { streamUrl } : {}),
    ...(latestFrameUrl && latestFrameUrl.startsWith("/monitor/testbed-missions/") ? { latestFrameUrl } : {}),
    ...(typeof source.frameCount === "number" ? { frameCount: source.frameCount } : {}),
    ...(asString(source.updatedAt) ? { updatedAt: asString(source.updatedAt) } : {}),
    ...(asString(source.reason) ? { reason: asString(source.reason) } : {}),
  };
}

function workingNowFromMissionRun(run: Record<string, unknown> | undefined): CardWorkingNow | undefined {
  if (!run || asString(run.status) !== "running") return undefined;
  const taskId = asString(run.id);
  const runnerId = asString(run.runnerId) ?? asString(run.agentName);
  const since = asString(run.startedAt) ?? asString(run.claimedAt) ?? asString(run.updatedAt);
  return {
    agent: "hermes",
    label: "Hermes reviewing",
    source: "mission",
    ...(taskId ? { taskId } : {}),
    ...(runnerId ? { runnerId } : {}),
    ...(since ? { since } : {}),
  };
}

function workingNowAgentFromOwner(owner: string | undefined): AgentType | undefined {
  const value = (owner ?? "").toLowerCase();
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude";
  if (value.includes("test-writer") || value.includes("test writer")) return "test-writer";
  if (value.includes("security")) return "security";
  if (value.includes("docs")) return "docs";
  if (value.includes("hermes")) return "hermes";
  return undefined;
}

function workingNowFromClassifier(card: BoardCard, item: HermesBoardCardSnapshot): CardWorkingNow | undefined {
  if (!isWatchLane(card.lane) || card.type === "task" || card.type === "mission" || card.lane === "codex-needed") {
    return undefined;
  }
  const agent = workingNowAgentFromOwner(item.owner);
  if (!agent) return undefined;
  return {
    agent,
    label: defaultWorkingNowLabel(agent),
    source: "classifier",
  };
}

// Self-healing task titles embed the namespaced surface key
// ("Self-healing fix: testbed:testbed-mission-7"). Tasks persist their title
// at creation time, so already-stored tasks keep the raw, doubled-looking
// form. Strip the internal "<namespace>:" at display time so every card —
// old or new — reads cleanly, matching how new proposals are now titled
// (surfaceLabel in self-healing.ts).
function humanizeTaskTitle(title: string): string {
  return title.replace(
    /^(Self-healing fix:\s*)(\S+)/,
    (_match, prefix: string, surface: string) => `${prefix}${surfaceLabel(surface)}`,
  );
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function countValue(value: unknown): number {
  return Math.max(0, Math.floor(asFiniteNumber(value) ?? 0));
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const str = asNonEmptyString(value);
    if (str) return str;
  }
  return undefined;
}

function formatLatency(value: unknown): string | undefined {
  const str = asNonEmptyString(value);
  if (str) return str;
  const n = asFiniteNumber(value);
  if (n === undefined) return undefined;
  return n >= 1000 ? `${Number((n / 1000).toFixed(2))}s` : `${Math.round(n)}ms`;
}

function parseSourceFailure(
  value: unknown,
  source: CardSourceFailure["source"],
): CardSourceFailure | undefined {
  const text = asNonEmptyString(value);
  if (text) {
    return { source, code: "ERROR", message: text };
  }
  const record = asRecord(value);
  if (!record) return undefined;
  const code = firstString(
    record.code,
    record.statusCode,
    record.httpStatus,
    record.status,
    record.exitCode !== undefined ? `EXIT ${String(record.exitCode)}` : undefined,
  );
  const message = firstString(record.message, record.error, record.reason, record.statusText, record.detail);
  if (!message && !code) return undefined;
  const lastGoodAt = firstString(record.lastGoodAt, record.lastSuccessfulAt, record.checkedAt, record.updatedAt);
  return {
    source,
    code: code ?? "ERROR",
    message: message ?? `${source} source read failed`,
    ...(lastGoodAt ? { lastGoodAt } : {}),
  };
}

function sourceFailureFromSummary(summary: Record<string, unknown> | undefined, type: CardType): CardSourceFailure | undefined {
  if (!summary) return undefined;
  const githubLive = asRecord(summary.githubLive);
  const githubFailure =
    parseSourceFailure(githubLive?.fetchError, "github")
    ?? parseSourceFailure(githubLive?.error, "github")
    ?? parseSourceFailure(githubLive?.failure, "github")
    ?? parseSourceFailure(summary.githubFetchError, "github")
    ?? parseSourceFailure(summary.githubError, "github");
  if (githubFailure) return githubFailure;

  if (type === "deploy") {
    const deployVerification = asRecord(summary.deployVerification);
    return (
      parseSourceFailure(deployVerification?.error, "deploy")
      ?? parseSourceFailure(summary.deployError, "deploy")
      ?? parseSourceFailure(summary.deploymentError, "deploy")
    );
  }

  return undefined;
}

function runnerSourceFailure(
  runner: Record<string, unknown> | undefined,
  now: Date = new Date(),
): CardSourceFailure | undefined {
  if (!runner) {
    return {
      source: "runner",
      code: "MISSING",
      message: "runner heartbeat is missing",
    };
  }
  const status = asString(runner.status);
  const lastGoodAt = firstString(runner.lastGoodAt, runner.updatedAt);
  const runnerStale = runner.stale === true || minutesSince(asString(runner.updatedAt), now) > 2;
  if (status === "disabled" || status === "misconfigured" || status === "error" || status === "failed") {
    const explicit = parseSourceFailure(runner.error ?? runner.failureReason ?? runner.message, "runner");
    const finalLastGoodAt = explicit?.lastGoodAt ?? lastGoodAt;
    return {
      source: "runner",
      code: explicit?.code ?? status.toUpperCase(),
      message: explicit?.message ?? `runner is ${status}`,
      ...(finalLastGoodAt ? { lastGoodAt: finalLastGoodAt } : {}),
    };
  }
  if (runnerStale) {
    return {
      source: "runner",
      code: "STALE",
      message: "runner heartbeat is stale",
      ...(lastGoodAt ? { lastGoodAt } : {}),
    };
  }
  return undefined;
}

function usageEvents(value: unknown): LlmUsageEvent[] {
  return asArray(value)
    .map((entry) => {
      const event = asRecord(entry);
      if (!event) return undefined;
      const agent = asString(event.agent);
      const model = asString(event.model);
      const ts = asString(event.ts);
      const inputTokens = asFiniteNumber(event.inputTokens);
      const outputTokens = asFiniteNumber(event.outputTokens);
      if (!agent || !model || !ts || inputTokens === undefined || outputTokens === undefined) return undefined;
      if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) return undefined;
      const costUsd = asFiniteNumber(event.costUsd);
      const cacheTokens = asFiniteNumber(event.cacheTokens);
      return {
        agent,
        model,
        ...(asString(event.runId) ? { runId: asString(event.runId) } : {}),
        ...(asString(event.taskId) ? { taskId: asString(event.taskId) } : {}),
        inputTokens,
        outputTokens,
        ...(cacheTokens !== undefined && Number.isInteger(cacheTokens) ? { cacheTokens } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ts,
      };
    })
    .filter((event): event is LlmUsageEvent => Boolean(event));
}

/**
 * High-risk file predicate. Mirrors the "high" branch of
 * github-pr-state.ts `highRiskForFile` (which is module-private), so the
 * `critical` flag on a card file matches the review-gating logic.
 */
export function isCriticalFile(path: string): boolean {
  const p = path.toLowerCase();
  return (
    p.includes("secret") ||
    p.endsWith(".env") ||
    p.includes(".env.") ||
    p.includes("migration") ||
    p.startsWith("contracts/") ||
    p.endsWith(".sol")
  );
}

/**
 * Map a raw item `summary.githubLive.checkTotals`
 * ({total,passed,failed,active,neutral}) to the UI CardChecks shape.
 * Returns undefined when there are no checks to show (no totals object,
 * or a zero total) so we don't render an empty "0/0" bar.
 */
export function mapChecks(summary: Record<string, unknown> | undefined): CardChecks | undefined {
  const githubLive = asRecord(summary?.githubLive);
  const totals = asRecord(githubLive?.checkTotals);
  if (!totals) return undefined;
  const total = asFiniteNumber(totals.total);
  if (total === undefined || total <= 0) return undefined;
  return {
    pass: asFiniteNumber(totals.passed) ?? 0,
    running: asFiniteNumber(totals.active) ?? 0,
    fail: asFiniteNumber(totals.failed) ?? 0,
    pending: asFiniteNumber(totals.pending) ?? asFiniteNumber(totals.neutral) ?? 0,
    total,
  };
}

/**
 * Map a raw item `summary.reviewSignals.touchedFiles`
 * ([{path,area,additions?,deletions?}]) to the UI CardFile shape. `diff`
 * is a "+A -D" line when the fetch captured additions/deletions, else "".
 */
export function mapFiles(summary: Record<string, unknown> | undefined): CardFile[] {
  const reviewSignals = asRecord(summary?.reviewSignals);
  const touched = asArray(reviewSignals?.touchedFiles);
  const files: CardFile[] = [];
  for (const entry of touched) {
    const file = asRecord(entry);
    const path = asString(file?.path);
    if (!path) continue;
    const additions = asFiniteNumber(file?.additions);
    const deletions = asFiniteNumber(file?.deletions);
    const diff =
      additions !== undefined || deletions !== undefined
        ? `+${additions ?? 0} -${deletions ?? 0}`
        : "";
    files.push({ path, diff, critical: isCriticalFile(path) });
  }
  return files;
}

/**
 * Map a raw item `summary.checks` ([{name,status,conclusion}]) to the
 * per-check breakdown. Same status logic as summarizeGithubChecks: not
 * completed → running; success → pass; failure-ish → fail; else neutral.
 */
export function mapCheckRuns(summary: Record<string, unknown> | undefined): CardCheckRun[] {
  const FAIL = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure"]);
  const runs: CardCheckRun[] = [];
  for (const entry of asArray(summary?.checks)) {
    const check = asRecord(entry);
    const name = asString(check?.name);
    if (!name) continue;
    const status = (asString(check?.status) ?? "").toLowerCase();
    const conclusion = (asString(check?.conclusion) ?? "").toLowerCase();
    let mapped: CardCheckRun["status"];
    if (status !== "completed") mapped = "running";
    else if (conclusion === "success") mapped = "pass";
    else if (FAIL.has(conclusion)) mapped = "fail";
    else mapped = "neutral";
    runs.push({ name, status: mapped });
  }
  return runs;
}

/**
 * Map a raw item `summary.reviewReasons`
 * ([{severity,code,message}]) to the UI risk-signal list. Drops the
 * all-clear "pr_review_green" sentinel so a green PR shows no findings.
 */
export function mapRiskSignals(summary: Record<string, unknown> | undefined): CardRiskSignal[] {
  const SEVERITIES = new Set(["low", "medium", "high"]);
  const signals: CardRiskSignal[] = [];
  for (const entry of asArray(summary?.reviewReasons)) {
    const reason = asRecord(entry);
    const code = asString(reason?.code);
    const message = asString(reason?.message);
    if (!code || !message || code === "pr_review_green") continue;
    const sev = (asString(reason?.severity) ?? "").toLowerCase();
    signals.push({ severity: SEVERITIES.has(sev) ? (sev as CardRiskSignal["severity"]) : "low", code, message });
  }
  return signals;
}

/** Stable per-PR correlation key: `<full-repo>#<number>`. */
function prKey(repo: string | undefined, number: number | undefined): string | undefined {
  if (!repo || typeof number !== "number" || !Number.isFinite(number)) return undefined;
  return `${repo}#${number}`;
}

/**
 * Index every raw monitor item (active + recent) by its PR key so a
 * classified card can find its source `summary`. github-live entries
 * carry the rich `githubLive`/`reviewSignals`/`currentPullRequest`
 * detail we want to project.
 */
export function indexRawSummaries(rawSnapshot: unknown): Map<string, Record<string, unknown>> {
  const root = asRecord(rawSnapshot);
  const map = new Map<string, Record<string, unknown>>();
  if (!root) return map;
  for (const entry of [...asArray(root.active), ...asArray(root.recent)]) {
    const item = asRecord(entry);
    const summary = asRecord(item?.summary);
    if (!summary) continue;
    const pr = asRecord(summary.pullRequest) ?? asRecord(summary.currentPullRequest);
    const keys = [
      prKey(asString(pr?.repo), asFiniteNumber(pr?.number)),
      prKey(asString(item?.repo), asFiniteNumber(item?.pullRequestNumber)),
    ];
    for (const key of keys) {
      if (key && !map.has(key)) map.set(key, summary);
    }
  }
  return map;
}

/**
 * Index testbed mission runs (bundled on the snapshot as `testbedMissions`)
 * by run id. A mission card correlates to its run by correlationId (the
 * mission item sets `correlationId: run.id`), since mission items carry no
 * PR number and so can't be found via the PR-key summary index.
 */
export function indexTestbedMissions(rawSnapshot: unknown): Map<string, Record<string, unknown>> {
  const root = asRecord(rawSnapshot);
  const map = new Map<string, Record<string, unknown>>();
  for (const entry of asArray(root?.testbedMissions)) {
    const run = asRecord(entry);
    const id = asString(run?.id);
    if (id && run && !map.has(id)) map.set(id, run);
  }
  return map;
}

function reviewRequestsFromSnapshot(rawSnapshot: unknown): CardReviewRequestWithScope[] {
  const root = asRecord(rawSnapshot);
  const requests: CardReviewRequestWithScope[] = [];
  for (const entry of asArray(root?.reviewRequests)) {
    const request = asRecord(entry);
    if (!request) continue;
    const id = asString(request.id);
    const requestedBy = asReviewActor(request.requestedBy);
    const reviewer = asReviewActor(request.reviewer);
    const reason = asString(request.reason);
    const status = asReviewStatus(request.status);
    const reviewMode = asReviewMode(request.reviewMode);
    const panelId = asString(request.panelId);
    const panelSize = asFiniteNumber(request.panelSize);
    const response = asReviewResponse(request.response);
    const createdAt = asString(request.createdAt);
    const updatedAt = asString(request.updatedAt);
    if (!id || !requestedBy || !reviewer || !reason || !status || !createdAt || !updatedAt) continue;
    const relatedPr = asRecord(request.relatedPr);
    const relatedMission = asRecord(request.relatedMission);
    requests.push({
      id,
      requestedBy,
      reviewer,
      reason,
      status,
      ...(reviewMode ? { reviewMode } : {}),
      ...(panelId ? { panelId } : {}),
      ...(panelSize ? { panelSize } : {}),
      ...(response ? { response } : {}),
      createdAt,
      updatedAt,
      relatedPrKey: prKey(asString(relatedPr?.repo), asFiniteNumber(relatedPr?.number)),
      relatedMissionId: asString(relatedMission?.id),
      correlationId: asString(request.correlationId),
    });
  }
  return requests;
}

interface CardReviewRequestWithScope extends CardReviewRequest {
  relatedPrKey?: string;
  relatedMissionId?: string;
  correlationId?: string;
}

function asReviewActor(value: unknown): CardReviewRequest["requestedBy"] | undefined {
  if (value === "hermes" || value === "operator" || value === "codex" || value === "claude" || value === "test-writer" || value === "security" || value === "docs") return value;
  return undefined;
}

function asReviewStatus(value: unknown): CardReviewRequest["status"] | undefined {
  if (value === "requested" || value === "responded" || value === "cancelled") return value;
  return undefined;
}

function asReviewMode(value: unknown): CardReviewRequest["reviewMode"] | undefined {
  if (value === "single" || value === "panel") return value;
  return undefined;
}

function asReviewResponse(value: unknown): CardReviewRequest["response"] | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const verdict = record.verdict;
  if (verdict !== "pass" && verdict !== "concern" && verdict !== "block") return undefined;
  const reasoning = asString(record.reasoning);
  const respondedAt = asString(record.respondedAt);
  if (!reasoning || !respondedAt) return undefined;
  return { verdict, reasoning, respondedAt };
}

interface CardDiscussionMessageWithScope extends CardDiscussionMessage {
  relatedPrKey?: string;
  correlationId?: string;
}

function discussionMessagesFromSnapshot(rawSnapshot: unknown): CardDiscussionMessageWithScope[] {
  const root = asRecord(rawSnapshot);
  const messages: CardDiscussionMessageWithScope[] = [];
  for (const entry of asArray(root?.collaborationMessages)) {
    const message = asRecord(entry);
    if (!message) continue;
    const id = asString(message.id);
    const ts = asFiniteNumber(message.ts);
    const author = asDiscussionAuthor(message.author);
    const kind = asDiscussionKind(message.kind);
    const text = asString(message.text);
    const addressedTo = asDiscussionTarget(message.addressedTo);
    if (!id || ts === undefined || !author || !kind || !text || !addressedTo) continue;
    const relatedPr = asRecord(message.relatedPr);
    const hermesMode = author === "hermes" ? asHermesMode(message.hermesMode) : undefined;
    messages.push({
      id,
      ts,
      author,
      kind,
      text,
      addressedTo,
      ...(hermesMode ? { hermesMode } : {}),
      relatedPrKey: prKey(asString(relatedPr?.repo), asFiniteNumber(relatedPr?.number)),
      correlationId: asString(message.relatedCorrelationId),
    });
  }
  return messages;
}

function attachDiscussion(
  card: BoardCard,
  messages: readonly CardDiscussionMessageWithScope[],
  scope: { relatedPrKey?: string; correlationId?: string }
): BoardCard {
  const scoped = messages
    .filter((message) =>
      (scope.relatedPrKey !== undefined && message.relatedPrKey === scope.relatedPrKey)
      || (scope.correlationId !== undefined && message.correlationId === scope.correlationId)
      || (message.correlationId !== undefined && message.correlationId === card.id)
    )
    .sort((a, b) => a.ts - b.ts)
    .slice(-CARD_DISCUSSION_LIMIT)
    .map(({ relatedPrKey, correlationId, ...message }) => message);
  if (scoped.length === 0) return card;
  return { ...card, discussion: scoped };
}

function asDiscussionAuthor(value: unknown): CardDiscussionAuthor | undefined {
  if (value === "claude" || value === "codex" || value === "test-writer" || value === "security" || value === "docs" || value === "hermes") return value;
  return undefined;
}

function asDiscussionKind(value: unknown): CardDiscussionMessage["kind"] | undefined {
  if (value === "chat" || value === "proposal" || value === "request_help" || value === "status") return value;
  return undefined;
}

function asDiscussionTarget(value: unknown): CardDiscussionMessage["addressedTo"] | undefined {
  if (value === "everyone" || value === "claude" || value === "codex" || value === "test-writer" || value === "security" || value === "docs" || value === "hermes" || value === "operator") return value;
  return undefined;
}

function asHermesMode(value: unknown): CardDiscussionMessage["hermesMode"] | undefined {
  if (value === "live" || value === "templated") return value;
  return undefined;
}

function attachReviewRequests(
  card: BoardCard,
  requests: readonly CardReviewRequestWithScope[],
  scope: { relatedPrKey?: string; relatedMissionId?: string; correlationId?: string }
): BoardCard {
  const active = requests
    .filter((request) => request.status === "requested" || request.response !== undefined)
    .filter((request) =>
      (scope.relatedPrKey !== undefined && request.relatedPrKey === scope.relatedPrKey)
      || (scope.relatedMissionId !== undefined && request.relatedMissionId === scope.relatedMissionId)
      || (scope.correlationId !== undefined && request.correlationId === scope.correlationId)
      || (request.correlationId !== undefined && request.correlationId === card.id)
    )
    .map(({ relatedPrKey, relatedMissionId, correlationId, ...request }) => request);
  if (active.length === 0) return card;
  return promoteCardForReviewPanelEscalation({ ...card, reviewRequests: active }, active);
}

function promoteCardForReviewPanelEscalation(
  card: BoardCard,
  requests: readonly CardReviewRequest[]
): BoardCard {
  const escalation = firstReviewPanelEscalation(card, requests);
  if (!escalation) return card;
  const riskSignals = [
    ...(card.riskSignals ?? []),
    {
      severity: "high" as const,
      code: escalation.agreement === "blocked" ? "review_panel_blocked" : "review_panel_disagreement",
      message: escalation.summary,
    },
  ];
  const risk = Array.from(new Set([...card.risk, "workflow", "review-gated"] as RiskTag[]));
  return {
    ...card,
    lane: "needs-attention",
    isAction: true,
    waitingOn: { actor: "operator", tone: "warn" },
    risk,
    riskSignals,
    summary: card.summary ? `${escalation.summary} · ${card.summary}` : escalation.summary,
  };
}

function firstReviewPanelEscalation(
  card: BoardCard,
  requests: readonly CardReviewRequest[]
): ReviewPanelEvaluation | undefined {
  const panelIds = Array.from(new Set(
    requests
      .filter((request) => request.reviewMode === "panel" && request.panelId)
      .map((request) => request.panelId!)
  ));
  for (const panelId of panelIds) {
    const panelRequests = requests.filter((request) => request.panelId === panelId);
    const reviewers = panelRequests
      .map((request) => request.reviewer)
      .filter(isReviewPanelReviewer);
    const uniqueReviewers = Array.from(new Set(reviewers));
    if (uniqueReviewers.length < 2) continue;
    const responses: ReviewPanelResponse[] = panelRequests
      .filter((request): request is CardReviewRequest & {
        reviewer: ReviewPanelReviewer;
        response: NonNullable<CardReviewRequest["response"]>;
      } => Boolean(request.response) && isReviewPanelReviewer(request.reviewer))
      .map((request) => ({
        reviewer: request.reviewer,
        verdict: request.response.verdict,
        reasoning: request.response.reasoning,
      }));
    const evaluation = evaluateReviewPanel({
      panelId,
      relatedLabel: card.id,
      reviewers: uniqueReviewers,
      responses,
    });
    if (evaluation.escalate) return evaluation;
  }
  return undefined;
}

function isReviewPanelReviewer(value: CardReviewRequest["reviewer"]): value is ReviewPanelReviewer {
  return value === "hermes" || value === "codex" || value === "claude";
}

const EVIDENCE_KINDS = new Set(["screenshot", "trace", "console", "video"]);

/** Matches the agent-narrative evidence entry ("what_i_tried: …" / "what i tried: …"). */
const MISSION_NARRATIVE_RE = /^what[_ ]i[_ ]tried\s*:\s*/i;

/** Parse one structured-report evidence string ("type: detail") into the UI shape. */
function mapMissionEvidence(raw: string): CardMissionEvidence {
  const match = /^(\w+):\s*(.+)$/.exec(raw.trim());
  const kindRaw = match ? match[1]!.toLowerCase() : "";
  const kind = (EVIDENCE_KINDS.has(kindRaw) ? kindRaw : "trace") as CardMissionEvidence["kind"];
  const detail = (match ? match[2]! : raw).trim();
  const href = /^https?:\/\//i.test(detail) ? detail : "#";
  return { kind, label: detail, href };
}

function pickScore(scores: Record<string, number>, keys: string[]): number | undefined {
  for (const [k, v] of Object.entries(scores)) {
    if (keys.includes(k.toLowerCase()) && Number.isFinite(v)) return Math.round(v * 2); // 0..5 → 0..10
  }
  return undefined;
}

function reportSource(run: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(run.result);
  const structured = asRecord(result?.structuredReport);
  return structured ?? result ?? {};
}

function missionReportMode(source: Record<string, unknown>, run: Record<string, unknown>): string {
  const raw = firstString(
    source.mode,
    source.runnerMode,
    source.executor,
    source.pathName,
    source.kind,
    run.mode,
    run.environment,
  );
  return raw ? raw.replace(/_/g, "-") : "mission";
}

function conciseMissionDetail(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length <= 96 ? singleLine : `${singleLine.slice(0, 93)}...`;
}

function missionReportOneLine(run: Record<string, unknown>): string | undefined {
  const report = testbedMissionStructuredReport(run as unknown as TestbedMissionRun);
  if (!report) return undefined;
  const source = reportSource(run);
  const verdict = report.verdict.toUpperCase();
  const mode = missionReportMode(source, run);
  const blockerCount = report.blockers.length + report.confusingMoments.length;
  const blockerLabel = blockerCount === 1 ? "blocker" : "blockers";
  const topBlocker = report.blockers[0] ?? report.confusingMoments[0];
  const base = `${verdict} · ${mode} · ${blockerCount} ${blockerLabel}`;
  return topBlocker ? `${base} · ${conciseMissionDetail(topBlocker)}` : base;
}

function reportArrayEntry(source: Record<string, unknown>, key: string, index: number): Record<string, unknown> | undefined {
  const entry = asArray(source[key])[index];
  return asRecord(entry);
}

function missionStepLatency(source: Record<string, unknown>, index: number): string | undefined {
  const step = reportArrayEntry(source, "completedPath", index)
    ?? reportArrayEntry(source, "path", index)
    ?? reportArrayEntry(source, "steps", index)
    ?? reportArrayEntry(source, "completedSteps", index);
  return formatLatency(step?.lat ?? step?.latency ?? step?.latencyMs ?? step?.durationMs ?? step?.elapsedMs);
}

function missionStepDesc(source: Record<string, unknown>, index: number, fallback: string): string {
  const step = reportArrayEntry(source, "completedPath", index)
    ?? reportArrayEntry(source, "path", index)
    ?? reportArrayEntry(source, "steps", index)
    ?? reportArrayEntry(source, "completedSteps", index);
  return firstString(step?.desc, step?.description, step?.action, step?.name, step?.value)
    ?? (fallback === "[object Object]" ? "Step recorded by browser agent" : fallback);
}

/** Real per-step status when the report carries one; defaults to "ok" (a
 *  completed step) rather than inventing a pass/fail the data doesn't have. */
function missionStepStatus(source: Record<string, unknown>, index: number): CardMissionStep["status"] {
  const step = reportArrayEntry(source, "completedPath", index)
    ?? reportArrayEntry(source, "path", index)
    ?? reportArrayEntry(source, "steps", index)
    ?? reportArrayEntry(source, "completedSteps", index);
  const raw = firstString(step?.status, step?.verdict, step?.outcome, step?.state)?.toLowerCase();
  if (!raw) return "ok";
  if (/\b(fail|failed|error|blocked|blocker)\b/.test(raw)) return "fail";
  if (/\b(warn|partial|slow|skip|skipped|pending)\b/.test(raw)) return "warn";
  return "ok";
}

/** Humanize a score key ("success_rate" → "Success Rate"). */
function missionScoreLabel(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** Every labeled score the report carried, mapped 0..5 → 0..10. */
function missionScoreList(scores: Record<string, number>): CardMissionScore[] {
  return Object.entries(scores)
    .filter(([, value]) => Number.isFinite(value))
    .map(([key, value]) => ({ label: missionScoreLabel(key), value: Math.round(value * 2) }));
}

/** A one-line "VERDICT — why" conclusion derived from the report's own fields. */
function missionConclusion(
  report: ReturnType<typeof testbedMissionStructuredReport>,
  source: Record<string, unknown>,
): string | undefined {
  if (!report) return undefined;
  const verdict = report.verdict === "pass" ? "OK" : report.verdict === "partial" ? "PARTIAL" : "FAIL";
  const detail = report.verdict === "pass"
    ? firstString(source.conclusion, source.summary, report.summary, report.recommendations[0])
    : firstString(
      report.blockers[0],
      report.confusingMoments[0],
      report.recommendations[0],
      source.conclusion,
      source.summary,
      report.summary,
    );
  const cleaned = detail ? detail.replace(/^(pass|partial|fail|failed|ok)\s*:\s*/i, "").trim() : "";
  return cleaned ? `${verdict} — ${cleaned}` : undefined;
}

function missionBlockerHead(source: Record<string, unknown>, key: "blockers" | "confusingMoments", index: number, fallback: string): string {
  const entry = reportArrayEntry(source, key, index);
  return firstString(entry?.head, entry?.title, entry?.summary, entry?.label, entry?.message)
    ?? (fallback === "[object Object]" ? "Browser-agent finding" : fallback);
}

function missionBlockerBody(source: Record<string, unknown>, key: "blockers" | "confusingMoments", index: number): string | undefined {
  const entry = reportArrayEntry(source, key, index);
  if (!entry) return undefined;
  const evidence = asArray(entry.evidence)
    .map((value) => asNonEmptyString(value))
    .filter((value): value is string => Boolean(value));
  return firstString(
    entry.body,
    entry.detail,
    entry.details,
    entry.description,
    entry.message,
    evidence.length ? evidence.join(" ") : undefined,
  );
}

function missionRuns(source: Record<string, unknown>): number | undefined {
  const runs = asFiniteNumber(source.runs) ?? asFiniteNumber(source.runCount) ?? asFiniteNumber(source.attempts);
  return runs !== undefined && runs >= 0 ? runs : undefined;
}

function missionLatency(source: Record<string, unknown>): string | undefined {
  return formatLatency(source.latency ?? source.duration ?? source.durationMs ?? source.elapsedMs ?? source.totalLatencyMs);
}

/**
 * Map a stored testbed mission run to the UI MissionReport. Returns
 * undefined when the run has no structured report yet (e.g. still running),
 * so the card simply omits `mission` and the drawer shows its "no report
 * yet" fallback. Best-effort + truthful: only fields the agent actually
 * reported are populated; the numeric runs/latency/scores the structured
 * report doesn't carry are left undefined (the UI guards them).
 */
export function mapMissionReport(run: Record<string, unknown>): CardMissionReport | undefined {
  const report = testbedMissionStructuredReport(run as unknown as TestbedMissionRun);
  if (!report) return undefined;
  const source = reportSource(run);

  const [verdict, verdictTone]: [CardMissionReport["verdict"], CardMissionReport["verdictTone"]] =
    report.verdict === "pass"
      ? ["OK", "ok"]
      : report.verdict === "partial"
        ? ["PARTIAL", "warn"]
        : ["FAILED", "fail"];

  const path: CardMissionStep[] = report.completedPath.map((desc, i) => {
    const lat = missionStepLatency(source, i);
    return {
      n: i + 1,
      status: missionStepStatus(source, i),
      desc: missionStepDesc(source, i, desc),
      ...(lat ? { lat } : {}),
    };
  });
  const blockers: CardMissionBlocker[] = [
    ...report.blockers.map((head, index) => {
      const body = missionBlockerBody(source, "blockers", index);
      return { head: missionBlockerHead(source, "blockers", index, head), ...(body ? { body } : {}) };
    }),
    ...report.confusingMoments.map((head, index) => {
      const body = missionBlockerBody(source, "confusingMoments", index);
      return { head: missionBlockerHead(source, "confusingMoments", index, head), ...(body ? { body } : {}) };
    }),
  ];
  const notes = report.mutationBoundaryNotes.join(" ").trim();
  const boundaryBase = report.stoppedBeforeMutation
    ? "Read-only mission — the agent stopped before any mutation."
    : "The agent crossed or attempted a mutation boundary.";

  const successScore = pickScore(report.scores, ["success", "usability", "task", "completion"]);
  const clarityScore = pickScore(report.scores, ["clarity", "ux", "understanding", "comprehension"]);
  const latencyScore = pickScore(report.scores, ["latency", "speed", "performance", "responsiveness"]);
  const runs = missionRuns(source);
  const latency = missionLatency(source);

  // The agent's "what I tried" trace is serialized into evidence as a
  // `what_i_tried: <lines>` entry. Lift it out so it renders as a readable
  // narrative instead of a buried trace row, and drop it from the evidence list.
  const narrativeEntry = report.evidence.find((e) => MISSION_NARRATIVE_RE.test(e.trim()));
  const narrative = narrativeEntry
    ? narrativeEntry.trim().replace(MISSION_NARRATIVE_RE, "").trim()
    : undefined;
  const evidenceForUi = report.evidence.filter((e) => !MISSION_NARRATIVE_RE.test(e.trim()));
  const goal = asString(run.goal);
  const conclusion = missionConclusion(report, source);
  const scores = missionScoreList(report.scores);

  return {
    verdict,
    verdictTone,
    confidence: report.confidence,
    target: asString(run.targetUrl) ?? "",
    ...(goal ? { goal } : {}),
    ...(narrative ? { narrative } : {}),
    ...(conclusion ? { conclusion } : {}),
    ...(scores.length > 0 ? { scores } : {}),
    seed: run.freshMemory === false ? "warm memory" : "fresh · no memory",
    path,
    blockers,
    evidence: evidenceForUi.map(mapMissionEvidence),
    mutationBoundary: notes ? `${boundaryBase} ${notes}` : boundaryBase,
    recommendations: report.recommendations,
    ...(runs !== undefined ? { runs } : {}),
    ...(latency ? { latency } : {}),
    ...(successScore !== undefined ? { successScore } : {}),
    ...(clarityScore !== undefined ? { clarityScore } : {}),
    ...(latencyScore !== undefined ? { latencyScore } : {}),
  };
}

/** Index Codex tasks by their PR key for task-card enrichment. */
export function indexCodexTasks(rawSnapshot: unknown): Map<string, Record<string, unknown>> {
  const root = asRecord(rawSnapshot);
  const codexTasks = asRecord(root?.codexTasks);
  const map = new Map<string, Record<string, unknown>>();
  for (const entry of asArray(codexTasks?.items)) {
    const task = asRecord(entry);
    const key = prKey(asString(task?.repo), asFiniteNumber(task?.pullRequestNumber));
    if (key && !map.has(key)) map.set(key, task!);
  }
  return map;
}

function readRunner(rawSnapshot: unknown): Record<string, unknown> | undefined {
  return asRecord(asRecord(asRecord(rawSnapshot)?.codexTasks)?.runner);
}

export interface EnrichmentContext {
  /** The raw monitor item `summary` correlated to this card, if any. */
  summary?: Record<string, unknown>;
  /** The Codex task correlated to this card, if any. */
  codexTask?: Record<string, unknown>;
  /** The Codex runner heartbeat (global), if any. */
  runner?: Record<string, unknown>;
  /** The testbed mission run correlated to a mission card, if any. */
  missionRun?: Record<string, unknown>;
}

/**
 * Enrich a slim BoardCard with the rich detail already present in the
 * raw monitor snapshot. Mutates and returns the card. Honest by
 * construction: every field is omitted when its real source is absent.
 */
export function enrichBoardCard(
  card: BoardCard,
  item: HermesBoardCardSnapshot,
  ctx: EnrichmentContext
): BoardCard {
  const { summary } = ctx;
  const isDone = card.type === "done";
  const sourceFailure = sourceFailureFromSummary(summary, card.type);
  if (sourceFailure && !isDone) {
    card.state = "failed-fetch";
    card.sourceFailure = sourceFailure;
  }

  // Checks + files + per-check breakdown + risk findings: live (non-done)
  // cards only. Done cards render in the compressed historical layout (no
  // checks bar / file list), matching the design.
  if (summary && !isDone) {
    const checks = mapChecks(summary);
    if (checks) card.checks = checks;
    const files = mapFiles(summary);
    if (files.length > 0) card.files = files;
    const checkRuns = mapCheckRuns(summary);
    if (checkRuns.length > 0) card.checkRuns = checkRuns;
    const riskSignals = mapRiskSignals(summary);
    if (riskSignals.length > 0) card.riskSignals = riskSignals;
  }

  // Done cards: merge verdict + close timestamp from the PR state.
  if (isDone && summary) {
    const pr = asRecord(summary.currentPullRequest) ?? asRecord(summary.pullRequest);
    if (pr) {
      if (typeof pr.merged === "boolean") {
        card.mergeStatus = pr.merged ? "MERGED" : "CLOSED";
      }
      const updatedAt = asString(pr.updatedAt);
      if (updatedAt) card.closedAt = updatedAt;
    }
    const verdictText = card.verdict ?? item.verdict;
    if (verdictText) card.verdictText = verdictText;
  }

  // Mission cards: project the browser agent's structured report. Omitted
  // when the run has no report yet (the drawer shows its "no report" state).
  if (card.type === "mission" && ctx.missionRun) {
    const status = asString(ctx.missionRun.status);
    if (status) card.missionStatus = status as MissionStatus;
    const mission = mapMissionReport(ctx.missionRun);
    if (mission) {
      card.mission = mission;
      const oneLine = missionReportOneLine(ctx.missionRun);
      if (oneLine) card.summary = oneLine;
    }
    // While running, surface the live poll snapshot (stage + recent output) so
    // the drawer can follow the run. Real progress only — no verdict here.
    if (status === "running") {
      const progress = missionRunProgress(ctx.missionRun);
      if (progress) card.missionProgress = progress;
    }
    const workingNow = workingNowFromMissionRun(ctx.missionRun);
    if (workingNow) card.workingNow = workingNow;
  }

  const taskWorkingNow = ctx.codexTask ? workingNowFromRunningTask(ctx.codexTask, ctx.runner) : undefined;
  if (taskWorkingNow && isWatchLane(card.lane)) {
    card.workingNow = taskWorkingNow;
  }

  // Codex task cards: prompt / output / failure / runner liveness.
  if (card.type === "task" && ctx.codexTask) {
    const task = ctx.codexTask;
    const status = asString(task.status);
    if (status) card.taskStatus = status as TaskStatus;
    const prompt = asString(task.prompt);
    if (prompt) card.prompt = prompt;
    const output = asString(task.stdoutTail) ?? asString(task.completionSummary);
    if (output) card.output = output;
    const failureReason = asString(task.failureReason);
    if (failureReason) card.failureReason = failureReason;
    const taskEvents = mapTaskEvents(task);
    if (taskEvents.length > 0) card.taskEvents = taskEvents;
    if (isHermesDecisionRecord(task.decisionRecord)) {
      card.decisionRecord = task.decisionRecord;
    }
    const runner = ctx.runner;
    if (runner) {
      const lastSeen = asString(runner.updatedAt);
      const status = asString(runner.status);
      if (lastSeen) {
        card.runnerHeartbeat = {
          lastSeen,
          online: status === "running" || status === "idle",
        };
      }
    }
    const runnerFailure = (status === "approved" || status === "running")
      ? runnerSourceFailure(ctx.runner)
      : undefined;
    if (runnerFailure) {
      card.state = "source-offline";
      card.sourceFailure = runnerFailure;
    }
  }

  if (!card.workingNow) {
    const classifierWorkingNow = workingNowFromClassifier(card, item);
    if (classifierWorkingNow) card.workingNow = classifierWorkingNow;
  }

  return card;
}

/**
 * Build the full v2 board snapshot from the raw monitor snapshot.
 * Reuses the existing classifier, then enriches every card with the
 * rich detail the raw snapshot already carries (zero new network calls).
 *
 * @param rawSnapshot the object returned by loadMonitorSnapshot()
 * @param opts.repo   the configured AVERRAY_REPO (single-repo per §21.6)
 * @param opts.now    clock injection for tests
 */
const SYNTH_TERMINAL_TASK_STATUSES = new Set(["completed", "cancelled"]);
const APPROVED_STALE_MINUTES = 30;
const RUNNING_STALE_MINUTES = 20;
const REPEATED_FAILURE_ATTEMPTS = 2;
const AUTOMATION_TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
const CARD_DISCUSSION_LIMIT = 4;

/** Pull the first PR number a task's prose (or explicit field) cites. Honors
 *  `#123` and `PR 123` / `PR#123` forms; prompt is checked before reason. */
export function citedPrNumber(task: Record<string, unknown>): number | undefined {
  const explicit = asFiniteNumber(task.pullRequestNumber);
  if (explicit !== undefined) return explicit;
  for (const field of [asString(task.prompt), asString(task.reason)]) {
    if (!field) continue;
    const match = field.match(/(?:PR\s*#?|#)(\d{1,7})\b/i);
    if (match) {
      const n = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return undefined;
}

// A task asserts the PR is BLOCKED/gated. Kept deliberately tight — generic
// mentions of "gate" in unrelated prose shouldn't trip it, but the phrasings
// Hermes's router actually uses ("blocked PR", "blocks the merge", "cannot
// merge", "merge-blocking", "gating") do.
const CLAIMS_BLOCKED = /\b(blocked|block(?:s|ing)?\s+the\s+merge|blocks?\s+merge|cannot\s+merge|can't\s+merge|un-?mergeable|not\s+mergeable|merge[-\s]?block\w*|gat(?:e|es|ing|ed))\b/i;
// Real PR states that mean "nothing is blocking the merge".
const MERGEABLE_STATES = new Set(["mergeable", "clean", "has_hooks", "unstable"]);

/**
 * Reconcile a proposed task's free-text claim against the REAL PR summary it
 * cites. Pure + side-effect-free so it unit-tests without the whole board.
 *
 * TRUTH BOUNDARY:
 *  - No summary, or a fail-stale summary (githubLive.fetchError) ⇒
 *    `groundTruth.verified:false` carrying ONLY the honest reason, and NEVER a
 *    claimFlag (we can't contradict a claim we couldn't verify).
 *  - Otherwise `groundTruth.verified:true` carries the PR's actual signals, and
 *    claimFlags are computed CONSERVATIVELY (high-risk, unambiguous only).
 *  - The caller passes `undefined` when the task cites no PR, in which case this
 *    isn't called at all and the card carries no panel.
 */
export function reconcileTaskClaim(
  task: Record<string, unknown>,
  summary: Record<string, unknown> | undefined,
  prNumber: number,
): { groundTruth: CardGroundTruth; claimFlags?: CardClaimFlag[] } {
  const repo = asString(task.repo) ?? "";
  const githubLive = asRecord(summary?.githubLive);
  // Missing from the fetched set, or a rate-limited sub-fetch ⇒ unverifiable.
  if (!summary || githubLive?.fetchError) {
    return {
      groundTruth: {
        pr: prNumber,
        repo,
        verified: false,
        reason: "PR state unavailable — not among the fetched open PRs, rate-limited, or already closed. Judge Hermes's claim yourself.",
      },
    };
  }

  const pr = asRecord(summary.currentPullRequest) ?? asRecord(summary.pullRequest);
  const totals = asRecord(githubLive?.checkTotals);
  const checks = totals
    ? {
        passed: numberFieldV2(totals.passed),
        failed: numberFieldV2(totals.failed),
        total: numberFieldV2(totals.total),
      }
    : undefined;
  const reviewSignals = asRecord(summary.reviewSignals);
  const touchedAreas = asArray(reviewSignals?.touchedAreas)
    .map((value) => asString(value))
    .filter((value): value is string => Boolean(value));
  const mergeableState = asString(pr?.mergeableState);
  const verdict = asString(summary.finalVerdict);

  const groundTruth: CardGroundTruth = {
    pr: prNumber,
    repo,
    verified: true,
    ...(mergeableState ? { mergeableState } : {}),
    ...(asString(pr?.state) ? { state: asString(pr?.state) } : {}),
    ...(typeof pr?.draft === "boolean" ? { draft: pr.draft } : {}),
    ...(typeof pr?.merged === "boolean" ? { merged: pr.merged } : {}),
    ...(checks ? { checks } : {}),
    ...(touchedAreas.length > 0 ? { touchedAreas } : {}),
    ...(verdict ? { verdict } : {}),
  };

  const claimText = [asString(task.prompt), asString(task.reason)].filter(Boolean).join(" ");
  const flags: CardClaimFlag[] = [];

  // (1) Claimed blocked, but the PR is actually mergeable with no failing checks
  // and not held. Every clause must agree before we contradict the operator's
  // task — a mergeable state we can't read (undefined) is NOT treated as green.
  const noFailedChecks = !checks || checks.failed === 0;
  const stateIsMergeable = mergeableState ? MERGEABLE_STATES.has(mergeableState.toLowerCase()) : false;
  const notHeld = verdict !== "hold";
  const notDraft = pr?.draft !== true;
  const notMerged = pr?.merged !== true;
  if (CLAIMS_BLOCKED.test(claimText) && stateIsMergeable && noFailedChecks && notHeld && notDraft && notMerged) {
    const failedNote = checks ? `${checks.failed} failed checks` : "no failing checks";
    flags.push({
      kind: "claimed_blocked_but_mergeable",
      detail: `Task says PR #${prNumber} is blocked, but it is ${mergeableState} with ${failedNote}.`,
    });
  }

  // (2) Claimed a HIGH-RISK category (secrets / migrations / .env) that the real
  // diff does not touch. Only these high-signal absentees are flagged — generic
  // words like "backend" or "docs" are far too noisy to contradict on.
  if (touchedAreas.length > 0) {
    const missing = claimedHighRiskCategoriesAbsent(claimText, touchedAreas);
    if (missing.length > 0) {
      flags.push({
        kind: "claimed_category_absent",
        detail: `Task text mentions ${missing.map((m) => `'${m}'`).join(" + ")}, but PR #${prNumber}'s real diff doesn't touch that — real areas: ${touchedAreas.join(", ")}.`,
      });
    }
  }

  return { groundTruth, ...(flags.length > 0 ? { claimFlags: flags } : {}) };
}

/** Coerce a summary numeric field, defaulting missing/non-finite to 0. */
function numberFieldV2(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Which HIGH-RISK categories a task's prose asserts that the PR's real
 * `touchedAreas` do NOT contain. Deliberately narrow: only `secrets`,
 * `migration(s)`, and `.env` — the categories whose false presence would most
 * mislead a risk decision. A claim of `secrets` is satisfied by a real
 * `secrets` area; a claim of `migration` maps to the `settlement`/`backend`
 * areas the classifier uses, so we only assert absence when NO plausible area
 * is present.
 */
function claimedHighRiskCategoriesAbsent(claimText: string, touchedAreas: string[]): string[] {
  const text = claimText.toLowerCase();
  const areas = new Set(touchedAreas.map((a) => a.toLowerCase()));
  const missing: string[] = [];
  // "secrets" / ".env": the classifier bucket is literally `secrets`.
  if (/\bsecrets?\b/.test(text) && !areas.has("secrets")) missing.push("secrets");
  if (/(?:^|[^.\w])\.env\b/.test(text) && !areas.has("secrets")) missing.push(".env");
  // "migration(s)": the classifier folds DB migrations into the touched-area
  // vocab as high-risk but has no dedicated `migration` bucket, so treat it as
  // absent only when NONE of the areas a migration could live in are present.
  if (/\bmigrations?\b/.test(text) && !MIGRATION_HOST_AREAS.some((a) => areas.has(a))) missing.push("migrations");
  return missing;
}

// Areas a real DB migration would surface under (there's no dedicated bucket).
// If none are present, a "migrations" claim is unsupported by the real diff.
const MIGRATION_HOST_AREAS = ["backend", "indexer", "settlement", "ops"];

/**
 * Synthesize `codex-needed` cards for queued tasks the classifier won't
 * surface on its own. Greenfield tasks (no PR yet) emit no monitor/handoff
 * event, so without this a freshly-proposed task never appears on the board
 * and the operator could never see or approve it — the O3 dispatch loop
 * depends on this. PR-bound tasks are intentionally skipped (they surface via
 * their PR card). Completed/cancelled tasks are dropped; failed/stuck tasks
 * are promoted to needs-attention. Zero new network calls — reads the
 * `codexTasks` already bundled on the snapshot.
 */
export function synthesizeTaskCards(
  rawSnapshot: unknown,
  runner: Record<string, unknown> | undefined,
  opts: { now?: Date; summaryIndex?: Map<string, Record<string, unknown>> } = {},
): BoardCard[] {
  const root = asRecord(rawSnapshot);
  const codexTasks = asRecord(root?.codexTasks);
  const out: BoardCard[] = [];
  const now = opts.now ?? new Date();
  for (const entry of asArray(codexTasks?.items)) {
    const task = asRecord(entry);
    if (!task) continue;
    if (isQuietTaskHealthCapacityTask(task)) continue;
    const status = asString(task.status);
    if (!status || SYNTH_TERMINAL_TASK_STATUSES.has(status)) continue;
    if (asString(task.operatorDismissedAt)) continue;
    const operatorSnoozedUntil = asString(task.operatorSnoozedUntil);
    const operatorSnoozedUntilMs = operatorSnoozedUntil ? Date.parse(operatorSnoozedUntil) : NaN;
    if (Number.isFinite(operatorSnoozedUntilMs) && operatorSnoozedUntilMs > now.getTime()) continue;
    // PR-bound tasks surface (and get their status overlaid) via the PR card.
    if (task.pullRequestNumber !== undefined && task.pullRequestNumber !== null) continue;
    const id = asString(task.id);
    if (!id) continue;
    const agent = agentTypeFromTaskAgent(task.agent);
    const prompt = asString(task.prompt);
    const taskEvents = mapTaskEvents(task);
    const riskTierRaw = asString(task.riskTier);
    const riskTier = riskTierRaw === "high" || riskTierRaw === "low" ? riskTierRaw : undefined;
    const routingReason = asString(task.routingReason);
    const decisionRecord = isHermesDecisionRecord(task.decisionRecord) ? task.decisionRecord : undefined;
    const health = taskHealthForBoard(task, runner, now);
    // O4-PR2: surface the routing decision — the reason (incl. the tier) on the
    // card face, and a riskSignal for the drawer. Persist riskTier (PR3 reads it).
    const summary = [health.summary, routingReason, asString(task.reason)].filter(Boolean).join(" · ");
    const riskSignals = [
      ...(health.riskSignal ? [health.riskSignal] : []),
      ...(routingReason
        ? [{ severity: riskTier === "high" ? "high" as const : "low" as const, code: "routing", message: routingReason }]
        : []),
    ];
    // Ground-truth check: if this greenfield task's prose cites a PR, join the
    // PR's REAL signals from the already-fetched summary index so the operator
    // can catch a fabricated premise. No PR cited ⇒ no panel (honest absence).
    const citedPr = opts.summaryIndex ? citedPrNumber(task) : undefined;
    const reconciled =
      citedPr !== undefined
        ? reconcileTaskClaim(task, opts.summaryIndex!.get(prKey(asString(task.repo), citedPr) ?? ""), citedPr)
        : undefined;
    const card: BoardCard = {
      id,
      lane: health.lane,
      type: "task",
      agentType: agent,
      title: humanizeTaskTitle(asString(task.title) ?? `${agent} task`),
      summary,
      repo: asString(task.repo) ?? "",
      freshness: health.freshness,
      state: health.state,
      risk: health.risk,
      // Proposed → operator must approve; approved/running → with the runner.
      waitingOn: health.waitingOn,
      ...(health.isAction ? { isAction: true } : {}),
      taskStatus: status as TaskStatus,
      ...(riskTier ? { riskTier } : {}),
      ...(riskSignals.length > 0 ? { riskSignals } : {}),
      ...(health.sourceFailure ? { sourceFailure: health.sourceFailure } : {}),
      ...(prompt ? { prompt } : {}),
      ...(taskEvents.length > 0 ? { taskEvents } : {}),
      ...(reconciled ? { groundTruth: reconciled.groundTruth } : {}),
      ...(reconciled?.claimFlags ? { claimFlags: reconciled.claimFlags } : {}),
      ...(asString(task.correlationId) ? { correlationId: asString(task.correlationId) } : {}),
      ...(decisionRecord ? { decisionRecord } : {}),
    };
    if (status === "running" && runner) {
      const lastSeen = asString(runner.updatedAt);
      const rStatus = asString(runner.status);
      if (lastSeen) {
        card.runnerHeartbeat = { lastSeen, online: rStatus === "running" || rStatus === "idle" };
      }
    }
    const workingNow = workingNowFromRunningTask(task, runner);
    if (workingNow) card.workingNow = workingNow;
    out.push(card);
  }
  return out;
}

function agentTypeFromTaskAgent(value: unknown): AgentType {
  if (value === "claude") return "claude";
  if (value === "test-writer") return "test-writer";
  if (value === "security") return "security";
  if (value === "docs") return "docs";
  if (value === "hermes") return "hermes";
  if (value === "ext") return "ext";
  return "codex";
}

interface TaskHealthForBoard {
  lane: Lane;
  state: CardState;
  waitingOn: WaitingOn;
  risk: RiskTag[];
  freshness: number;
  summary?: string;
  riskSignal?: CardRiskSignal;
  sourceFailure?: CardSourceFailure;
  isAction?: boolean;
}

export function taskHealthForBoard(
  task: Record<string, unknown>,
  runner: Record<string, unknown> | undefined,
  now: Date = new Date(),
): TaskHealthForBoard {
  const status = asString(task.status);
  const attemptCount = Math.max(0, Math.floor(asFiniteNumber(task.attemptCount) ?? 0));
  const failureReason = asString(task.failureReason);
  const runnerState = runnerHealthForTask(task, runner, now);

  if (status === "failed") {
    const retryAfter = asString(task.retryAfter);
    const retryAfterMs = retryAfter ? Date.parse(retryAfter) : NaN;
    if (!asString(task.selfManagementEscalatedAt) && Number.isFinite(retryAfterMs) && retryAfterMs > now.getTime()) {
      const waitMinutes = Math.max(1, Math.ceil((retryAfterMs - now.getTime()) / 60_000));
      return {
        lane: "codex-needed",
        state: "stale",
        waitingOn: { actor: "agent", tone: "info" },
        risk: [],
        freshness: minutesSince(asString(task.failedAt) ?? asString(task.updatedAt), now),
        summary: `Task failed; O5 has scheduled a bounded retry in ${waitMinutes}m.`,
      };
    }
    const repeated = attemptCount >= REPEATED_FAILURE_ATTEMPTS;
    const attemptsLabel = `${attemptCount} runner attempt${attemptCount === 1 ? "" : "s"}`;
    return attentionHealth({
      state: "stale",
      freshness: minutesSince(asString(task.failedAt) ?? asString(task.updatedAt), now),
      summary: repeated
        ? `Task failed after ${attemptsLabel}.`
        : "Task failed in the runner.",
      riskSignal: {
        severity: repeated ? "high" : "medium",
        code: repeated ? "task_failed_repeatedly" : "task_failed",
        message: [
          repeated
            ? `The task failed after ${attemptsLabel}; operator should decide whether to split, retry, or cancel.`
            : "The task failed and needs operator triage before it disappears from the queue.",
          failureReason,
        ].filter(Boolean).join(" "),
      },
    });
  }

  if (status === "approved") {
    const ageMinutes = minutesSince(asString(task.approvedAt) ?? asString(task.updatedAt), now);
    if (ageMinutes >= APPROVED_STALE_MINUTES || runnerState.unavailable) {
      return attentionHealth({
        state: runnerState.sourceFailure ? "source-offline" : "stale",
        freshness: ageMinutes,
        summary: runnerState.unavailable
          ? `Approved task is waiting but the ${runnerState.label}.`
          : `Approved task has waited ${ageMinutes}m for a runner claim.`,
        riskSignal: {
          severity: runnerState.unavailable ? "high" : "medium",
          code: runnerState.unavailable ? "runner_unavailable_for_approved_task" : "approved_task_stale",
          message: runnerState.unavailable
            ? `The task is approved, but the ${runnerState.label}; no runner can safely claim it.`
            : `The task has been approved for ${ageMinutes}m without being claimed.`,
        },
        sourceFailure: runnerState.sourceFailure,
      });
    }
  }

  if (status === "running") {
    const ageMinutes = minutesSince(
      asString(task.progressAt) ?? asString(task.startedAt) ?? asString(task.updatedAt),
      now,
    );
    const activeElsewhere = runnerState.activeTaskMismatch;
    if (ageMinutes >= RUNNING_STALE_MINUTES || runnerState.unavailable || activeElsewhere) {
      return attentionHealth({
        state: runnerState.sourceFailure ? "source-offline" : "stale",
        freshness: ageMinutes,
        summary: runnerState.unavailable
          ? `Running task may be stuck because the ${runnerState.label}.`
          : activeElsewhere
            ? "Running task no longer matches the runner heartbeat."
            : `Running task has had no progress for ${ageMinutes}m.`,
        riskSignal: {
          severity: runnerState.unavailable || activeElsewhere ? "high" : "medium",
          code: runnerState.unavailable
            ? "runner_unavailable_for_running_task"
            : activeElsewhere
              ? "runner_active_task_mismatch"
              : "running_task_stale",
          message: runnerState.unavailable
            ? `The task is still marked running, but the ${runnerState.label}.`
            : activeElsewhere
              ? "The task is marked running, but the runner heartbeat points at another task."
              : `The task is running with no recorded progress for ${ageMinutes}m.`,
        },
        sourceFailure: runnerState.sourceFailure,
      });
    }
  }

  return {
    lane: "codex-needed",
    state: status === "running" ? "running" : "fresh",
    waitingOn: status === "proposed"
      ? { actor: "operator", tone: "warn" }
      : { actor: "agent", tone: "info" },
    risk: [],
    freshness: minutesSince(asString(task.updatedAt) ?? asString(task.createdAt), now),
  };
}

function attentionHealth(input: {
  state: CardState;
  freshness: number;
  summary: string;
  riskSignal: CardRiskSignal;
  sourceFailure?: CardSourceFailure;
}): TaskHealthForBoard {
  return {
    lane: "needs-attention",
    state: input.state,
    waitingOn: { actor: "operator", tone: "warn" },
    risk: ["workflow"],
    freshness: input.freshness,
    summary: input.summary,
    riskSignal: input.riskSignal,
    ...(input.sourceFailure ? { sourceFailure: input.sourceFailure } : {}),
    isAction: true,
  };
}

function runnerHealthForTask(
  task: Record<string, unknown>,
  runner: Record<string, unknown> | undefined,
  now: Date,
): { unavailable: boolean; activeTaskMismatch: boolean; label: string; sourceFailure?: CardSourceFailure } {
  const sourceFailure = runnerSourceFailure(runner, now);
  if (!runner) return { unavailable: true, activeTaskMismatch: false, label: "runner heartbeat is missing", sourceFailure };
  const status = asString(runner.status);
  const runnerStale = runner.stale === true || minutesSince(asString(runner.updatedAt), now) > 2;
  const unavailable = runnerStale || status === "disabled" || status === "misconfigured" || status === "error" || status === "failed";
  const taskId = asString(task.id);
  const activeTaskId = asString(runner.activeTaskId);
  return {
    unavailable,
    activeTaskMismatch: Boolean(taskId && activeTaskId && taskId !== activeTaskId),
    label: unavailable
      ? runnerStale
        ? "runner heartbeat is stale"
        : `runner is ${status ?? "unavailable"}`
      : "runner is available",
    ...(sourceFailure ? { sourceFailure } : {}),
  };
}

function minutesSince(value: string | undefined, now: Date): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((now.getTime() - ms) / 60_000));
}

// ── Failure-analysis card selection + projection ─────────────────────
// The SINGLE definition of "which cards get a Hermes failure analysis": an
// operator-decision card (isAction, or in an operator-review / needs-attention
// lane) that represents a FAILURE. Reused by the board threading here and by the
// failure-analysis routine, so the two never diverge.

// A failure keyword in the verdict, but ONLY when it is NOT negated. The
// negation guard is load-bearing for the truth-boundary: a passing verdict like
// "Hermes pre-check passed, no errors" or "previously failing, now green" must
// NOT be read as a failure (which would invite a fabricated "why it failed").
// The structured signals below (state/taskStatus/checkRuns/...) are the primary,
// reliable failure evidence; the verdict keyword is a last-resort fallback.
const FAILURE_VERDICT = /\b(fail(?:ed|ing|ure)?|blocked|errored|broke|broken|regress(?:ed|ion)?)\b/i;
// A recovery / negation cue anywhere in the verdict (either order) flips a
// failure keyword to non-failure: "no errors", "error resolved", "previously
// failing, now green", "all checks passed". The list is intentionally broad —
// a false negative (skip a real failure) just leaves the drawer as today, while
// a false positive would fabricate a "why it failed" on a passing card.
const RECOVERY_CUE = /\b(no|not|zero|without|resolved|fixed|cleared|passed|passing|green|recovered|now|healthy|succeeded|success)\b/i;

function verdictSignalsFailure(verdict: string): boolean {
  const trimmed = verdict.trim();
  if (!trimmed) return false;
  if (!FAILURE_VERDICT.test(trimmed)) return false;
  if (RECOVERY_CUE.test(trimmed)) return false; // negated / recovered — not a live failure
  return true;
}

/** True when the card is an operator-decision card sitting in a decision lane. */
function isDecisionCard(card: BoardCard): boolean {
  return Boolean(card.isAction) || card.lane === "operator-review" || card.lane === "needs-attention";
}

/**
 * True when the card carries a real failure signal (never a guess). Prefers the
 * structured signals (degraded fetch, failed task/mission, failed checks); the
 * free-text verdict is only a negation-guarded fallback.
 */
function hasFailureSignal(card: BoardCard): boolean {
  if (card.state === "failed-fetch") return true;
  if (card.taskStatus === "failed") return true;
  if (card.missionStatus === "failed") return true;
  if ((card.failureReason ?? "").trim()) return true;
  if (card.sourceFailure && card.sourceFailure.message.trim()) return true;
  if ((card.checkRuns ?? []).some((run) => run.status === "fail")) return true;
  if ((card.checks?.fail ?? 0) > 0) return true;
  if (verdictSignalsFailure(card.verdict ?? "")) return true;
  return false;
}

/**
 * Project a board card to the grounded failure fields the analysis may read, or
 * undefined when the card is NOT a failure decision card (so it is skipped).
 * Done / history cards are always skipped. Every field is copied straight from
 * the real card — no derivation, no fabrication.
 */
export function failureAnalysisCardFor(card: BoardCard): FailureAnalysisCard | undefined {
  if (card.type === "done") return undefined;
  if (!isDecisionCard(card) || !hasFailureSignal(card)) return undefined;
  const failedCheckNames = (card.checkRuns ?? [])
    .filter((run) => run.status === "fail")
    .map((run) => run.name);
  const riskSignals = (card.riskSignals ?? []).map((s) => s.message);
  return {
    id: card.id,
    title: card.title,
    ...(card.repo ? { repo: card.repo } : {}),
    ...(card.verdict ? { verdict: card.verdict } : {}),
    ...(card.failureReason ? { failureReason: card.failureReason } : {}),
    ...(card.sourceFailure
      ? {
          sourceFailure: {
            source: card.sourceFailure.source,
            ...(card.sourceFailure.code ? { code: card.sourceFailure.code } : {}),
            message: card.sourceFailure.message,
          },
        }
      : {}),
    ...(failedCheckNames.length > 0 ? { failedCheckNames } : {}),
    ...(card.state ? { state: card.state } : {}),
    ...(riskSignals.length > 0 ? { riskSignals } : {}),
    failureKind: failureKindFor(card),
  };
}

/** A short, honest label for the kind of failure (derived from the card type). */
function failureKindFor(card: BoardCard): string {
  switch (card.type) {
    case "deploy":
      return "deploy verification";
    case "mission":
      return "browser mission";
    case "task":
      return "codex task";
    case "pr":
      return "pull request";
    default:
      return "board card";
  }
}

export function buildV2BoardSnapshot(
  rawSnapshot: unknown,
  opts: {
    repo?: string;
    now?: () => Date;
    /**
     * Optional reader for a FRESH cached Hermes failure analysis, keyed by card
     * id + a failure-context hash. Threaded onto failure decision cards only.
     * When omitted (the default), or when it returns undefined, cards carry no
     * analysis and the drawer keeps its existing "Ask Hermes" pointer — so the
     * feature is byte-for-byte a no-op unless the caller opts in.
     */
    getAnalysis?: (cardId: string, failureHash: string) => { text: string; model?: string; at: string } | undefined;
  } = {}
): BoardSnapshotV2 {
  const now = opts.now ?? (() => new Date());
  const snapshotAt = now();
  const classified: HermesBoardSnapshot | undefined =
    buildHermesBoardSnapshotFromMonitor(rawSnapshot);
  const items = classified?.items ?? [];
  const summaryIndex = indexRawSummaries(rawSnapshot);
  const codexIndex = indexCodexTasks(rawSnapshot);
  const missionIndex = indexTestbedMissions(rawSnapshot);
  const reviewRequests = reviewRequestsFromSnapshot(rawSnapshot);
  const discussionMessages = discussionMessagesFromSnapshot(rawSnapshot);
  const runner = readRunner(rawSnapshot);
  const quietSelfHealingCapacitySignals = countValue(classified?.counts?.selfHealingCapacitySignals);
  const quietTaskHealthCapacitySignals = countQuietTaskHealthCapacitySignals(rawSnapshot);
  const sourceCards = items.map((item) => {
    const base = toBoardCard(item);
    const key = prKey(item.repo, item.number);
    const enriched = enrichBoardCard(base, item, {
      summary: key ? summaryIndex.get(key) : undefined,
      codexTask: key ? codexIndex.get(key) : undefined,
      runner,
      missionRun:
        base.type === "mission" && item.correlationId
          ? missionIndex.get(item.correlationId)
          : undefined,
    });
    const withReviews = attachReviewRequests(enriched, reviewRequests, {
      ...(key ? { relatedPrKey: key } : {}),
      ...(base.type === "mission" && item.correlationId ? { relatedMissionId: item.correlationId } : {}),
      ...(item.correlationId ? { correlationId: item.correlationId } : {}),
    });
    return attachDiscussion(withReviews, discussionMessages, {
      ...(key ? { relatedPrKey: key } : {}),
      ...(item.correlationId ? { correlationId: item.correlationId } : {}),
    });
  });
  // Surface queued greenfield tasks the classifier can't (no PR ⇒ no event),
  // skipping any already represented (e.g. by a PR card). When the same
  // self-healing event also produced a task, keep the task card because it
  // owns the real approve/dispatch control; the handoff event is context.
  const existingIds = new Set(sourceCards.map((c) => c.id));
  const taskCards = synthesizeTaskCards(rawSnapshot, runner, { now: snapshotAt, summaryIndex })
    .filter((c) => !existingIds.has(c.id))
    .map((card) => {
      const scope = { correlationId: card.correlationId ?? card.id };
      return attachDiscussion(
        attachReviewRequests(card, reviewRequests, scope),
        discussionMessages,
        scope,
      );
    });
  const actionableTaskCorrelationIds = new Set(
    taskCards.map((card) => card.correlationId).filter((value): value is string => Boolean(value)),
  );
  const cards = sourceCards.filter((card) => {
    if (card.type === "task") return true;
    const correlationIds = sourceCardCorrelationIdsForDedupe(card, missionIndex);
    if (correlationIds.length === 0) return true;
    return !correlationIds.some((id) => actionableTaskCorrelationIds.has(id));
  });

  // Thread a FRESH cached Hermes failure analysis onto each failure decision
  // card. No-op unless the caller supplied getAnalysis AND the cache is fresh for
  // the card's CURRENT failure context (hash match) — a stale analysis for a
  // changed failure is never surfaced.
  const allCards = [...cards, ...taskCards];
  if (opts.getAnalysis) {
    for (const card of allCards) {
      const projected = failureAnalysisCardFor(card);
      if (!projected) continue;
      const analysis = opts.getAnalysis(card.id, hashFailureContext(projected));
      if (analysis && analysis.text.trim()) card.hermesAnalysis = analysis;
    }
  }

  return {
    cards: allCards,
    at: snapshotAt.toISOString(),
    repo: opts.repo ?? "",
    llmUsage: aggregateLlmUsage(usageEvents(asRecord(rawSnapshot)?.llmUsageEvents), {
      activeCalls: listActiveLlmUsageCalls(),
      // Anchor the live "tokens/min" window to the snapshot time.
      now: snapshotAt,
      // Ollama Cloud flat-plan cost + subscription-burn windows (env: OLLAMA_PLAN).
      subscription: resolveOllamaPlan(process.env),
    }),
    testbedSuites: testbedSuitesFromSnapshot(rawSnapshot),
    automationHealth: automationHealthForBoard(rawSnapshot, snapshotAt, process.env, {
      selfHealingCapacitySignals: quietSelfHealingCapacitySignals,
      taskHealthCapacitySignals: quietTaskHealthCapacitySignals,
    }),
  };
}

function testbedSuitesFromSnapshot(rawSnapshot: unknown): TestbedSuite[] {
  const root = asRecord(rawSnapshot);
  return asArray(root?.testbedSuites)
    .flatMap((entry) => {
      const suite = asRecord(entry);
      if (
        suite
        && suite.schemaVersion === 1
        && suite.kind === "testbed_suite"
        && typeof suite.id === "string"
        && typeof suite.name === "string"
        && typeof suite.target === "string"
        && (suite.status === undefined || suite.status === "requested" || suite.status === "saved")
        && (suite.mode === "surface_sweep" || suite.mode === "siwe_auth" || suite.mode === "gold_path")
        && Array.isArray(suite.history)
      ) {
        return [suite as unknown as TestbedSuite];
      }
      return [];
    });
}

/**
 * Compare two real board snapshots and emit the card-level events the v2 SSE
 * stream can send before the reconciliation snapshot. These are not synthetic
 * animations: every event is derived from two consecutive source snapshots.
 */
export function diffBoardSnapshots(
  previous: BoardSnapshotV2 | undefined,
  next: BoardSnapshotV2,
): BoardCardStreamEvent[] {
  if (!previous) return [];
  const at = next.at;
  const previousById = new Map(previous.cards.map((card) => [card.id, card]));
  const nextById = new Map(next.cards.map((card) => [card.id, card]));
  const events: BoardCardStreamEvent[] = [];

  for (const card of previous.cards) {
    if (!nextById.has(card.id)) {
      events.push({ type: "board.card.archived", id: card.id, fromLane: card.lane, at });
    }
  }

  for (const card of next.cards) {
    const before = previousById.get(card.id);
    if (!before) {
      events.push({ type: "board.card.added", card, at });
      continue;
    }
    if (before.lane !== card.lane) {
      events.push({
        type: "board.card.moved",
        id: card.id,
        fromLane: before.lane,
        toLane: card.lane,
        card,
        at,
      });
      continue;
    }
    if (!sameBoardCard(before, card)) {
      events.push({ type: "board.card.updated", id: card.id, partial: card, card, at });
    }
  }

  return events;
}

function sameBoardCard(a: BoardCard, b: BoardCard): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function countQuietTaskHealthCapacitySignals(rawSnapshot: unknown): number {
  const root = asRecord(rawSnapshot);
  const codexTasks = asRecord(root?.codexTasks);
  return asArray(codexTasks?.items)
    .map((entry) => asRecord(entry))
    .filter((task): task is Record<string, unknown> => Boolean(task))
    .filter(isQuietTaskHealthCapacityTask)
    .length;
}

function isQuietTaskHealthCapacityTask(task: Record<string, unknown>): boolean {
  if (!asString(task.selfManagementEscalatedAt)) return false;
  return isQuietAutomationCapacityReason([
    asString(task.selfManagementEscalationReason),
    asString(task.progressMessage),
    asString(task.failureReason),
    asString(task.reason),
  ].filter(Boolean).join(" "));
}

interface AutomationCapacitySignalCounts {
  selfHealingCapacitySignals?: number;
  taskHealthCapacitySignals?: number;
}

export function automationHealthForBoard(
  rawSnapshot: unknown,
  now: Date = new Date(),
  env: {
    HERMES_DISPATCH_PER_DAY_MAX?: string | undefined;
    O5_TASK_HEALTH_RESTART_RECOVERY_MINUTES?: string | undefined;
  } = process.env,
  capacitySignals: AutomationCapacitySignalCounts = {},
): AutomationHealth {
  const selfHealingCapacitySignals = Math.max(0, Math.floor(capacitySignals.selfHealingCapacitySignals ?? 0));
  const taskHealthCapacitySignals = Math.max(0, Math.floor(capacitySignals.taskHealthCapacitySignals ?? 0));
  const quietSignalCount = selfHealingCapacitySignals + taskHealthCapacitySignals;
  const root = asRecord(rawSnapshot);
  const codexTasks = asRecord(root?.codexTasks);
  const sourceAvailable = Array.isArray(codexTasks?.items);
  const tasks = asArray(codexTasks?.items)
    .map(asRecord)
    .filter((task): task is Record<string, unknown> => Boolean(task));
  const today = now.toISOString().slice(0, 10);
  const selfHealingOpen = sourceAvailable ? tasks.filter((task) =>
    asString(task.requester) === "hermes-self-healing"
    && !AUTOMATION_TERMINAL_TASK_STATUSES.has(asString(task.status) ?? "")
  ).length : null;
  const dispatchUsedToday = sourceAvailable ? tasks.filter((task) =>
    isAutomationDispatchTask(task)
    && asString(task.createdAt)?.slice(0, 10) === today
  ).length : null;
  return {
    sourceStatus: sourceAvailable ? "ok" : "degraded",
    selfHealingOpen,
    dispatchUsedToday,
    dispatchPerDayCap: dispatchPerDayCap(env),
    quietSignalCount,
    selfHealingCapacitySignals,
    taskHealthCapacitySignals,
    taskHealth: summarizeTaskHealth(tasks as unknown as CodexTask[], {
      config: { restartRecoveryMs: taskHealthRestartRecoveryMs(env) },
      now,
      runner: sourceAvailable ? runnerFromSummary(codexTasks?.runner) : undefined,
      sourceAvailable,
    }),
    routing: routingDiagnosticsForBoard(tasks, rawSnapshot, now, sourceAvailable),
    guardrails: {
      dispatchPolicy: "enforced",
      haltInterlock: "enforced",
      anomalyPause: "enforced",
      authority: "human_merge_gate",
    },
  };
}

function runnerFromSummary(value: unknown): CodexRunnerHeartbeat | undefined {
  const runner = asRecord(value);
  if (!runner) return undefined;
  const runnerId = asString(runner.runnerId);
  const status = asString(runner.status);
  const message = asString(runner.message);
  const updatedAt = asString(runner.updatedAt);
  if (!runnerId || !status || !message || !updatedAt) return undefined;
  return {
    schemaVersion: 1,
    kind: "codex_runner_heartbeat",
    runnerId,
    status: status as CodexRunnerHeartbeat["status"],
    message,
    updatedAt,
    ...(asString(runner.activeTaskId) ? { activeTaskId: asString(runner.activeTaskId) } : {}),
  };
}

function taskHealthRestartRecoveryMs(env: { O5_TASK_HEALTH_RESTART_RECOVERY_MINUTES?: string | undefined }): number {
  const parsed = Number.parseInt(env.O5_TASK_HEALTH_RESTART_RECOVERY_MINUTES ?? "", 10);
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
  return Math.max(60_000, minutes * 60_000);
}

function routingDiagnosticsForBoard(
  tasks: Record<string, unknown>[],
  rawSnapshot: unknown,
  now: Date,
  sourceAvailable: boolean,
): AutomationHealth["routing"] {
  if (!sourceAvailable) {
    return {
      status: "unknown",
      decisionsToday: null,
      surfaces: null,
      baselineSurfaces: null,
      insufficientSurfaces: null,
    };
  }
  const today = now.toISOString().slice(0, 10);
  const decisionsToday = tasks.filter((task) =>
    isAutomationDispatchTask(task)
    && asString(task.createdAt)?.slice(0, 10) === today
    && Boolean(asString(task.routingReason) || asRecord(task.decisionRecord))
  ).length;
  const scorecard = buildAgentScorecard(rawSnapshot, { now });
  const routingMemory = asRecord(scorecard.routingMemory);
  const scores = asArray(routingMemory?.scores)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const baselineScores = scores.filter((score) => asString(score.status) === "baseline_available");
  const insufficientScores = scores.filter((score) => asString(score.status) === "insufficient_data");
  const surfaceCount = new Set(scores.map((score) => asString(score.surface)).filter(Boolean)).size;
  const top = baselineScores
    .map((score) => ({
      surface: asString(score.surface) ?? "unknown",
      agent: asString(score.agent) ?? "unknown",
      score: asFiniteNumber(score.score) ?? 0,
      samples: asFiniteNumber(score.samples) ?? 0,
    }))
    .filter((score) => Number.isFinite(score.score) && score.score > 0)
    .sort((a, b) => b.score - a.score || b.samples - a.samples)[0];
  return {
    status: baselineScores.length > 0 ? "baseline_available" : "insufficient_data",
    decisionsToday,
    surfaces: surfaceCount,
    baselineSurfaces: baselineScores.length,
    insufficientSurfaces: insufficientScores.length,
    ...(top ? { top } : {}),
  };
}

function isAutomationDispatchTask(task: Record<string, unknown>): boolean {
  const requester = asString(task.requester);
  const approvedBy = asString(task.approvedBy);
  return requester === "hermes"
    || requester === "hermes-self-healing"
    || approvedBy === "hermes-autopilot"
    || approvedBy === "o5-self-management";
}

function dispatchPerDayCap(env: { HERMES_DISPATCH_PER_DAY_MAX?: string | undefined }): number {
  const parsed = Number.parseInt(env.HERMES_DISPATCH_PER_DAY_MAX ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
}

function sourceCardCorrelationIdsForDedupe(
  card: BoardCard,
  missionIndex: ReadonlyMap<string, Record<string, unknown>>,
): string[] {
  const ids = new Set<string>();
  if (card.correlationId) ids.add(card.correlationId);
  if (card.type === "mission" && card.correlationId) {
    const missionRun = missionIndex.get(card.correlationId);
    const targetUrl = asString(missionRun?.targetUrl);
    if (targetUrl) {
      ids.add(`self-heal:testbed_mission:${testbedSurfaceKey(targetUrl)}`);
    }
  }
  return Array.from(ids);
}
