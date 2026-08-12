// What is worth waking you for, and what the page is allowed to claim.
//
// Product-health alerting is probe-driven: `evaluateProductHealth` collects the
// RED probes and those page. A reward-bank floor breach is also pinned here as
// an explicit money condition: the authoritative structured balance + floor
// must page even if the surrounding probe taxonomy changes.
//
// One money signal is NOT a probe and therefore could never page: payout
// evidence lives in the snapshot's `flow.payout` block. So the system could
// observe "14 jobs settled, 2 payouts confirmed" and say nothing at all.
//
// Two rules govern what this is allowed to send:
//
//  1. NEVER page on "unverified". Unverified means the INSTRUMENT is in doubt —
//     a drifted event topic, a throttled RPC, a window that does not span the
//     comparison. Paging on it reports our own blind spot as a money failure,
//     and a page that fires whenever we cannot see is the page you learn to
//     swipe away. Only a SHORTFALL — real evidence, honestly short — pages.
//
//  2. Every page states the monitor version it speaks for. An alert from a
//     build that is nine commits behind may be describing a world that no
//     longer exists, and you cannot judge that from the message text alone.

import type { ProductHealthSnapshotBlocks } from "./product-health.js";

export interface MoneyAlert {
  /** Money-blocking lines, most consequential first. Empty ⇒ nothing to page. */
  lines: string[];
  /**
   * Stable de-dup key over what is wrong. Empty when nothing is wrong, so the
   * caller can fold it into the existing rising-edge/cooldown logic.
   */
  key: string;
}

/**
 * The money-blocking facts allowed to page from structured snapshot evidence,
 * independently of probe classification. PURE.
 *
 * Today these are a payout shortfall and an observed reward-bank floor breach.
 * The latter deliberately repeats a probe-backed fact at the money boundary:
 * payouts hard-stop when that pool empties, so future probe refactors must not
 * silently remove its page. This remains alert-only; it never moves funds.
 */
export function decideMoneyAlert(snapshot?: ProductHealthSnapshotBlocks): MoneyAlert {
  const lines: string[] = [];
  const keys: string[] = [];

  const rewardBank = snapshot?.solvency?.pools.find((pool) => pool.key === "reward_bank");
  const liquid = rewardBank?.amount;
  const floor = rewardBank?.floor;
  if (
    typeof liquid === "number"
    && Number.isFinite(liquid)
    && typeof floor === "number"
    && Number.isFinite(floor)
    && floor > 0
    && liquid < floor
  ) {
    lines.push(
      `• 🏦 reward bank floor breached: ${liquid.toFixed(2)} USDC liquid < ${floor.toFixed(2)} USDC floor — operator top-up required; no automatic refill`,
    );
    // The crossing is the event. Do not re-page on every payout while the bank
    // remains below the same floor; the existing cooldown owns reminders.
    keys.push(`reward-bank:below:${floor}`);
  }

  const payout = snapshot?.flow?.payout;
  if (payout?.status === "shortfall") {
    const settled = payout.settledCount ?? null;
    const confirmed = payout.confirmedCount ?? null;
    const gap = settled !== null && confirmed !== null ? settled - confirmed : null;
    lines.push(`• 💸 payout shortfall: ${payout.detail}`);
    // Key on the SIZE of the gap, not the raw detail string: the detail carries
    // USDC totals that drift every cycle and would re-page on noise alone.
    keys.push(`payout:${gap ?? "unknown"}`);
  }

  // "unverified" deliberately contributes nothing: it is not evidence of lost
  // money. The same absent-not-zero rule applies to an unreadable bank or floor.
  return {
    lines,
    key: keys.join("|"),
  };
}

/**
 * The version footer. Always names the running build; says so loudly when that
 * build is stale, because a page from old code can describe a stale world.
 */
export function alertProvenance(snapshot?: ProductHealthSnapshotBlocks): string | undefined {
  const self = snapshot?.self;
  if (!self) return undefined;
  if (self.status === "behind") {
    return `⚠️ sent by monitor ${short(self.runningSha)}, ${self.behindBy ?? "?"} commits behind main — this alert may describe stale code`;
  }
  if (self.status === "unknown") {
    return "monitor version unknown — cannot confirm this alert reflects current code";
  }
  return `monitor ${short(self.runningSha)}`;
}

function short(sha: string | null): string {
  return sha ? sha.slice(0, 8) : "unknown";
}
