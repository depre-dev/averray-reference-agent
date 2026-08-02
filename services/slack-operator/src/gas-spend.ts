// What the signer's gas actually went ON.
//
// The board already says signer gas is 6.10 DOT burning ~0.065 DOT/hour. That
// answers "when do I run out" and nothing about "on what" — so a change in how
// the system spends gas shows up only as the runway shortening, which reads
// identically to simply doing more work.
//
// This splits the burn by operation, which turns two different questions apart:
//   · volume went up      → cost per settlement is FLAT, spend rose. Fine.
//   · something regressed → cost per settlement ROSE. Not fine, and invisible
//     on a runway chart.
//
// ── WHAT IT REFUSES TO GUESS ────────────────────────────────────────────────
//
// Operations are identified by the call's 4-byte selector, and a selector is
// only given a NAME when one is supplied for it. An unrecognised selector is
// shown as the raw hex, never bucketed into "other" and never labelled by
// inference. This repo has already been bitten by deriving on-chain identifiers
// from checked-in Solidity that had drifted from the deployed contract; a
// plausible wrong label on a money board is worse than an unfamiliar hex string,
// because the hex invites a look and the label ends it.
//
// ── FAILED TRANSACTIONS ARE COUNTED SEPARATELY ──────────────────────────────
//
// A reverted transaction still burns gas and produces nothing. Folded into the
// totals it looks like ordinary cost; called out, it is a bug with a price tag.
//
// Pure: no RPC, no clock. The caller fetches receipts.

export interface GasTx {
  /** Sender, lowercase. Used to confirm the "signer gas" framing holds. */
  from: string;
  to: string | null;
  /** First 4 bytes of calldata, e.g. "0x38ed7cfc". "0x" for a plain transfer. */
  selector: string;
  /** gasUsed × effectiveGasPrice, in wei. */
  gasWei: bigint;
  /** False when the transaction reverted — gas spent for nothing. */
  success: boolean;
}

export interface GasBucket {
  /** A supplied name, or the raw selector when none is known. Never inferred. */
  label: string;
  selector: string;
  count: number;
  dot: number;
  /** Mean cost of one call — the number that exposes a regression. */
  avgDot: number;
  sharePct: number;
  /** Reverted calls in this bucket. Gas burned for nothing. */
  failed: number;
}

export interface GasSpend {
  totalDot: number;
  txCount: number;
  buckets: GasBucket[];
  /** Gas burned by reverted transactions. Pure waste, named as such. */
  failedDot: number;
  failedCount: number;
  /**
   * DOT per settlement — gas as a UNIT COST rather than a countdown, so it can
   * be held against the reward a job pays. null when no settlement count was
   * supplied, or when there were none: dividing by zero to get "infinite cost
   * per job" would be a number that means nothing.
   */
  perSettlement: number | null;
  /**
   * Distinct senders seen. More than one means the backend signs with several
   * keys and "signer gas" is the wrong frame for this figure — surfaced rather
   * than silently summed, because the pool on the board is ONE account.
   */
  senders: string[];
}

/** Native DOT reads as 18 decimals over eth-rpc (see the ops skill). */
export const DOT_DECIMALS = 18n;

function toDot(wei: bigint): number {
  // Divide in bigint down to micro-DOT, then convert — Number(wei) alone loses
  // precision above 2^53, and these are 18-decimal values.
  const micro = wei / 10n ** (DOT_DECIMALS - 6n);
  return Number(micro) / 1e6;
}

/**
 * Summarise gas spend by operation.
 *
 * `labels` maps selector → human name. Anything absent keeps its hex, which is
 * the honest rendering of "we know it cost this much and not what it was".
 */
export function summarizeGasSpend(
  txs: readonly GasTx[],
  options: {
    labels?: Readonly<Record<string, string>>;
    /** Settlements in the same window, for the per-job unit cost. */
    settledCount?: number | null;
  } = {},
): GasSpend {
  const labels = options.labels ?? {};
  const totalWei = txs.reduce((sum, t) => sum + t.gasWei, 0n);

  const grouped = new Map<string, { count: number; wei: bigint; failed: number }>();
  for (const tx of txs) {
    const entry = grouped.get(tx.selector) ?? { count: 0, wei: 0n, failed: 0 };
    entry.count += 1;
    entry.wei += tx.gasWei;
    if (!tx.success) entry.failed += 1;
    grouped.set(tx.selector, entry);
  }

  const buckets: GasBucket[] = [...grouped.entries()]
    .map(([selector, e]) => ({
      label: labels[selector] ?? selector,
      selector,
      count: e.count,
      dot: toDot(e.wei),
      avgDot: toDot(e.wei / BigInt(e.count)),
      sharePct: totalWei === 0n ? 0 : Number((e.wei * 10000n) / totalWei) / 100,
      failed: e.failed,
    }))
    // Largest spend first: the board has room for a few rows, and the question
    // is always "what is this going on", not "what is the full inventory".
    .sort((a, b) => b.dot - a.dot);

  const failedTxs = txs.filter((t) => !t.success);
  const settled = options.settledCount ?? null;

  return {
    totalDot: toDot(totalWei),
    txCount: txs.length,
    buckets,
    failedDot: toDot(failedTxs.reduce((s, t) => s + t.gasWei, 0n)),
    failedCount: failedTxs.length,
    perSettlement: settled != null && settled > 0 ? toDot(totalWei / BigInt(settled)) : null,
    senders: [...new Set(txs.map((t) => t.from.toLowerCase()))].sort(),
  };
}

/**
 * The one-line summary for the board.
 *
 * Leads with the total and the unit cost, because those are the two an operator
 * acts on. Reverted gas is appended only when there IS some — a permanent
 * "0 failed" is the noise that trains someone to stop reading the line.
 */
export function describeGasSpend(spend: GasSpend, windowHours: number): string {
  if (spend.txCount === 0) return `no signer transactions in ${windowHours}h`;
  const parts = [`${spend.totalDot.toFixed(4)} DOT over ${spend.txCount} txs (${windowHours}h)`];
  if (spend.perSettlement != null) parts.push(`${spend.perSettlement.toFixed(5)} DOT per settlement`);
  if (spend.failedCount > 0) {
    parts.push(`${spend.failedDot.toFixed(4)} DOT burned by ${spend.failedCount} REVERTED tx${spend.failedCount === 1 ? "" : "s"}`);
  }
  // Several signing keys means this total is not "the signer pool" the board
  // meters. Say so rather than letting the two be read as the same account.
  if (spend.senders.length > 1) parts.push(`${spend.senders.length} distinct senders — not one signer`);
  return parts.join(" · ");
}
