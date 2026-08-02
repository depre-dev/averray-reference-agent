import { describe, expect, test } from "vitest";

import { economicsLine } from "./ops-spec.js";
import type { GasSpendView, PayoutEvidence } from "./product-health.js";

// The real 24h mainnet shape: 18 settlements, 1.80 USDC out, 1 fee credit of
// 0.05, and 1.653 DOT of gas.
const payout: PayoutEvidence = {
  status: "confirmed", detail: "", confirmedCount: 18, confirmedUsdc: 1.8,
  settledCount: 18, windowBlocks: 40000, feeCount: 1, feeUsdc: 0.05, feesSeparated: true,
};
const gas: GasSpendView = {
  totalDot: 1.6535, txCount: 83, perSettlement: 0.0995, buckets: [],
  failedDot: 0, failedCount: 0, ageMs: 0, truncated: false, otherSenders: [],
};

describe("economicsLine", () => {
  test("puts the reward, the gas and the fee revenue in one place", () => {
    // These live in three separate parts of the board today — a runway meter, a
    // footnote and a solvency pool — so the relationship has never been visible.
    const { text } = economicsLine({ payout, gas, llmMonthlyUsd: 20 });
    expect(text).toContain("0.100 USDC paid out");
    expect(text).toContain("0.0995 DOT gas");
    expect(text).toContain("0.0028 USDC fee revenue");
    expect(text).toContain("LLM $20.00/mo");
  });

  test("NEVER sums across currencies, and says why", () => {
    // Adding DOT to USDC needs a price this monitor does not have. Inventing one
    // would turn honest figures into a single confident wrong one — and it would
    // hide, because the output would look tidier than the truth.
    const { text } = economicsLine({ payout, gas });
    expect(text).toContain("not summed");
    expect(text).toContain("no price assumed");
    expect(text).not.toMatch(/total|combined|net /i);
  });

  test("a cost is a fact, not an alarm", () => {
    // The board already has a runway meter for "you are running out". Repeating
    // that urgency here would make both easier to ignore.
    expect(economicsLine({ payout, gas }).tone).toBe("awaiting");
  });
});

describe("what it does when a number is missing", () => {
  test("names what is unavailable instead of omitting it silently", () => {
    const { text } = economicsLine({ payout, gas: undefined });
    expect(text).toContain("0.100 USDC paid out");
    expect(text).toContain("gas unavailable");
  });

  test("distinguishes an unmade fee split from zero revenue", () => {
    // feesSeparated:false means we could not tell fees from payouts. Rendering
    // that as 0.0000 USDC earned would be a claim we cannot support.
    const { text } = economicsLine({ payout: { ...payout, feesSeparated: false, feeUsdc: null }, gas });
    expect(text).toContain("fee split unavailable");
    expect(text).not.toContain("0.0000 USDC fee revenue");
  });

  test("says it is not measurable rather than printing an empty row", () => {
    const { text } = economicsLine({});
    expect(text).toContain("not measurable");
    expect(text).toContain("payouts");
  });

  test("does not divide by zero settlements", () => {
    // "Infinite cost per job" is a number that means nothing.
    const { text } = economicsLine({ payout: { ...payout, confirmedCount: 0 }, gas });
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("NaN");
  });
});
