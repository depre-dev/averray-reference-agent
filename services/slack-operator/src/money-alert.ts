// What is worth waking you for, and what the page is allowed to claim.
//
// Product-health alerting is probe-driven: `evaluateProductHealth` collects the
// RED probes and those page. That already covers a pool under its floor, a
// halted chain and a degraded money path — they are probes, so they alert.
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
 * The money-blocking facts that no probe covers. PURE.
 *
 * Today that is exactly one: a payout shortfall. Pools, chain halt and money
 * path are already red probes and already page — repeating them here would
 * double-send, and two pages for one fact is its own kind of noise.
 */
export function decideMoneyAlert(snapshot?: ProductHealthSnapshotBlocks): MoneyAlert {
  const payout = snapshot?.flow?.payout;
  if (!payout || payout.status !== "shortfall") {
    // "unverified" deliberately lands here: it is not evidence of lost money.
    return { lines: [], key: "" };
  }
  const settled = payout.settledCount ?? null;
  const confirmed = payout.confirmedCount ?? null;
  const gap = settled !== null && confirmed !== null ? settled - confirmed : null;
  return {
    lines: [`• 💸 payout shortfall: ${payout.detail}`],
    // Key on the SIZE of the gap, not the raw detail string: the detail carries
    // USDC totals that drift every cycle and would re-page on noise alone.
    key: `payout:${gap ?? "unknown"}`,
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
