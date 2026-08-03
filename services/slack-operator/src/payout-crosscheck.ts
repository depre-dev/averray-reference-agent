// Is the payout proof one endpoint's opinion?
//
// The evidence panel is the board's strongest claim: an INDEPENDENT on-chain
// read that can contradict the product's own ledger. But "independent" has
// meant "whatever RPC the monitor happened to be pointed at", and one week
// produced three separate endpoint-lens surprises — WSS 1006s on the default
// host, native accounts invisible to the EVM lens, an Erc20 ledger split.
//
// Proof without provenance is one endpoint's opinion. This compares the same
// window against a second, different provider.
//
// ── DISAGREEMENT IS A THIRD KIND OF FAULT ──────────────────────────────────
//
// The panel already separates two: SHORTFALL (we can see, and money is
// missing) and UNVERIFIED (we cannot see — the instrument is broken, the
// money may be fine). Endpoints disagreeing is neither. It means the
// instrument is unreliable, which SUSPENDS the comparison rather than
// resolving it either way — including suspending a shortfall, because a
// shortfall measured by an instrument two providers cannot agree on is not
// evidence about money.
//
// ── COMPARE BEHIND THE HEAD, OR MANUFACTURE FALSE ALARMS ───────────────────
//
// Two honest endpoints legitimately disagree at the tip: they see different
// pending blocks, and one may be a block or two behind. Comparing "the last
// N blocks" on each would produce a disagreement most times it ran, and an
// alarm that is usually wrong is one the operator learns to ignore — the
// exact failure this board keeps having to fix.
//
// So the comparison runs over a range PINNED on both sides and ending well
// behind the head. `SAFE_HEAD_LAG_BLOCKS` is that margin.
//
// ── A TICK MUST NEVER AGE SILENTLY ─────────────────────────────────────────
//
// "cross-checked ✓" with no date is indistinguishable from a check that
// stopped running months ago. Every state carries its age, and an agreement
// older than the budget reports `overdue` — the check being broken is itself
// a finding, not an absence.

/** How far behind the head the compared range ends. ~7 min at 2.1s/block. */
export const SAFE_HEAD_LAG_BLOCKS = 200;

/** Past this, the last agreement is too old to still be reassuring. */
export const CROSSCHECK_OVERDUE_MS = 10 * 24 * 60 * 60 * 1000;

export type CrossCheckStatus =
  /** Both endpoints read the same range and got the same count. */
  | "agree"
  /** Both read it and got different counts — the instrument is unreliable. */
  | "disagree"
  /** The second endpoint could not be read. Not evidence either way. */
  | "unavailable"
  /** No second endpoint is configured. Nobody asked for this; not a fault. */
  | "not-configured"
  /** Configured, but no comparison has completed yet. */
  | "never-run";

export interface CrossCheckView {
  status: CrossCheckStatus;
  /** One sentence, naming both endpoints and both counts when they differ. */
  detail: string;
  /** True when the last AGREEMENT is older than the budget, or never happened. */
  overdue: boolean;
  /** Epoch ms of the last agreement, for rendering its age. */
  lastAgreedAtMs: number | null;
}

export interface EndpointReading {
  host: string;
  /** Payouts counted over the pinned range. Null means the read failed. */
  count: number | null;
}

export function decideCrossCheck(input: {
  /** A second RPC URL was configured. */
  configured: boolean;
  primary: EndpointReading | null;
  secondary: EndpointReading | null;
  /** Why the secondary read failed, when it did. */
  secondaryReason?: string | null;
  /** The pinned range both endpoints were asked about. */
  range?: { fromBlock: number; toBlock: number } | null;
  lastAgreedAtMs: number | null;
  nowMs: number;
  overdueAfterMs?: number;
}): CrossCheckView {
  const budget = input.overdueAfterMs ?? CROSSCHECK_OVERDUE_MS;
  const agedOut =
    input.lastAgreedAtMs === null || input.nowMs - input.lastAgreedAtMs > budget;

  if (!input.configured) {
    // Deliberately NOT overdue. A check nobody enabled is not a check that
    // broke, and rendering it as one puts a permanent amber on the panel.
    return {
      status: "not-configured",
      detail:
        "no second endpoint configured — this proof rests on one provider (set PRODUCT_HEALTH_PAYOUT_CROSSCHECK_RPC_URL)",
      overdue: false,
      lastAgreedAtMs: null,
    };
  }

  const range = input.range
    ? ` over blocks ${input.range.fromBlock.toLocaleString()}–${input.range.toBlock.toLocaleString()}`
    : "";

  if (input.secondaryReason || input.secondary?.count == null) {
    const why = input.secondaryReason ?? "second endpoint returned no count";
    return {
      status: "unavailable",
      detail: `cross-check could not run — ${why}`,
      // An unreadable second endpoint does not reset the clock: if the last
      // real agreement has aged out, the panel is overdue whatever the reason.
      overdue: agedOut,
      lastAgreedAtMs: input.lastAgreedAtMs,
    };
  }

  if (input.primary?.count == null) {
    return {
      status: "unavailable",
      detail: "cross-check could not run — the primary read produced no count to compare",
      overdue: agedOut,
      lastAgreedAtMs: input.lastAgreedAtMs,
    };
  }

  if (input.primary.count !== input.secondary.count) {
    // Name both, or the alarm has no next step.
    return {
      status: "disagree",
      detail:
        `${input.primary.host} reads ${input.primary.count} · ` +
        `${input.secondary.host} reads ${input.secondary.count}${range} — ` +
        "same range, two answers: the payout instrument is not reliable until this is resolved",
      overdue: false,
      lastAgreedAtMs: input.lastAgreedAtMs,
    };
  }

  return {
    status: "agree",
    detail: `${input.primary.host} and ${input.secondary.host} agree on ${input.primary.count}${range}`,
    overdue: false,
    lastAgreedAtMs: input.nowMs,
  };
}

/**
 * Configured but never completed — distinct from a passing check.
 *
 * Split out because the caller reaches this before any comparison has run,
 * and "no result yet" must not borrow the wording of an agreement.
 */
export function crossCheckNeverRun(configured: boolean): CrossCheckView {
  if (!configured) {
    return decideCrossCheck({
      configured: false, primary: null, secondary: null, lastAgreedAtMs: null, nowMs: 0,
    });
  }
  return {
    status: "never-run",
    detail: "cross-check configured but has not completed a comparison yet",
    overdue: false,
    lastAgreedAtMs: null,
  };
}

/**
 * The range both endpoints are asked about.
 *
 * Ends `SAFE_HEAD_LAG_BLOCKS` behind the head so tip disagreement — which is
 * normal and says nothing about the instrument — cannot register as a finding.
 * Returns null when the head is too shallow to leave that margin.
 */
export function pinnedCompareRange(input: {
  latestBlock: number;
  lookbackBlocks: number;
  headLag?: number;
}): { fromBlock: number; toBlock: number } | null {
  const lag = input.headLag ?? SAFE_HEAD_LAG_BLOCKS;
  const toBlock = input.latestBlock - lag;
  if (!(toBlock > 0)) return null;
  const fromBlock = Math.max(0, toBlock - input.lookbackBlocks);
  if (fromBlock >= toBlock) return null;
  return { fromBlock, toBlock };
}

/**
 * Host only — never the full URL.
 *
 * Provider URLs carry API keys in the path or query often enough that echoing
 * one onto a screen (or into a screenshot, or a Buzz message) is a credential
 * leak. The host is the whole of what the provenance line needs to say.
 */
export function endpointHost(url: string | null | undefined): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}
