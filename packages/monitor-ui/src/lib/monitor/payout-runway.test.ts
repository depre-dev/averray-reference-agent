import { describe, expect, test } from "vitest";

import { payoutRunwayLine } from "./ops-spec.js";
import type { PayoutEvidence, SolvencyPool } from "./product-health.js";

// Live mainnet: reward bank 13.79 USDC against a 2.00 floor, 18 payouts
// totalling 1.80 USDC (so 0.100 each).
const pool: SolvencyPool = {
  key: "reward_bank", label: "Reward bank", amount: 13.79, unit: "USDC", floor: 2, status: "ok",
};
const payout: PayoutEvidence = {
  status: "confirmed", detail: "", confirmedCount: 18, confirmedUsdc: 1.8,
  settledCount: 18, windowBlocks: 40000,
};

describe("payoutRunwayLine", () => {
  test("counts PAYOUTS, not hours", () => {
    // 11.79 usable / 0.100 average = 117. Hours would go stale the moment the
    // pipeline pauses; a payout count stays true.
    const { text } = payoutRunwayLine({ pool, payout });
    expect(text).toContain("≈ 117 more payouts");
    expect(text).toContain("11.79 USDC above floor");
  });

  test("states the sample the average came from", () => {
    // A projection from 2 payouts and one from 50 must not read identically.
    expect(payoutRunwayLine({ pool, payout }).text).toContain("from 18 payouts");
  });

  test("carries the server's time note when there is one", () => {
    // It was being computed and rendered nowhere.
    const { text } = payoutRunwayLine({ pool, payout, runwayNote: "~3d to floor" });
    expect(text).toContain("~3d to floor");
  });
});

describe("what it refuses to project", () => {
  test("an unreadable balance is not an empty one", () => {
    // Coercing null to 0 would render a funded bank as exhausted — the alarm
    // that costs most to get wrong.
    const { text, tone } = payoutRunwayLine({ pool: { ...pool, amount: null }, payout });
    expect(text).toContain("unreadable");
    expect(tone).not.toBe("red");
  });

  test("no observed average means no projection, but still says what is spendable", () => {
    const { text } = payoutRunwayLine({ pool, payout: { ...payout, confirmedCount: 0, confirmedUsdc: 0 } });
    expect(text).toContain("no payout average yet");
    expect(text).toContain("11.79 USDC above floor");
    expect(text).not.toContain("Infinity");
  });

  test("says nothing rather than inventing a pool that was not reported", () => {
    expect(payoutRunwayLine({ pool: undefined, payout }).text).toContain("not reported");
  });
});

describe("the alarm", () => {
  test("below floor is red and states both numbers", () => {
    const { text, tone } = payoutRunwayLine({ pool: { ...pool, amount: 1.5 }, payout });
    expect(tone).toBe("red");
    expect(text).toContain("BELOW FLOOR");
    expect(text).toContain("1.50 / 2.00 USDC");
  });

  test("a short runway tones amber before it breaches", () => {
    // The point of a runway: act before the floor, not at it.
    const { tone } = payoutRunwayLine({ pool: { ...pool, amount: 2.4 }, payout });
    expect(tone).toBe("degraded");
  });

  test("a comfortable runway is not an alarm", () => {
    expect(payoutRunwayLine({ pool, payout }).tone).toBe("awaiting");
  });
});
