import { describe, expect, it } from "vitest";

import { describeGasSpend, summarizeGasSpend, type GasTx } from "../../services/slack-operator/src/gas-spend.js";

const SIGNER = "0x5a6836c6d4d293f6e5377e6c28054f4171915813";
/** 1 DOT = 1e18 wei; these are realistic per-tx costs (~0.012 DOT). */
const dot = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

const tx = (over: Partial<GasTx> = {}): GasTx => ({
  from: SIGNER,
  to: "0xb1350932bf85e7ffd0599e9a3cc7b55718d89e57",
  selector: "0x38ed7cfc",
  gasWei: dot(0.012),
  success: true,
  ...over,
});

describe("summarizeGasSpend", () => {
  it("splits the burn by operation, largest first", () => {
    const s = summarizeGasSpend([
      tx({ selector: "0xaaaaaaaa", gasWei: dot(0.01) }),
      tx({ selector: "0xaaaaaaaa", gasWei: dot(0.01) }),
      tx({ selector: "0xbbbbbbbb", gasWei: dot(0.05) }),
    ]);
    expect(s.totalDot).toBeCloseTo(0.07, 6);
    expect(s.buckets.map((b) => b.selector)).toEqual(["0xbbbbbbbb", "0xaaaaaaaa"]);
    expect(s.buckets[0]!.sharePct).toBeCloseTo(71.42, 1);
  });

  it("keeps the raw selector when no name is known, rather than guessing", () => {
    // Deriving on-chain identifiers from checked-in Solidity has already been
    // wrong here — the deployed event signature had drifted from source. A
    // plausible wrong label ends the investigation; an unfamiliar hex invites it.
    const s = summarizeGasSpend([tx({ selector: "0xdeadbeef" })], { labels: { "0x38ed7cfc": "settle" } });
    expect(s.buckets[0]!.label).toBe("0xdeadbeef");
  });

  it("uses a supplied name when there is one", () => {
    const s = summarizeGasSpend([tx({ selector: "0x38ed7cfc" })], { labels: { "0x38ed7cfc": "settle" } });
    expect(s.buckets[0]!.label).toBe("settle");
  });

  it("reports the MEAN cost per call — the number a regression moves", () => {
    // Total spend rising is ambiguous: more volume, or each call got dearer.
    // The average separates them, and only one of the two is a problem.
    const s = summarizeGasSpend([
      tx({ selector: "0xaa", gasWei: dot(0.01) }),
      tx({ selector: "0xaa", gasWei: dot(0.03) }),
    ]);
    expect(s.buckets[0]!.avgDot).toBeCloseTo(0.02, 6);
  });
});

describe("reverted transactions are named, not absorbed", () => {
  it("counts gas burned by failures separately", () => {
    // A revert still costs gas and produces nothing. Folded into the totals it
    // looks like ordinary cost; called out, it is a bug with a price tag.
    const s = summarizeGasSpend([
      tx({ gasWei: dot(0.01) }),
      tx({ gasWei: dot(0.004), success: false }),
    ]);
    expect(s.failedCount).toBe(1);
    expect(s.failedDot).toBeCloseTo(0.004, 6);
    expect(s.totalDot).toBeCloseTo(0.014, 6); // still counted in the total — it was spent
    expect(s.buckets[0]!.failed).toBe(1);
  });

  it("mentions reverts in the summary ONLY when there are some", () => {
    // A permanent "0 failed" is the noise that trains someone to stop reading.
    expect(describeGasSpend(summarizeGasSpend([tx()]), 24)).not.toContain("REVERTED");
    expect(describeGasSpend(summarizeGasSpend([tx({ success: false })]), 24)).toContain("REVERTED");
  });
});

describe("unit cost", () => {
  it("expresses gas as DOT per settlement, not just a total", () => {
    // Gas as a countdown tells you when you run out. As a unit cost it can be
    // held against the 0.10 USDC a job pays.
    const s = summarizeGasSpend([tx({ gasWei: dot(0.06) }), tx({ gasWei: dot(0.04) })], { settledCount: 10 });
    expect(s.perSettlement).toBeCloseTo(0.01, 6);
    expect(describeGasSpend(s, 24)).toContain("per settlement");
  });

  it("returns null rather than dividing by zero settlements", () => {
    // "Infinite DOT per job" is a number that means nothing.
    expect(summarizeGasSpend([tx()], { settledCount: 0 }).perSettlement).toBeNull();
    expect(summarizeGasSpend([tx()], { settledCount: null }).perSettlement).toBeNull();
    expect(summarizeGasSpend([tx()]).perSettlement).toBeNull();
  });
});

describe("the signer framing", () => {
  it("flags more than one sender — the board meters ONE account", () => {
    // If the backend signs with several keys, this total is not the pool the
    // solvency panel is showing, and summing them silently would imply it is.
    const s = summarizeGasSpend([tx(), tx({ from: "0x00000000000000000000000000000000deadbeef" })]);
    expect(s.senders).toHaveLength(2);
    expect(describeGasSpend(s, 24)).toContain("not one signer");
  });

  it("says nothing about senders when there is only the one", () => {
    expect(describeGasSpend(summarizeGasSpend([tx(), tx()]), 24)).not.toContain("distinct senders");
  });
});

describe("arithmetic at 18 decimals", () => {
  it("does not lose precision on values above 2^53 wei", () => {
    // Number(wei) alone breaks here: 1 DOT is 1e18, and 2^53 is ~9.0e15.
    const s = summarizeGasSpend([tx({ gasWei: 1234567890123456789n })]);
    expect(s.totalDot).toBeCloseTo(1.234567, 5);
  });

  it("reports an empty window as empty, not as zero cost", () => {
    const s = summarizeGasSpend([]);
    expect(s.txCount).toBe(0);
    expect(s.buckets).toEqual([]);
    expect(describeGasSpend(s, 24)).toBe("no signer transactions in 24h");
  });
});
