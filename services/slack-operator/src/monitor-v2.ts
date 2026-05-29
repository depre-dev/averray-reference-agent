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

import { buildHermesBoardSnapshotFromMonitor } from "./monitor-hermes-board.js";
import type {
  HermesBoardCardSnapshot,
  HermesBoardSnapshot,
} from "./monitor-hermes-voice.js";

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

export type AgentType = "claude" | "codex" | "hermes" | "ext";

export type CardState = "fresh" | "stale" | "failed-fetch" | "source-offline" | "running";

export type RiskTag =
  | "workflow" | "config" | "review-gated"
  | "contracts" | "secrets" | "indexer" | "xcm"
  | "docs" | "testbed" | "ui-only" | "deps" | "quality";

export interface WaitingOn {
  actor: "operator" | "author" | "agent" | "CI" | "relay" | "branch-protection";
  tone: "warn" | "info" | "neutral";
}

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
  /** Codex task cards: the dispatched prompt. */
  prompt?: string;
  /** Codex task cards: tail of stdout / completion summary. */
  output?: string;
  /** Codex task cards: failure reason when the task failed. */
  failureReason?: string;
  /** Codex task cards: runner liveness. */
  runnerHeartbeat?: CardRunnerHeartbeat;
  /** Per-check CI breakdown (non-done cards) — the list under the bar. */
  checkRuns?: CardCheckRun[];
  /** Hermes review findings (non-done cards) — the "why review" detail. */
  riskSignals?: CardRiskSignal[];
}

export interface BoardSnapshotV2 {
  cards: BoardCard[];
  at: string;
  repo: string;
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
 *   - testbed tag or "mission" in the id → mission
 *   - codex-needed lane or owner Codex with a task shape → task
 *   - done lane → done
 *   - a deploy-flavored title/owner → deploy
 *   - otherwise → pr (the common case)
 */
export function inferCardType(item: HermesBoardCardSnapshot, lane: Lane): CardType {
  const tags = (item.tags ?? []).map((t) => String(t).toLowerCase());
  const title = (item.title ?? "").toLowerCase();
  if (lane === "done") return "done";
  if (tags.includes("testbed") || /\bmission\b/.test(title)) return "mission";
  if (lane === "codex-needed") return "task";
  if (lane === "deploying" || /post-merge verify|deploy verif/.test(title)) return "deploy";
  if (lane === "drafts") return "draft";
  return "pr";
}

/**
 * Infer the agent that owns the card from the classifier `owner`
 * field + lane. The slim model doesn't carry agentType, so this is
 * best-effort and defaults to "ext" (external / unknown).
 */
export function inferAgentType(item: HermesBoardCardSnapshot, type: CardType): AgentType {
  const owner = (item.owner ?? "").toLowerCase();
  if (type === "mission") return "hermes";
  if (owner.includes("codex")) return "codex";
  if (owner.includes("hermes")) return "hermes";
  if (owner.includes("claude")) return "claude";
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
  const waitingOn = mapOwnerToWaitingOn(item.owner, isAction);

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
  if (typeof item.number === "number") card.branch = undefined; // branch not in slim model

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

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
    pending: asFiniteNumber(totals.neutral) ?? 0,
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

  // Codex task cards: prompt / output / failure / runner liveness.
  if (card.type === "task" && ctx.codexTask) {
    const task = ctx.codexTask;
    const prompt = asString(task.prompt);
    if (prompt) card.prompt = prompt;
    const output = asString(task.stdoutTail) ?? asString(task.completionSummary);
    if (output) card.output = output;
    const failureReason = asString(task.failureReason);
    if (failureReason) card.failureReason = failureReason;
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
export function buildV2BoardSnapshot(
  rawSnapshot: unknown,
  opts: { repo?: string; now?: () => Date } = {}
): BoardSnapshotV2 {
  const now = opts.now ?? (() => new Date());
  const classified: HermesBoardSnapshot | undefined =
    buildHermesBoardSnapshotFromMonitor(rawSnapshot);
  const items = classified?.items ?? [];
  const summaryIndex = indexRawSummaries(rawSnapshot);
  const codexIndex = indexCodexTasks(rawSnapshot);
  const runner = readRunner(rawSnapshot);
  const cards = items.map((item) => {
    const base = toBoardCard(item);
    const key = prKey(item.repo, item.number);
    return enrichBoardCard(base, item, {
      summary: key ? summaryIndex.get(key) : undefined,
      codexTask: key ? codexIndex.get(key) : undefined,
      runner,
    });
  });
  return {
    cards,
    at: now().toISOString(),
    repo: opts.repo ?? "",
  };
}
