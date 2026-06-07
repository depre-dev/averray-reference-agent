// Hermes Handoff Monitor — board-level selectors and derived state.
//
// Pure functions turning a raw card list into what the board UI
// renders directly: KPI counts, the single most urgent action, the
// BoardNow banner prose, and the board's overall mode.
//
// Per §5/§16 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.

import type { BoardCard, Lane } from "./card-types.js";
import { groupByLane, laneCounts, laneFor, isDecision } from "./lane-rules.js";
import { formatFreshness, sortByUrgency } from "./urgency.js";

/** The state a LanesBar filter chip narrows the board to. */
export type BoardFilter = "all" | "blocked" | "review" | "ready" | "running" | "done" | "today-done";

/**
 * Whether a card belongs to a filter chip's state. Lane-based chips reuse the
 * SAME lane derivation (`laneFor`) the chip COUNTS use, so the filtered view and
 * the count on the chip always agree. "blocked" is the cross-lane stale/offline
 * state (matching kpiCounts.blocked). "all" matches everything.
 */
export function matchesBoardFilter(
  card: BoardCard,
  filter: BoardFilter,
  opts: { todayIso?: string } = {},
): boolean {
  if (filter === "all") return true;
  if (filter === "blocked") return card?.state === "failed-fetch" || card?.state === "source-offline";
  const lane = laneFor(card);
  switch (filter) {
    case "review":
      return lane === "operator-review";
    case "ready":
      return lane === "release-queue";
    case "running":
      return lane === "hermes-checking";
    case "done":
      return lane === "done";
    case "today-done":
      return lane === "done" && isSameUtcDay(doneClosedAt(card), opts.todayIso);
    default:
      return true;
  }
}

export interface KPICounts {
  action: number;
  codex: number;
  review: number;
  checking: number;
  queue: number;
  deploying: number;
  blocked: number;
  done: number;
  total: number;
}

export type BoardMode = "calm" | "action" | "hermes-focus" | "degraded";

export interface MostUrgentReasonChip {
  label: string;
  tone: "neutral" | "risk" | "safe" | "warn";
  title?: string;
}

export interface CalmBoardMetrics {
  avgTimeToDecision?: string;
  disputes?: number;
  lastDeploy?: {
    id?: string;
    verifiedAt?: string;
  };
}

export interface BoardNowBanner {
  tone: BoardMode;
  eyebrow: string;
  headline: string;
  sub: string;
  primaryActionId: string | undefined;
  mostUrgentReasons?: MostUrgentReasonChip[];
}

export interface DeriveBoardOpts {
  streamOnline?: boolean;
  nowLabel?: string;
  lastGoodLabel?: string;
  hermesFocusCardId?: string;
  calmMetrics?: CalmBoardMetrics;
}

export interface DerivedBoardState {
  grouped: Record<Lane, BoardCard[]>;
  counts: KPICounts;
  mode: BoardMode;
  banner: BoardNowBanner;
  mostUrgent: BoardCard | undefined;
}

/** KPI counts. Live counts exclude done; total is "everything live now." */
export function kpiCounts(cards: BoardCard[]): KPICounts {
  const counts = laneCounts(cards);
  const blocked = Array.isArray(cards)
    ? cards.filter((c) => c && (c.state === "failed-fetch" || c.state === "source-offline")).length
    : 0;
  const liveLanes =
    counts["needs-attention"] +
    counts["drafts"] +
    counts["codex-needed"] +
    counts["hermes-checking"] +
    counts["operator-review"] +
    counts["release-queue"] +
    counts["deploying"];
  return {
    // PR-F1: the action count is the real operator-decision count (isDecision),
    // NOT the needs-attention lane size — so done/verified release-history cards
    // that linger in the lane never inflate it. Drives the banner, board mode,
    // and the TopStrip "action needed" pill, which now agree with the inbox/rail.
    action: Array.isArray(cards) ? cards.filter(isDecision).length : 0,
    codex: counts["codex-needed"],
    review: counts["operator-review"],
    checking: counts["hermes-checking"],
    queue: counts["release-queue"],
    deploying: counts["deploying"],
    blocked,
    done: counts["done"],
    total: liveLanes,
  };
}

/** The single most urgent live card, or undefined when calm. */
export function mostUrgentCard(cards: BoardCard[]): BoardCard | undefined {
  if (!Array.isArray(cards) || cards.length === 0) return undefined;
  const live = cards.filter((c) => c && c.lane !== "done" && c.type !== "done");
  if (live.length === 0) return undefined;
  const [first] = sortByUrgency(live);
  return first;
}

/**
 * Board mode: degraded (stream offline OR any blocked card) > action
 * (any needs-attention card) > calm.
 */
export function boardMode(cards: BoardCard[], opts: DeriveBoardOpts = {}): BoardMode {
  if (opts.streamOnline === false) return "degraded";
  if (!Array.isArray(cards) || cards.length === 0) return "calm";
  const counts = kpiCounts(cards);
  if (counts.blocked > 0) return "degraded";
  if (opts.hermesFocusCardId && cards.some((card) => card.id === opts.hermesFocusCardId && isDecision(card))) {
    return "hermes-focus";
  }
  if (counts.action > 0) return "action";
  return "calm";
}

/** Compose the BoardNow banner prose. Tone follows boardMode. */
export function boardNowBanner(cards: BoardCard[], opts: DeriveBoardOpts = {}): BoardNowBanner {
  const mode = boardMode(cards, opts);
  const now = opts.nowLabel ?? "";
  const counts = kpiCounts(cards);

  if (mode === "degraded") {
    return {
      tone: "degraded",
      eyebrow: now ? `Board now · ${now} · degraded` : "Board now · degraded",
      headline:
        opts.streamOnline === false
          ? "Live stream disconnected. Card data may be stale; the operator should reconnect before acting."
          : `${counts.blocked} card(s) report stale or offline upstream data; freshness on those is not trustworthy.`,
      sub: opts.lastGoodLabel
        ? `Last known good read: ${opts.lastGoodLabel}. Hermes is auto-reconnecting; the operator can keep working but should not approve based on potentially stale state.`
        : `Hermes is auto-reconnecting; the operator can keep working but should not approve based on potentially stale state.`,
      primaryActionId: undefined,
    };
  }

  if (mode === "action") {
    const urgent = mostUrgentCard(cards);
    const actionCount = counts.action;
    const headline =
      actionCount === 1
        ? "1 decision waiting on you"
        : `${actionCount} decisions waiting on you`;
    const suggestedAction = urgent ? suggestedActionFor(urgent) : undefined;
    return {
      tone: "action",
      eyebrow: now ? `Board now · ${now} · ${actionCount} action needed` : `Board now · ${actionCount} action needed`,
      headline,
      sub: urgent
        ? `Most urgent: ${urgent.title} — suggests ${suggestedAction}.`
        : `Review the decision inbox before approving anything.`,
      primaryActionId: urgent?.id,
      mostUrgentReasons: urgent ? mostUrgentReasonsFor(urgent) : undefined,
    };
  }

  if (mode === "hermes-focus") {
    const focusCard = cards.find((card) => card.id === opts.hermesFocusCardId);
    const pendingCount = pendingReviewCount(cards);
    return {
      tone: "hermes-focus",
      eyebrow: now ? `Board now · ${now} · in conversation with Hermes` : "Board now · in conversation with Hermes",
      headline: `Hermes has the floor — ${pendingCount} review ${pendingCount === 1 ? "decision" : "decisions"} pending, blast radius assessed.`,
      sub: focusCard
        ? `Conversation is scoped to ${focusCard.title}. Open the checklist when the risk and intent are clear.`
        : "Conversation is scoped to the current review card. Open the checklist when the risk and intent are clear.",
      primaryActionId: focusCard?.id,
    };
  }

  return {
    tone: "calm",
    eyebrow: now ? `Board now · ${now} · you're done for now` : `Board now · you're done for now`,
    headline: calmHeadline(counts),
    sub: calmSub(counts, opts.calmMetrics),
    primaryActionId: undefined,
  };
}

function calmHeadline(counts: KPICounts): string {
  if (counts.total === 0) {
    return "Nothing needs you right now. The board is quiet on purpose.";
  }

  const automationCount = counts.checking + counts.queue + counts.deploying;
  const parts = [
    counts.codex > 0 ? `${counts.codex} Codex-owned card(s)` : "",
    automationCount > 0 ? `${automationCount} automation/release card(s)` : "",
  ].filter(Boolean);
  if (parts.length === 0) {
    return `${counts.total} card(s) are still in flight; Hermes is watching.`;
  }
  return `No operator decision needed. ${parts.join(" and ")} are still in flight; Hermes is watching.`;
}

function calmSub(counts: KPICounts, metrics?: CalmBoardMetrics): string {
  const base =
    counts.total === 0 && counts.done === 0
      ? "No active decisions, dispatches, or release work"
      : counts.done > 0
        ? `${counts.done} card(s) shipped today`
        : "No releases yet today";
  const parts = [base];
  if (metrics?.avgTimeToDecision) parts.push(`avg time-to-decision ${metrics.avgTimeToDecision}`);
  if (typeof metrics?.disputes === "number") parts.push(`${metrics.disputes} dispute(s)`);
  if (metrics?.lastDeploy?.id || metrics?.lastDeploy?.verifiedAt) {
    const id = metrics.lastDeploy.id ? ` ${metrics.lastDeploy.id}` : "";
    const verified = metrics.lastDeploy.verifiedAt ? ` verified at ${metrics.lastDeploy.verifiedAt}` : "";
    parts.push(`last deploy${id}${verified}`);
  }
  return `${parts.join(" · ")}. Hermes is watching; you can step away.`;
}

function pendingReviewCount(cards: BoardCard[]): number {
  // PR-F1: the shared isDecision predicate is the single source of truth (it
  // also excludes done/verified/closed). The `|| 1` floor only applies in the
  // hermes-focus prose, where a card is by definition under review.
  return cards.filter(isDecision).length || 1;
}

function suggestedActionFor(card: BoardCard): string {
  if (card.type === "pr" && card.action?.primary) return card.action.primary;
  if (card.type === "task") {
    if (card.action?.primary) return card.action.primary;
    if (card.taskStatus === "proposed") return "approve dispatch";
    if (card.taskStatus === "failed") return "review failure";
  }
  if (card.type === "mission") {
    if (card.missionStatus === "requested") return "approve mission";
    if (card.missionStatus === "failed") return "review failure";
    if (card.mission?.recommendations?.[0]) return "review suggested fix";
  }
  if (card.type === "deploy") return "review deployment";
  if (card.next) return normalizeSuggestedAction(card.next);
  if (card.decisionRecord?.outcome?.waitingNext) return normalizeSuggestedAction(card.decisionRecord.outcome.waitingNext);
  return "review decision";
}

function normalizeSuggestedAction(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "review decision";
  return trimmed.length > 72 ? `${trimmed.slice(0, 69).trim()}...` : trimmed;
}

function mostUrgentReasonsFor(card: BoardCard): MostUrgentReasonChip[] {
  const chips: MostUrgentReasonChip[] = [];
  const age = formatFreshness(card.freshness);
  if (age) {
    chips.push({
      label: `blocked ${age.toLowerCase()}`,
      tone: card.freshness >= 240 ? "warn" : "neutral",
      title: "Minutes since this card entered its current lane.",
    });
  }

  const risk = riskReasonFor(card);
  if (risk) chips.push(risk);

  const safety = safetyReasonFor(card);
  if (safety) chips.push(safety);

  return chips.slice(0, 4);
}

function riskReasonFor(card: BoardCard): MostUrgentReasonChip | undefined {
  if (card.type === "task" && card.riskTier) {
    return { label: `${card.riskTier} risk`, tone: card.riskTier === "high" ? "risk" : "neutral" };
  }
  const signal = card.riskSignals?.find((entry) => entry.severity === "high")
    ?? card.riskSignals?.find((entry) => entry.severity === "medium")
    ?? card.riskSignals?.[0];
  if (signal) {
    return {
      label: `${signal.severity} risk`,
      tone: signal.severity === "high" ? "risk" : "warn",
      title: signal.message,
    };
  }
  const [firstRisk] = card.risk ?? [];
  if (!firstRisk) return undefined;
  return { label: `risk: ${firstRisk.replace(/-/g, " ")}`, tone: "risk" };
}

function safetyReasonFor(card: BoardCard): MostUrgentReasonChip | undefined {
  const safety = card.decisionRecord?.safety;
  if (!safety) return undefined;
  if (safety.readOnly && !safety.mutates) return { label: "safe: read-only", tone: "safe" };
  if (safety.mutates) return { label: "mutates", tone: "warn" };
  return undefined;
}

function doneClosedAt(card: BoardCard): string | undefined {
  return card.type === "done" ? card.closedAt : undefined;
}

function isSameUtcDay(iso: string | undefined, todayIso: string | undefined): boolean {
  if (!iso || !todayIso) return false;
  const at = new Date(iso);
  const today = new Date(todayIso);
  if (Number.isNaN(at.getTime()) || Number.isNaN(today.getTime())) return false;
  return at.toISOString().slice(0, 10) === today.toISOString().slice(0, 10);
}

/** Aggregate selector — everything the board page needs in one call. */
export function deriveBoardState(cards: BoardCard[], opts: DeriveBoardOpts = {}): DerivedBoardState {
  return {
    grouped: groupByLane(cards),
    counts: kpiCounts(cards),
    mode: boardMode(cards, opts),
    banner: boardNowBanner(cards, opts),
    mostUrgent: mostUrgentCard(cards),
  };
}
