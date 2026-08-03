import { describe, expect, test } from "vitest";

import {
  bucketPayoutsByHour,
  isHistogramUnavailable,
  type PayoutHistogram,
} from "../../src/payout-histogram.js";

/** ~2.11s/block, the rate this chain actually runs at. */
const BLOCK_SECONDS = 2.112;
const PER_HOUR = 3600 / BLOCK_SECONDS; // ~1704.5
const HEAD = 19_000_000;

function ok(v: ReturnType<typeof bucketPayoutsByHour>): PayoutHistogram {
  if (isHistogramUnavailable(v)) throw new Error(`expected a histogram, got: ${v.reason}`);
  return v;
}

describe("bucketPayoutsByHour — slices are hours of chain", () => {
  test("a payout lands in the slice its block falls in", () => {
    const h = ok(
      bucketPayoutsByHour({
        // One in the last hour, two in the hour before it.
        blocks: [HEAD - 10, HEAD - Math.floor(PER_HOUR) - 5, HEAD - Math.floor(PER_HOUR) - 900],
        latestBlock: HEAD,
        fromBlock: HEAD - Math.ceil(PER_HOUR * 24),
        blockSeconds: BLOCK_SECONDS,
      }),
    );
    expect(h.slices[0]).toMatchObject({ hoursAgo: 1, count: 1, covered: true });
    expect(h.slices[1]).toMatchObject({ hoursAgo: 2, count: 2, covered: true });
    expect(h.total).toBe(3);
    expect(h.peak).toBe(2);
  });

  test("every payout is counted exactly once across the row", () => {
    // Off-by-one at a slice boundary would either double-count or drop a
    // payout, and both are wrong on a money chart.
    const blocks = Array.from({ length: 40 }, (_, i) => HEAD - i * 900);
    const h = ok(
      bucketPayoutsByHour({
        blocks,
        latestBlock: HEAD,
        fromBlock: HEAD - Math.ceil(PER_HOUR * 24),
        blockSeconds: BLOCK_SECONDS,
      }),
    );
    expect(h.total).toBe(blocks.length);
  });

  test("24 slices, most recent first", () => {
    const h = ok(
      bucketPayoutsByHour({
        blocks: [],
        latestBlock: HEAD,
        fromBlock: HEAD - Math.ceil(PER_HOUR * 24),
        blockSeconds: BLOCK_SECONDS,
      }),
    );
    expect(h.slices).toHaveLength(24);
    expect(h.slices[0]!.hoursAgo).toBe(1);
    expect(h.slices[23]!.hoursAgo).toBe(24);
  });
});

describe("the window shape this actually runs against", () => {
  test("a lookback sized to span 24h covers all 24 slices", () => {
    // THE CASE THAT NEARLY SHIPPED WRONG. `resolvePayoutLookback` sizes the
    // window from the measured rate and rounds to whole blocks: 24h at
    // 2.112s/block is 40909.09 blocks, and the live read used 40909. Requiring
    // the slice edge to fall strictly inside that leaves the 24th hour short
    // by 0.09 of a block — so the oldest hour would have rendered as NEVER
    // OBSERVED on every single read, on a window that did cover it.
    const h = ok(
      bucketPayoutsByHour({
        blocks: [HEAD - 40_000],
        latestBlock: HEAD,
        fromBlock: HEAD - 40_909, // exactly what the live board read
        blockSeconds: BLOCK_SECONDS,
      }),
    );
    expect(h.slices.every((s) => s.covered), "all 24 hours were read").toBe(true);
    expect(h.coveredHours).toBe(24);
    expect(h.total).toBe(1);
  });

  test("a window genuinely one hour short still says so", () => {
    // The tolerance is a rounding allowance, not slack — a real gap of a full
    // hour must still report as unobserved.
    const h = ok(
      bucketPayoutsByHour({
        blocks: [],
        latestBlock: HEAD,
        fromBlock: HEAD - Math.round(PER_HOUR * 23),
        blockSeconds: BLOCK_SECONDS,
      }),
    );
    expect(h.slices[23]!.covered).toBe(false);
    expect(h.coveredHours).toBe(23);
  });
});

describe("what was never observed is not drawn as quiet", () => {
  test("slices beyond the read are covered:false, not zero-count hours", () => {
    // The lookback ceiling binding is the real case: the window is sized from
    // the measured rate, but PRODUCT_HEALTH_PAYOUT_LOOKBACK_BLOCKS can cap it
    // short, and then the old end of the row was simply never looked at.
    const h = ok(
      bucketPayoutsByHour({
        blocks: [HEAD - 10],
        latestBlock: HEAD,
        fromBlock: HEAD - Math.round(PER_HOUR * 6), // only 6h of chain read
        blockSeconds: BLOCK_SECONDS,
      }),
    );
    const covered = h.slices.filter((s) => s.covered);
    expect(covered).toHaveLength(6);
    expect(h.coveredHours).toBe(6);
    // The other 18 are unobserved — and must be distinguishable from a real 0.
    for (const s of h.slices.slice(6)) expect(s.covered).toBe(false);
  });

  test("an unobserved slice never contributes to the total or the peak", () => {
    // Otherwise a partly-read window would quietly deflate the busiest hour
    // and rescale every bar against it.
    const h = ok(
      bucketPayoutsByHour({
        blocks: [HEAD - 10, HEAD - 20],
        latestBlock: HEAD,
        fromBlock: HEAD - Math.round(PER_HOUR * 2),
        blockSeconds: BLOCK_SECONDS,
      }),
    );
    expect(h.total).toBe(2);
    expect(h.peak).toBe(2);
    expect(h.coveredHours).toBe(2);
  });

  test("a genuinely quiet covered hour IS a zero, and stays covered", () => {
    const h = ok(
      bucketPayoutsByHour({
        blocks: [HEAD - 10],
        latestBlock: HEAD,
        fromBlock: HEAD - Math.ceil(PER_HOUR * 24),
        blockSeconds: BLOCK_SECONDS,
      }),
    );
    expect(h.slices[5]).toMatchObject({ count: 0, covered: true });
  });
});

describe("no measured block time, no chart", () => {
  test("an unmeasured rate returns a reason rather than an empty row", () => {
    // An assumed block time has already been wrong here by 3x. A row bucketed
    // against a guess looks exactly like a row bucketed against a measurement.
    const v = bucketPayoutsByHour({
      blocks: [HEAD - 10],
      latestBlock: HEAD,
      fromBlock: HEAD - 40000,
      blockSeconds: null,
    });
    expect(isHistogramUnavailable(v)).toBe(true);
    expect(isHistogramUnavailable(v) && v.reason).toContain("block time not measured");
  });

  test("a nonsense rate is refused too", () => {
    for (const bad of [0, -2.1, Number.NaN]) {
      const v = bucketPayoutsByHour({
        blocks: [], latestBlock: HEAD, fromBlock: HEAD - 40000, blockSeconds: bad,
      });
      expect(isHistogramUnavailable(v), `blockSeconds ${bad} must be refused`).toBe(true);
    }
  });

  test("an unread block range returns a reason, not an empty chart", () => {
    const v = bucketPayoutsByHour({
      blocks: [], latestBlock: 0, fromBlock: 0, blockSeconds: BLOCK_SECONDS,
    });
    expect(isHistogramUnavailable(v)).toBe(true);
  });
});

describe("no payouts at all", () => {
  test("a fully-read, fully-empty day is a real row of zeroes", () => {
    // Distinct from the unavailable case above: here the instrument looked
    // across the whole window and there was genuinely nothing.
    const h = ok(
      bucketPayoutsByHour({
        blocks: [],
        latestBlock: HEAD,
        fromBlock: HEAD - Math.ceil(PER_HOUR * 24),
        blockSeconds: BLOCK_SECONDS,
      }),
    );
    expect(h.total).toBe(0);
    expect(h.peak).toBe(0);
    expect(h.coveredHours).toBe(24);
    expect(h.slices.every((s) => s.covered)).toBe(true);
  });
});
