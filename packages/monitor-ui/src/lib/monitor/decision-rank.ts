// Hermes decision-queue ranking.
//
// This module is deliberately pure: it turns the card and product-health
// evidence already present in the monitor payload into an ordering plus a short
// operator-facing reason. It never removes an `isDecision` card. Missing money
// evidence is an explicit "unknown" tier rather than an implied safe result.

import type { BoardCard, CardFile } from "./card-types.js";
import type { ProductHealth, ProductHealthProbe } from "./product-health.js";
import { isDecision } from "./lane-rules.js";
import { probeLabel } from "./product-health.js";
import { sortByUrgency } from "./urgency.js";

export type DecisionPriorityTier =
  | "money-blocking"
  | "unknown"
  | "standard"
  | "routine-verification";

export interface DecisionPriority {
  tier: DecisionPriorityTier;
  /** Short, payload-backed explanation suitable for a chip. */
  reason: string;
}

const TIER_RANK: Record<DecisionPriorityTier, number> = {
  "money-blocking": 0,
  unknown: 1,
  standard: 2,
  "routine-verification": 3,
};

const MONEY_PATH_PATTERN = /(settlement|escrow|treasury|payout)/i;
const ROUTINE_VERIFICATION_PATTERN =
  /\b(?:post[-\s]?(?:production[-\s]?deploy|deploy|merge)|deploy)\s+verification\b/i;

const MONEY_PROBES = [
  {
    name: "money_path",
    aliases: [/\bmoney[_\s-]?path\b/i],
  },
  {
    name: "signer_liquidity",
    aliases: [/\bsigner[_\s-]?liquidity\b/i, /\bsigner\s+gas\b/i, /\breward\s+bank\b/i],
  },
  {
    name: "treasury_liquidity",
    aliases: [/\btreasury[_\s-]?liquidity\b/i, /\btreasury\s+reserve\b/i],
  },
] as const;

/**
 * Rank every real operator decision without mutating or dropping the input.
 *
 * Money-blocking decisions come first. Unknown money relevance deliberately
 * precedes evidence-backed standard work, and explicit routine deploy
 * verification comes last. Existing urgency remains the tie-breaker inside
 * every tier.
 */
export function rankDecisionCards(
  cards: BoardCard[],
  health?: ProductHealth,
): BoardCard[] {
  if (!Array.isArray(cards)) return [];
  const byUrgency = sortByUrgency(cards.filter(isDecision));
  return byUrgency.sort(
    (a, b) =>
      TIER_RANK[decisionPriorityFor(a, health).tier] -
      TIER_RANK[decisionPriorityFor(b, health).tier],
  );
}

/** Explain the tier using only evidence that exists on the card/health payload. */
export function decisionPriorityFor(
  card: BoardCard,
  health?: ProductHealth,
): DecisionPriority {
  const files = cardFiles(card);

  const linkedProbe = degradedLinkedMoneyProbe(card, health);
  if (linkedProbe) {
    return {
      tier: "money-blocking",
      reason: `Money first · ${probeLabel(linkedProbe.name)} ${linkedProbe.status}`,
    };
  }

  const repoPath = firstMoneyPath(card.repo);
  if (repoPath) {
    return { tier: "money-blocking", reason: `Money first · ${repoPath} repo` };
  }

  for (const file of files) {
    const pathSignal = firstMoneyPath(file.path);
    if (pathSignal) {
      return { tier: "money-blocking", reason: `Money first · ${pathSignal} path` };
    }
  }

  const critical = files.find((file) => file.critical === true);
  if (critical) {
    return { tier: "money-blocking", reason: "Money first · critical file" };
  }

  if (ROUTINE_VERIFICATION_PATTERN.test(cardEvidenceText(card))) {
    return { tier: "routine-verification", reason: "Routine verification" };
  }

  if (files.length > 0) {
    return { tier: "standard", reason: "Standard decision" };
  }

  return { tier: "unknown", reason: "Money relevance unknown" };
}

function cardFiles(card: BoardCard): CardFile[] {
  const files = (card as BoardCard & { files?: CardFile[] }).files;
  return Array.isArray(files) ? files : [];
}

function firstMoneyPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.match(MONEY_PATH_PATTERN)?.[1]?.toLowerCase();
}

function degradedLinkedMoneyProbe(
  card: BoardCard,
  health?: ProductHealth,
): ProductHealthProbe | undefined {
  if (!health) return undefined;
  const text = cardEvidenceText(card);
  for (const candidate of MONEY_PROBES) {
    if (!candidate.aliases.some((pattern) => pattern.test(text))) continue;
    const probe = health.probes.find(
      (entry) =>
        entry.name === candidate.name &&
        (entry.status === "red" || entry.status === "degraded"),
    );
    if (probe) return probe;
  }
  return undefined;
}

function cardEvidenceText(card: BoardCard): string {
  const taskPrompt = card.type === "task" ? card.prompt : undefined;
  const taskFailure = card.type === "task" ? card.failureReason : undefined;
  const verdict = card.type === "pr" ? card.verdict : undefined;
  return [
    card.title,
    card.summary,
    card.repo,
    card.next,
    card.correlationId,
    taskPrompt,
    taskFailure,
    verdict,
    ...(card.riskSignals ?? []).flatMap((signal) => [signal.code, signal.message]),
    ...(card.decisionRecord?.reasons ?? []),
    card.decisionRecord?.outcome.summary,
    card.decisionRecord?.outcome.waitingNext,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}
