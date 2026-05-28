// Hermes Handoff Monitor — board-level selectors and derived state.
//
// Pure functions turning a raw card list into what the board UI
// renders directly: KPI counts, the single most urgent action, the
// BoardNow banner prose, and the board's overall mode.
//
// Per §5/§16 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.

import type { BoardCard, Lane } from "./card-types.js";
import { groupByLane, laneCounts } from "./lane-rules.js";
import { sortByUrgency } from "./urgency.js";

export interface KPICounts {
  action: number;
  review: number;
  checking: number;
  queue: number;
  deploying: number;
  blocked: number;
  done: number;
  total: number;
}

export type BoardMode = "calm" | "action" | "degraded";

export interface BoardNowBanner {
  tone: BoardMode;
  eyebrow: string;
  headline: string;
  sub: string;
  primaryActionId: string | undefined;
}

export interface DeriveBoardOpts {
  streamOnline?: boolean;
  nowLabel?: string;
  lastGoodLabel?: string;
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
    action: counts["needs-attention"],
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
        ? `1 card needs your review decision; automation has gone as far as it safely can.`
        : `${actionCount} cards need your review decision; automation has gone as far as it safely can.`;
    return {
      tone: "action",
      eyebrow: now ? `Board now · ${now} · ${actionCount} action needed` : `Board now · ${actionCount} action needed`,
      headline,
      sub: urgent
        ? `Most urgent: ${urgent.title}. Approve only if the risk and intent are clear.`
        : `Approve only if the risk and intent are clear.`,
      primaryActionId: urgent?.id,
    };
  }

  return {
    tone: "calm",
    eyebrow: now ? `Board now · ${now} · you're done for now` : `Board now · you're done for now`,
    headline:
      counts.total === 0
        ? `Nothing waits on you. Everything in flight is automation; the day's release history is below.`
        : `Nothing in your queue right now. ${counts.checking + counts.queue + counts.deploying} card(s) are still automation in flight; Hermes is watching.`,
    sub:
      counts.done > 0
        ? `${counts.done} card(s) shipped today; you can step away.`
        : `No releases yet today; you can step away.`,
    primaryActionId: undefined,
  };
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
