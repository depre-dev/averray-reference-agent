import { describe, expect, test } from "vitest";

import { gasLine, type GasSpendView } from "./ops-spec.js";

const base: GasSpendView = {
  totalDot: 1.6535, txCount: 83, perSettlement: 0.0995,
  buckets: [
    { label: "resolveSinglePayout", count: 17, dot: 0.7007, avgDot: 0.0412, sharePct: 42.4, failed: 0 },
    { label: "createSinglePayoutJobFeeWaived", count: 16, dot: 0.54, avgDot: 0.0338, sharePct: 32.7, failed: 0 },
  ],
  failedDot: 0, failedCount: 0, ageMs: 0, truncated: false, otherSenders: [],
};

describe("gasLine", () => {
  test("leads with the unit cost, not just the total", () => {
    // Gas as a total can only be compared with yesterday's total. As a unit
    // cost it can be held against the 0.10 USDC a job pays.
    const { text } = gasLine(base, 0);
    expect(text).toContain("0.0995 DOT per settlement");
    expect(text).toContain("resolveSinglePayout 42%");
  });

  test("absent is NOT zero", () => {
    // "0 DOT" reads as free. Before the first read there is nothing to say.
    expect(gasLine(undefined, 0).text).toBe("GAS — not measured");
    expect(gasLine(undefined, 0).tone).toBe("awaiting");
  });

  test("an empty window says so rather than reporting zero cost", () => {
    expect(gasLine({ ...base, txCount: 0 }, 0).text).toContain("no signer transactions");
  });

  test("cost alone is a fact, not an alarm", () => {
    // Spending money is what the system does. Only something WRONG tones amber.
    expect(gasLine(base, 0).tone).toBe("awaiting");
  });
});

describe("every caveat that would make the number wrong is stated", () => {
  test("reverted gas is named — it bought nothing", () => {
    const v = gasLine({ ...base, failedCount: 2, failedDot: 0.03 }, 0);
    expect(v.text).toContain("0.030 DOT REVERTED");
    expect(v.tone).toBe("degraded");
  });

  test("says nothing about reverts when there are none", () => {
    // A permanent "0 failed" trains a reader to skip the line.
    expect(gasLine(base, 0).text).not.toContain("REVERTED");
  });

  test("a capped read says the total is UNDERSTATED", () => {
    // Understating spend on a board that warns about running out is the wrong
    // direction to be wrong in.
    const v = gasLine({ ...base, truncated: true }, 0);
    expect(v.text).toContain("UNDERSTATED");
    expect(v.tone).toBe("degraded");
  });

  test("names other signing keys as not counted", () => {
    // Mainnet has a second sender. Its gas never left the pool the solvency
    // panel meters, so it is excluded — but excluding it silently would imply
    // this is the whole cost of running the system.
    const v = gasLine({ ...base, otherSenders: [{ address: "0x089a", count: 4 }] }, 0);
    expect(v.text).toContain("+1 other signer not counted");
  });

  test("a frozen reader says why, and outranks the age", () => {
    const v = gasLine({ ...base, ageMs: 3_600_000, staleReason: "rpc 404" }, 0);
    expect(v.text).toContain("figures frozen — rpc 404");
    expect(v.text).not.toContain("60m old");
    expect(v.tone).toBe("degraded");
  });

  test("otherwise discloses the age", () => {
    // A 40-minute-old breakdown is useful; presented as current it is a lie.
    expect(gasLine({ ...base, ageMs: 2_400_000 }, 0).text).toContain("40m old");
  });
});
