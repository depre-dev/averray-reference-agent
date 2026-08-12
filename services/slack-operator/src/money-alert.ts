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
import type { DepositPoolFlow, DepositPoolSnapshot, TokenAmount } from "./deposit-pool-feed.js";

export interface MoneyAlert {
  /** Money-blocking lines, most consequential first. Empty ⇒ nothing to page. */
  lines: string[];
  /**
   * Stable de-dup key over what is wrong. Empty when nothing is wrong, so the
   * caller can fold it into the existing rising-edge/cooldown logic.
   */
  key: string;
}

export interface DepositPoolAlertObservation {
  sharePriceRaw?: string;
  sharePriceDecimals?: number;
  pricingModel?: string;
  blockNumber?: number;
  depositorCount?: number;
}

export interface DepositPoolAlertState {
  previous?: DepositPoolAlertObservation;
  /** Durable for this monitor process: a later withdrawal must not re-arm joy. */
  firstDepositPaged: boolean;
}

export interface DepositPoolAlertDecision {
  criticalLines: string[];
  positiveLines: string[];
  /** Conditions that remain true until repaired (plus critical transitions). */
  criticalKey: string;
  /** One-shot milestones; never becomes part of the ongoing red-set key. */
  positiveKey: string;
  /** Stable key folded into product-health's existing rising-edge/cooldown gate. */
  key: string;
  state: DepositPoolAlertState;
}

export function initialDepositPoolAlertState(): DepositPoolAlertState {
  return { firstDepositPaged: false };
}

const SHARE_PRICE_QUALIFYING_EVENTS = new Set([
  "operator_principal_contributed",
  "redeem_fulfilled",
  "venue_loss_written_off",
]);

/**
 * The deposit pool's stateful money-page conditions. PURE.
 *
 * The tombstone detector only concludes "no qualifying event" when the
 * producer says the flows read succeeded AND its stated bounded window covers
 * the two observations. A log blind spot is not proof of an attack signature.
 * Buffer-floor paging is deliberately keyed to `yieldStatus === "earning"`:
 * the ceremony flips the platform's one signal and the already-deployed board
 * starts enforcing it on the next observation.
 */
export function decideDepositPoolAlerts(input: {
  current: DepositPoolSnapshot;
  state: DepositPoolAlertState;
}): DepositPoolAlertDecision {
  const { current } = input;
  const previous = input.state.previous;
  const criticalLines: string[] = [];
  const positiveLines: string[] = [];
  const criticalKeys: string[] = [];
  const positiveKeys: string[] = [];

  if (
    previous?.pricingModel === "principal-cost-basis" &&
    current.pricingModel === "principal-cost-basis" &&
    previous.sharePriceRaw !== undefined &&
    previous.sharePriceDecimals !== undefined &&
    current.sharePrice?.decimals !== undefined &&
    !sameAmount(
      { raw: previous.sharePriceRaw, decimals: previous.sharePriceDecimals },
      current.sharePrice,
    ) &&
    windowCoversObservations(previous.blockNumber, current.block?.number, current) &&
    current.flows?.sharePriceQualifyingEvents !== undefined &&
    !hasQualifyingEventBetween(
      current.flows.sharePriceQualifyingEvents,
      previous.blockNumber,
      current.block?.number,
    )
  ) {
    criticalLines.push(
      "• 🚨 CRITICAL #1051 tombstone probe: principal-cost-basis share price moved without OperatorPrincipalContributed, RedeemFulfilled, or VenueLossWrittenOff (owner loss write-off) in the same observed window",
    );
    criticalKeys.push(
      `deposit-pool:tombstone:${previous.blockNumber ?? "?"}:${current.block?.number ?? "?"}:` +
      `${previous.sharePriceRaw}->${current.sharePrice.raw}`,
    );
  }

  const pending = current.flows?.pendingUnfulfilledRedemptionAssets;
  if (
    current.yieldStatus === "earning" &&
    current.buffer && pending &&
    compareAmounts(current.buffer, pending) < 0
  ) {
    criticalLines.push(
      "• 🔴 deposit pool buffer below pending unfulfilled redemptions while yield is earning — restore liquid coverage",
    );
    // The crossing is the alert. Do not churn the key as amounts move while it
    // remains breached; product health's cooldown owns reminders.
    criticalKeys.push("deposit-pool:buffer-floor");
  }

  const depositorCount = current.flows?.depositorCount;
  const firstDeposit =
    !input.state.firstDepositPaged &&
    previous?.depositorCount === 0 &&
    depositorCount === 1;
  if (firstDeposit) {
    positiveLines.push("• 🌱 first deposit observed — the pool has crossed from born empty to one depositor");
    positiveKeys.push("deposit-pool:first-deposit");
  }

  return {
    criticalLines,
    positiveLines,
    criticalKey: criticalKeys.join("|"),
    positiveKey: positiveKeys.join("|"),
    key: [...criticalKeys, ...positiveKeys].join("|"),
    state: {
      previous: nextObservation(previous, current),
      firstDepositPaged: input.state.firstDepositPaged || firstDeposit,
    },
  };
}

function nextObservation(
  previous: DepositPoolAlertObservation | undefined,
  current: DepositPoolSnapshot,
): DepositPoolAlertObservation {
  const next = { ...(previous ?? {}) };
  // A failed/old producer log read cannot prove whether a price movement had a
  // qualifying event. Keep the last comparable baseline so a later successful
  // bounded window can still adjudicate the movement instead of erasing it.
  if (
    current.flows?.status === "ok" &&
    current.flows.sharePriceQualifyingEvents !== undefined &&
    current.flows.window?.fromBlock !== undefined &&
    current.flows.window.toBlock !== undefined &&
    current.sharePrice?.decimals !== undefined &&
    current.block?.number !== undefined
  ) {
    next.sharePriceRaw = current.sharePrice.raw;
    next.sharePriceDecimals = current.sharePrice.decimals;
    if (current.pricingModel === undefined) delete next.pricingModel;
    else next.pricingModel = current.pricingModel;
    next.blockNumber = current.block.number;
  }
  // Likewise, an unavailable flow read must not erase the 0 needed to observe
  // the later 0→1 milestone.
  if (current.flows?.depositorCount !== undefined) {
    next.depositorCount = current.flows.depositorCount;
  }
  return next;
}

function hasQualifyingEventBetween(
  events: DepositPoolFlow[],
  previousBlock: number | undefined,
  currentBlock: number | undefined,
): boolean {
  if (previousBlock === undefined || currentBlock === undefined) return false;
  return events.some(
    (flow) =>
      SHARE_PRICE_QUALIFYING_EVENTS.has(flow.kind) &&
      flow.blockNumber !== undefined &&
      flow.blockNumber > previousBlock &&
      flow.blockNumber <= currentBlock,
  );
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

function windowCoversObservations(
  previousBlock: number | undefined,
  currentBlock: number | undefined,
  pool: DepositPoolSnapshot,
): boolean {
  if (previousBlock === undefined || currentBlock === undefined) return false;
  if (pool.flows?.status !== "ok") return false;
  const from = pool.flows.window?.fromBlock;
  const to = pool.flows.window?.toBlock;
  if (from === undefined || to === undefined) return false;
  const firstRelevantBlock = currentBlock === previousBlock ? currentBlock : previousBlock + 1;
  return from <= firstRelevantBlock && to >= currentBlock;
}

function sameAmount(a: TokenAmount, b: TokenAmount): boolean {
  return compareAmounts(a, b) === 0;
}

function compareAmounts(a: TokenAmount, b: TokenAmount): number {
  if (a.decimals === undefined || b.decimals === undefined) return Number.NaN;
  const scale = Math.max(a.decimals, b.decimals);
  const left = BigInt(a.raw) * 10n ** BigInt(scale - a.decimals);
  const right = BigInt(b.raw) * 10n ** BigInt(scale - b.decimals);
  return left < right ? -1 : left > right ? 1 : 0;
}
