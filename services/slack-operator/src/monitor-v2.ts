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
  const slug = (item.title ?? "card")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "card";
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

/**
 * Build the full v2 board snapshot from the raw monitor snapshot.
 * Reuses the existing classifier, then enriches every card.
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
  const cards = items.map((item) => toBoardCard(item));
  return {
    cards,
    at: now().toISOString(),
    repo: opts.repo ?? "",
  };
}
