import { describe, expect, test } from "vitest";

import { economicsLine, gasPoolNote, gasUnreadableNote, payoutRunwayNote } from "./ops-spec.js";
import type { GasSpendView, PayoutEvidence, SolvencyPool } from "./product-health.js";

// Live mainnet shapes.
const gas: GasSpendView = {
  totalDot: 2.0497, txCount: 103, perSettlement: 0.0976,
  buckets: [{ label: "resolveSinglePayout", count: 21, dot: 0.866, avgDot: 0.0412, sharePct: 42.2, failed: 0 }],
  failedDot: 0, failedCount: 0, ageMs: 0, truncated: false, otherSenders: [],
};
const pool: SolvencyPool = { key: "reward_bank", label: "Reward bank", amount: 12.995, unit: "USDC", floor: 2, status: "ok" };
const payout: PayoutEvidence = {
  status: "confirmed", detail: "", confirmedCount: 20, confirmedUsdc: 3.1,
  settledCount: 20, windowBlocks: 40000, feeCount: 1, feeUsdc: 0.05, feesSeparated: true,
};

describe("gasPoolNote — what the meter above cannot say", () => {
  test("answers what is draining the pool, without repeating the balance", () => {
    // The pool row already shows amount, floor and margin. Repeating them was
    // most of what made the old strip unreadable.
    const n = gasPoolNote(gas)!;
    expect(n.text).toBe("2.050 DOT burned · 0.098 per settlement · resolveSinglePayout 42%");
    expect(n.text).not.toMatch(/floor|above|DOT\s*\/\s*\d/);
  });

  test("stays silent about age while the figures are fresh", () => {
    // "14m old" on every render is the always-true text a reader stops seeing.
    expect(gasPoolNote({ ...gas, ageMs: 14 * 60_000 })!.text).not.toContain("old");
  });

  test("says the age once it is old enough to matter", () => {
    const n = gasPoolNote({ ...gas, ageMs: 95 * 60_000 })!;
    expect(n.text).toContain("95m old");
    expect(n.tone).toBe("degraded");
  });

  test("caveats appear ONLY when they change the meaning", () => {
    expect(gasPoolNote(gas)!.tone).toBe("awaiting");
    expect(gasPoolNote({ ...gas, truncated: true })!.text).toContain("UNDERSTATED");
    expect(gasPoolNote({ ...gas, failedCount: 1, failedDot: 0.01 })!.text).toContain("REVERTED");
    expect(gasPoolNote({ ...gas, staleReason: "rpc 404" })!.text).toContain("frozen — rpc 404");
    expect(gasPoolNote({ ...gas, otherSenders: [{ address: "0xa", count: 4 }] })!.text).toContain("+1 other signer");
  });

  test("absent gas is no note at all, not a zero", () => {
    expect(gasPoolNote(undefined)).toBeNull();
  });

  test("an unreadable read is a SENTENCE, not an absence", () => {
    // A missing footnote and a failed read look identical on screen, and only
    // one of them is actionable. This is the defect that hid gas for two deploys.
    const n = gasUnreadableNote("rate limited");
    expect(n.text).toContain("gas unreadable — rate limited");
    expect(n.tone).toBe("degraded");
  });
});

describe("payoutRunwayNote — payouts, not hours", () => {
  test("counts payouts and does not repeat the meter", () => {
    // 10.995 usable / 0.155 avg = 70.
    const n = payoutRunwayNote({ pool, payout })!;
    expect(n.text).toBe("≈ 70 more payouts at 0.155 avg");
    expect(n.text).not.toContain("above floor");
  });

  test("carries the server's time note when there is one", () => {
    expect(payoutRunwayNote({ pool, payout, runwayNote: "~3d to floor" })!.text).toContain("~3d to floor");
  });

  test("below floor is red and short", () => {
    const n = payoutRunwayNote({ pool: { ...pool, amount: 1.5 }, payout })!;
    expect(n.tone).toBe("red");
    expect(n.text).toContain("BELOW FLOOR");
  });

  test("an unreadable balance produces no note rather than a wrong one", () => {
    // Coercing null to 0 would render a funded bank as exhausted.
    expect(payoutRunwayNote({ pool: { ...pool, amount: null }, payout })).toBeNull();
  });

  test("no observed average means no projection", () => {
    const n = payoutRunwayNote({ pool, payout: { ...payout, confirmedCount: 0, confirmedUsdc: 0 } })!;
    expect(n.text).toContain("cannot project");
    expect(n.text).not.toContain("Infinity");
  });

  test("a short runway warns before the floor, not at it", () => {
    expect(payoutRunwayNote({ pool: { ...pool, amount: 2.5 }, payout })!.tone).toBe("degraded");
  });
});

describe("economicsLine — the one row that stays a row", () => {
  test("three figures, no methodology on the face", () => {
    const e = economicsLine({ payout, gas })!;
    expect(e.text).toBe("PER JOB — 0.155 USDC out · 0.098 DOT gas · 0.003 USDC in");
    // The caveat that used to be the longest thing on the line is now a tooltip.
    expect(e.text).not.toContain("not summed");
    expect(e.title).toContain("no DOT price");
  });

  test("an unmade fee split is stated — it is not zero revenue", () => {
    const e = economicsLine({ payout: { ...payout, feesSeparated: false, feeUsdc: null }, gas })!;
    expect(e.text).toContain("fee split unavailable");
    expect(e.text).not.toContain("0.000 USDC in");
  });

  test("nothing measurable is no row, not an empty one", () => {
    expect(economicsLine({})).toBeNull();
  });

  test("a cost is a fact, not an alarm", () => {
    expect(economicsLine({ payout, gas })!.tone).toBe("awaiting");
  });
});
