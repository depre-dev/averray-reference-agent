import type { CollaborationTarget } from "./monitor-collab.js";
import {
  applyHermesMemoryInfluence,
  hermesDecisionCoachForCard,
  type HermesBoardCardSnapshot,
  type HermesBoardSnapshot,
} from "./monitor-hermes-voice.js";

export interface HermesBoardNarrationDecision {
  signature: string;
  shouldNarrate: boolean;
  reason?: string;
}

export interface HermesFallbackNarrationOptions {
  memoryNotes?: ReadonlyArray<string>;
}

const ACTIONABLE_LANES = new Set([
  "Needs Attention",
  "Waiting / Drafts",
  "Codex Needed",
  "Hermes Checking",
  "Operator Review",
  "Release Queue",
  "Deploying",
]);

export function decideHermesBoardNarration(
  board: HermesBoardSnapshot | undefined,
  previousSignature: string | undefined,
  inFlightSignature: string | undefined
): HermesBoardNarrationDecision {
  const signature = buildHermesBoardNarrationSignature(board);
  if (!signature) return { signature: "", shouldNarrate: false, reason: "no_actionable_board_state" };
  if (signature === previousSignature) return { signature, shouldNarrate: false, reason: "unchanged" };
  if (signature === inFlightSignature) return { signature, shouldNarrate: false, reason: "already_in_flight" };
  return { signature, shouldNarrate: true };
}

export function buildHermesBoardNarrationSignature(board: HermesBoardSnapshot | undefined): string {
  if (!board || !board.items || board.items.length === 0) return "";
  const actionable = board.items
    .filter((item) => ACTIONABLE_LANES.has(item.lane))
    .slice(0, 6);
  if (actionable.length === 0) return "";
  const counts = board.counts ? stableCounts(board.counts) : "";
  const cards = actionable.map((item) => [
    item.lane,
    item.owner,
    item.repo || "",
    item.number || "",
    item.verdict || "",
    item.why || "",
    item.next || "",
  ].join(":"));
  return [counts, ...cards].filter(Boolean).join("|");
}

export function fallbackHermesBoardNarration(
  board: HermesBoardSnapshot,
  options: HermesFallbackNarrationOptions = {}
): string {
  return applyHermesMemoryInfluence(fallbackHermesBoardNarrationBase(board), {
    board,
    memoryNotes: options.memoryNotes,
  });
}

function fallbackHermesBoardNarrationBase(board: HermesBoardSnapshot): string {
  const items = board.items?.filter((item) => ACTIONABLE_LANES.has(item.lane)) ?? [];
  const primary = items[0];
  if (!primary) {
    return board.headline || "The board is quiet right now. I do not see a live handoff that needs a next move.";
  }
  const label = prLabel(primary);
  if (primary.lane === "Waiting / Drafts") {
    return decisionNarration(
      primary,
      `${label} is parked in Waiting / Drafts: ${sentence(primary.why || "GitHub still marks it as a draft")} I will keep it out of the release path.`
    );
  }
  if (primary.lane === "Needs Attention") {
    return decisionNarration(
      primary,
      `${label} needs attention: ${sentence(primary.why || "a blocking signal is still present")} Current owner is ${primary.owner}.`
    );
  }
  if (primary.lane === "Operator Review") {
    return decisionNarration(
      primary,
      `${label} is in Operator Review: ${sentence(primary.why || "Hermes has gone as far as automation safely can")} Pascal, this is a project-level decision, not more hidden automation.`
    );
  }
  if (primary.lane === "Codex Needed") {
    return `${label} is Codex-owned now: ${sentence(primary.why || "the board has a task for Codex")} Codex should ${lowerFirst(primary.next || "work the next smallest verifiable step and report back")}.`;
  }
  if (primary.lane === "Release Queue") {
    return decisionNarration(
      primary,
      `${label} is in the Release Queue: ${sentence(primary.why || "the checks look merge-ready")} The merge steward owns the next move.`
    );
  }
  if (primary.lane === "Hermes Checking") {
    return `${label} is with Hermes now: ${sentence(primary.why || "checks are still moving")} I will wait for the evidence to settle before assigning new work.`;
  }
  if (primary.lane === "Deploying") {
    return `${label} is in deploy verification: ${sentence(primary.why || "production checks are still moving")} I will call out a pass or failure when the signal lands.`;
  }
  return `${label}: ${sentence(primary.why || board.headline || "the board changed")} Next move is ${lowerFirst(primary.next || "watch the card until the owner changes")}.`;
}

function decisionNarration(item: HermesBoardCardSnapshot, opening: string): string {
  const coach = hermesDecisionCoachForCard(item);
  if (!coach) {
    return `${opening} Next move is ${lowerFirst(item.next || "watch the card until the owner changes")}.`;
  }
  return [
    opening,
    `The button ${coach.button}; ${coach.avoid}.`,
    `Safest next step: ${coach.safestNext}.`,
  ].join(" ");
}

export function targetForHermesBoardNarration(board: HermesBoardSnapshot): CollaborationTarget {
  const primary = board.items?.find((item) => ACTIONABLE_LANES.has(item.lane));
  if (!primary) return "everyone";
  if (primary.owner === "Codex") return "codex";
  if (primary.owner === "Operator" || primary.owner === "PR author") return "operator";
  return "everyone";
}

export function relatedPrForHermesBoardNarration(board: HermesBoardSnapshot): { repo: string; number: number } | undefined {
  const items = board.items?.filter((item) => ACTIONABLE_LANES.has(item.lane) && item.repo && item.number) ?? [];
  if (items.length !== 1) return undefined;
  const item = items[0];
  return item.repo && item.number ? { repo: item.repo, number: item.number } : undefined;
}

function stableCounts(counts: Readonly<Record<string, number | string | boolean>>): string {
  return Object.keys(counts)
    .sort()
    .filter((key) => key !== "recent" && counts[key] !== undefined && counts[key] !== false && counts[key] !== "")
    .map((key) => `${key}=${String(counts[key])}`)
    .join(",");
}

function prLabel(item: HermesBoardCardSnapshot): string {
  if (item.repo && item.number) return `${item.repo}#${item.number}`;
  return item.title || "This handoff";
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function lowerFirst(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed[0]?.toLowerCase() + trimmed.slice(1);
}
