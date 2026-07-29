// What earns a slot on a phone.
//
// The desktop board is a triage surface: you have a diff, a drawer, and time,
// so EVERY decision belongs there and `unknown` correctly outranks `standard`
// (missing money evidence must never read as safe — decision-rank.ts).
//
// A phone is an ACTION surface. The operator is away from the desk and can only
// usefully do a small number of things. Shipping the desktop ordering to the
// phone put a card titled "codex task" at the top with a green Approve button
// under it — top billing for the one card that explained itself least, and an
// approval the operator had no basis to give. Approving what you cannot
// identify is worse than not being asked.
//
// So the phone splits decisions two ways:
//   ACT NOW  — money-blocking work, plus approvals that can state their basis;
//   DELIVERY — everything else, as an honest count you can tap.
//
// Truth boundary: this REORDERS and COLLAPSES, it never drops. `actNow` and
// `delivery` together always equal every `isDecision` card, the count is real,
// and the desktop board is untouched. "Not on the phone" is not "hidden".

import type { BoardCard } from "./card-types.js";
import { decisionPriorityFor, rankDecisionCards } from "./decision-rank.js";
import type { ProductHealth } from "./product-health.js";

/** Longest basis line we put on a phone before the desktop takes over. */
const BASIS_MAX = 120;

export interface ApprovalBasis {
  /** WHAT it will do — the operator-authored prompt/title, verbatim. */
  what: string;
  /** WHY Hermes proposed it, when the card carries a reason. */
  why?: string;
  /** Routing risk tier, when known. */
  risk?: "high" | "low";
}

export interface PhoneTriage {
  /** Money-blocking work + approvals that can justify themselves. */
  actNow: BoardCard[];
  /** Everything else — surfaced as a count, not as a demand. */
  delivery: BoardCard[];
}

/**
 * Can this card justify the approval it is asking for?
 *
 * Returns undefined when it cannot — and the UI must then withhold the Approve
 * button rather than render one over a blank. Every field is read straight off
 * the payload; nothing is summarised or inferred.
 */
export function approvalBasisFor(card: BoardCard | undefined): ApprovalBasis | undefined {
  if (!card) return undefined;
  // `??` is wrong here: an EMPTY prompt is not nullish, so it would swallow the
  // title fallback. Take the first source that actually yields a line.
  const what = firstLine((card as { prompt?: string }).prompt)
    ?? (isSpecificTitle(card.title) ? firstLine(card.title) : undefined);
  if (!what) return undefined;
  const why = firstLine(
    (card as { reason?: string }).reason
      ?? card.decisionRecord?.reasons?.find((r) => typeof r === "string" && r.trim().length > 0)
      ?? card.decisionRecord?.outcome?.summary,
  );
  const risk = (card as { riskTier?: "high" | "low" }).riskTier;
  return { what, ...(why ? { why } : {}), ...(risk ? { risk } : {}) };
}

/**
 * A title like "codex task" or "task" names the CARD KIND, not the work. It is
 * the shape that produced the unapprovable card, so it does not count as a
 * basis — the prompt has to carry it instead.
 */
function isSpecificTitle(title: string | undefined): boolean {
  const t = (title ?? "").trim().toLowerCase();
  if (!t) return false;
  return !["codex task", "claude task", "task", "board card", "agent task"].includes(t);
}

function firstLine(value: string | undefined): string | undefined {
  const line = (value ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > BASIS_MAX ? `${line.slice(0, BASIS_MAX - 1).trimEnd()}…` : line;
}

/**
 * Split the operator's decisions into what deserves the phone and what is just
 * a number on it. Input order is the shared money-first ranking, so ACT NOW is
 * still money-first internally.
 */
export function triageForPhone(cards: BoardCard[], health?: ProductHealth): PhoneTriage {
  const ranked = rankDecisionCards(cards, health);
  const actNow: BoardCard[] = [];
  const delivery: BoardCard[] = [];
  for (const card of ranked) {
    (belongsOnPhone(card, health) ? actNow : delivery).push(card);
  }
  return { actNow, delivery };
}

function belongsOnPhone(card: BoardCard, health?: ProductHealth): boolean {
  const tier = decisionPriorityFor(card, health).tier;
  // Routine verification is the definition of what does NOT need you at 17:42.
  if (tier === "routine-verification") return false;
  // Money is why you look at your phone.
  if (tier === "money-blocking") return true;
  // Otherwise it has to earn the slot by being actionable AND explicable: a
  // proposed task you can identify. An unexplained card is exactly the one the
  // phone should stop demanding a decision on.
  return isProposedTask(card) && approvalBasisFor(card) !== undefined;
}

/** Only an already-proposed task is approvable; nothing else is phone-actionable. */
export function isProposedTask(card: BoardCard): boolean {
  return card.type === "task" && (card as { taskStatus?: string }).taskStatus === "proposed";
}
