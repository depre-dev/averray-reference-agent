// Confirmed on-chain payouts, sliced into hours.
//
// ── WHOSE NUMBER THIS IS ───────────────────────────────────────────────────
//
// These buckets are built from `ReservationSettled` LOGS — the same
// independent read that corroborates the funnel, not the monitor's own
// settled count. That distinction is the entire value of the row: a chart
// drawn from the product's own ledger would agree with the funnel by
// construction and could never show the thing worth seeing.
//
// So it must never be labelled "settled". It is "confirmed on-chain", and the
// caller is responsible for saying so.
//
// ── SLICES ARE RELATIVE TO NOW, NOT TO THE CLOCK ───────────────────────────
//
// Each slice is exactly one hour of blocks, counting back from the head. That
// avoids the partial-hour problem that wall-clock alignment creates: aligned
// to UTC, the newest bucket is however many minutes into the current hour, and
// it renders as a collapse in throughput every hour, on the hour, forever.
//
// A relative slice is always a whole hour of chain, so a short bar means a
// short hour.
//
// ── PARTIAL MEANS NOT OBSERVED, AND IS NEVER DRAWN AS QUIET ────────────────
//
// The one real partiality is at the far end: if the log read did not reach
// back far enough to cover a slice, that slice has no observation behind it. A
// bucket the instrument never looked at, drawn as a short bar, is the same lie
// as an absent number drawn as zero — and this board has shipped that lie
// before. Those slices carry `covered: false`, and the renderer must show them
// as unobserved rather than as low.
//
// ── AND WITHOUT A MEASURED BLOCK TIME, NOTHING ─────────────────────────────
//
// Every block-to-time mapping here rests on the measured seconds-per-block. An
// assumed one has already been wrong in production by 3x. If it was not
// measured, this returns a reason instead of a chart: no row at all is honest,
// a row bucketed against a guess is not.

/** One hour of chain, counting back from the head. */
export interface HourSlice {
  /** 1 = the most recent hour, ascending into the past. */
  hoursAgo: number;
  /** Confirmed payouts whose log landed in this slice. */
  count: number;
  /**
   * Whether the log read actually reached this far back. False means NOT
   * OBSERVED — the count is 0 because nobody looked, which is a different
   * fact from a quiet hour and must not render as one.
   */
  covered: boolean;
}

export interface PayoutHistogram {
  /** Most recent hour first. */
  slices: HourSlice[];
  /** Payouts across the covered slices only. */
  total: number;
  /** Busiest covered slice, for scaling the bars. 0 when nothing landed. */
  peak: number;
  /** Whole hours the read actually covered. */
  coveredHours: number;
  /** Blocks in an hour at the measured rate — the basis for every slice. */
  blocksPerHour: number;
}

export interface HistogramUnavailable {
  /** Why there is no chart. Rendered as a sentence, never as an empty chart. */
  reason: string;
}

export function isHistogramUnavailable(
  v: PayoutHistogram | HistogramUnavailable,
): v is HistogramUnavailable {
  return (v as HistogramUnavailable).reason !== undefined;
}

/** Hours the row shows. One day, to match the window everything else uses. */
export const HISTOGRAM_HOURS = 24;

export function bucketPayoutsByHour(input: {
  /**
   * Block number of each CONFIRMED PAYOUT. Fee settlements must already be
   * excluded by the caller — they are revenue, and a revenue credit drawn in
   * the payout row would overstate throughput on exactly the fee-bearing jobs
   * the external funnel cares about.
   */
  blocks: readonly number[];
  /** Head of the chain at read time. */
  latestBlock: number;
  /** Oldest block the read covered. */
  fromBlock: number;
  /** MEASURED seconds per block. Null means no chart. */
  blockSeconds: number | null;
  hours?: number;
}): PayoutHistogram | HistogramUnavailable {
  const hours = input.hours ?? HISTOGRAM_HOURS;
  if (input.blockSeconds == null || !(input.blockSeconds > 0)) {
    return { reason: "block time not measured — hours cannot be derived from block numbers" };
  }
  if (!(input.latestBlock > 0) || input.fromBlock > input.latestBlock) {
    return { reason: "block range not read — nothing to slice" };
  }

  const blocksPerHour = 3600 / input.blockSeconds;
  const slices: HourSlice[] = [];
  for (let i = 0; i < hours; i += 1) {
    // Slice i covers (head - (i+1) * blocksPerHour, head - i * blocksPerHour].
    const newest = input.latestBlock - i * blocksPerHour;
    const oldest = input.latestBlock - (i + 1) * blocksPerHour;
    // Covered when the read reached the OLDEST block of the slice. A slice the
    // read only half-covers is still a slice we cannot count honestly.
    //
    // The one-block tolerance is not slack, it is a rounding artifact. Slice
    // edges are fractional (1704.5454… blocks to the hour) and a block range
    // is integral, so a lookback sized to span exactly 24h lands 0.09 of a
    // block short of the 24th slice — and without this the oldest hour would
    // render as NEVER OBSERVED on every read, forever, on a window that in
    // fact covered it. That is the same class of error as a false zero, just
    // pointed the other way: it makes the instrument look blinder than it is.
    const covered = oldest >= input.fromBlock - 1;
    const count = covered
      ? input.blocks.filter((b) => b > oldest && b <= newest).length
      : 0;
    slices.push({ hoursAgo: i + 1, count, covered });
  }

  const coveredSlices = slices.filter((s) => s.covered);
  return {
    slices,
    total: coveredSlices.reduce((a, s) => a + s.count, 0),
    peak: coveredSlices.reduce((a, s) => Math.max(a, s.count), 0),
    // Counted from the slices rather than recomputed from the block span, so
    // the headline can never disagree with the bars underneath it. Computing
    // it independently reintroduced the same fractional-block rounding and had
    // it reporting one hour fewer than the row actually drew.
    coveredHours: coveredSlices.length,
    blocksPerHour,
  };
}
