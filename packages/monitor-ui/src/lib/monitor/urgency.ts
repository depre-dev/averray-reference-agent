// Hermes Handoff Monitor — freshness / staleness math.
//
// Pure functions turning a raw freshness value (minutes since the card
// entered its current lane) into the visual variants the cards render.
//
// Thresholds:
//   <  5 min  → fresh
//   <  30 min → warm
//   <  4 h    → settling
//   <  24 h   → stale
//   ≥ 24 h    → ancient  (≥48h is archive-suggestion eligible)
//
// Per §13/§15 of docs/HERMES_MONITOR_REDESIGN_SPEC.md.

import type { BoardCard } from "./card-types.js";

export type FreshnessTier = "fresh" | "warm" | "settling" | "stale" | "ancient";

export const FRESH_THRESHOLD_MINUTES = 5;
export const WARM_THRESHOLD_MINUTES = 30;
export const SETTLING_THRESHOLD_MINUTES = 4 * 60;
export const STALE_THRESHOLD_MINUTES = 24 * 60;
export const ARCHIVE_HINT_THRESHOLD_MINUTES = 48 * 60;

export function freshnessTier(minutes: number | null | undefined): FreshnessTier {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    return "settling";
  }
  if (minutes < FRESH_THRESHOLD_MINUTES) return "fresh";
  if (minutes < WARM_THRESHOLD_MINUTES) return "warm";
  if (minutes < SETTLING_THRESHOLD_MINUTES) return "settling";
  if (minutes < STALE_THRESHOLD_MINUTES) return "stale";
  return "ancient";
}

/**
 * Should the card show an "archive?" suggestion? True for cards sitting
 * in their lane >= 48h that aren't already done / drafts / action items.
 * A server-set `archiveHint` always wins.
 */
export function shouldSuggestArchive(card: BoardCard | undefined | null): boolean {
  if (!card) return false;
  if (card.lane === "done") return false;
  if (card.isDraft) return false;
  if (card.isAction) return false;
  if (card.archiveHint === true) return true;
  return freshnessTier(card.freshness) === "ancient";
}

/**
 * Compact human-readable freshness label: 3 → "3M", 90 → "1.5H",
 * 2880 → "2D". Null for unknown / negative input.
 */
export function formatFreshness(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) {
    return null;
  }
  if (minutes < 60) return `${Math.round(minutes)}M`;
  const hours = minutes / 60;
  if (hours < 48) {
    const formatted = hours < 10 ? hours.toFixed(1) : `${Math.round(hours)}`;
    return `${formatted.replace(/\.0$/, "")}H`;
  }
  const days = hours / 24;
  const formatted = days < 10 ? days.toFixed(1) : `${Math.round(days)}`;
  return `${formatted.replace(/\.0$/, "")}D`;
}

/**
 * Numeric urgency rank — lower = more urgent.
 *   0  isAction
 *   1  failing checks
 *   2  waiting on operator with warn tone
 *   10/20/30/40/50  fresh/warm/settling/stale/ancient
 */
export function urgencyRank(card: BoardCard | undefined | null): number {
  if (!card) return 100;
  if (card.isAction) return 0;
  if (card.checks && card.checks.fail > 0) return 1;
  if (card.waitingOn?.actor === "operator" && card.waitingOn?.tone === "warn") return 2;
  const tier = freshnessTier(card.freshness);
  if (tier === "fresh") return 10;
  if (tier === "warm") return 20;
  if (tier === "settling") return 30;
  if (tier === "stale") return 40;
  return 50;
}

/**
 * Sort cards by next-action urgency. Returns a new array; does not
 * mutate the input. Ties broken by freshness ascending (more recent
 * first).
 */
export function sortByUrgency(cards: BoardCard[]): BoardCard[] {
  if (!Array.isArray(cards)) return [];
  return [...cards].sort((a, b) => urgencyRank(a) - urgencyRank(b) || compareFreshness(a, b));
}

function compareFreshness(a: BoardCard, b: BoardCard): number {
  const af = typeof a.freshness === "number" ? a.freshness : Infinity;
  const bf = typeof b.freshness === "number" ? b.freshness : Infinity;
  return af - bf;
}
