import { describe, expect, it } from "vitest";

import { formatDuration, summarizeLifecycle, type LifecycleJob } from "../../services/slack-operator/src/job-lifecycle.js";

const BS = 2.112; // measured mainnet seconds per block
const job = (postedBlock: number, settledBlock: number, feeBearing = false): LifecycleJob =>
  ({ postedBlock, settledBlock, feeBearing });

describe("summarizeLifecycle", () => {
  it("splits self-posted from external instead of blending them", () => {
    // THE REASON THIS IS SPLIT. Real mainnet spans: pipeline jobs settle in ~9
    // blocks, external bounties in 3,439 and 33,822. One median over that
    // population moves with the MIX, so a day with more dogfood would look like
    // the system got faster.
    const s = summarizeLifecycle({
      jobs: [job(100, 109), job(200, 209), job(300, 3739, true), job(400, 34222, true)],
      blockSeconds: BS,
    })!;
    expect(s.selfPosted.count).toBe(2);
    expect(s.selfPosted.medianSeconds).toBe(19);
    expect(s.external.count).toBe(2);
    expect(s.external.medianSeconds).toBeGreaterThan(7000);
  });

  it("reports the external share — the demand-mix answer", () => {
    const s = summarizeLifecycle({ jobs: [job(1, 2), job(3, 4), job(5, 6), job(7, 8, true)], blockSeconds: BS })!;
    expect(s.externalPct).toBe(25);
  });

  it("shows the SLOWEST beside the median", () => {
    // A median of 20s with a slowest of 20h is a different system from one where
    // both are 20s, and only one of them loses workers. The median alone hides
    // exactly the case that made someone give up.
    const s = summarizeLifecycle({ jobs: [job(1, 10), job(2, 11), job(3, 34000)], blockSeconds: BS })!;
    expect(s.selfPosted.medianSeconds).toBe(19);
    expect(s.selfPosted.slowestSeconds).toBeGreaterThan(70000);
  });

  it("counts jobs it CANNOT time rather than timing them wrongly", () => {
    // A job that looks 10 minutes old because the window began 10 minutes ago is
    // the kind of wrong number that makes a latency figure worthless.
    const s = summarizeLifecycle({ jobs: [job(1, 10)], blockSeconds: BS, unmeasurable: 4 })!;
    expect(s.unmeasurable).toBe(4);
  });

  it("returns NOTHING without a measured block time", () => {
    // Every duration would be a guess, and this codebase already shipped one
    // number derived from an assumed 6s/block.
    for (const bad of [null, 0, -1, Number.NaN]) {
      expect(summarizeLifecycle({ jobs: [job(1, 10)], blockSeconds: bad })).toBeNull();
    }
  });

  it("an empty window is empty, not zero-latency", () => {
    const s = summarizeLifecycle({ jobs: [], blockSeconds: BS })!;
    expect(s.selfPosted.medianSeconds).toBeNull();
    expect(s.external.medianSeconds).toBeNull();
    expect(s.externalPct).toBeNull();
  });

  it("takes an even-length median from both middle values", () => {
    const s = summarizeLifecycle({ jobs: [job(0, 10), job(0, 20)], blockSeconds: 1 })!;
    expect(s.selfPosted.medianSeconds).toBe(15);
  });
});

describe("formatDuration", () => {
  it("reads without converting", () => {
    expect(formatDuration(19)).toBe("19s");
    expect(formatDuration(600)).toBe("10m");
    expect(formatDuration(8040)).toBe("2h 14m");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(71280)).toBe("19h 48m");
    expect(formatDuration(432000)).toBe("5d");
  });

  it("renders an absent duration as absent, not as zero", () => {
    expect(formatDuration(null)).toBe("—");
  });
});
