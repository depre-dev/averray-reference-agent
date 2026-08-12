import { describe, expect, it } from "vitest";

import { alertProvenance, decideMoneyAlert } from "../../services/slack-operator/src/money-alert.js";
import type { ProductHealthSnapshotBlocks } from "../../services/slack-operator/src/product-health.js";

function snap(
  payout?: Record<string, unknown>,
  self?: Record<string, unknown>,
  rewardBank?: { amount: number | null; floor?: number | null },
): ProductHealthSnapshotBlocks {
  return {
    chainId: 420420419,
    ...(self ? { self: self as never } : {}),
    ...(rewardBank
      ? {
          solvency: {
            pools: [{
              key: "reward_bank",
              label: "Reward bank",
              unit: "USDC",
              status: "red",
              ...rewardBank,
            }],
          },
        }
      : {}),
    ...(payout
      ? { flow: { settled24h: 14, payout: payout as never } }
      : {}),
  } as ProductHealthSnapshotBlocks;
}

describe("decideMoneyAlert", () => {
  it("a real SHORTFALL pages, with the gap as the dedup key", () => {
    const r = decideMoneyAlert(snap({
      status: "shortfall", detail: "14 jobs marked settled but only 2 payouts confirmed on-chain (0.20 USDC) — 12 unaccounted for",
      settledCount: 14, confirmedCount: 2,
    }));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain("payout shortfall");
    expect(r.key).toBe("payout:12");
  });

  // THE RULE THAT MATTERS. "unverified" means the instrument is in doubt — a
  // drifted topic, a throttled RPC, a window that doesn't span the comparison.
  // Paging on it reports our own blind spot as a money failure.
  it("NEVER pages on unverified — that is our blind spot, not lost money", () => {
    for (const detail of [
      "no payout events found on the configured payout contract while 14 jobs are marked settled",
      "cannot compare: window spans ~8.4h at a measured 2.11s/block, not the 24h it is compared against",
      "payout evidence unverified — log read failed (HTTP 429)",
    ]) {
      const r = decideMoneyAlert(snap({ status: "unverified", detail, settledCount: 14, confirmedCount: null }));
      expect(r.lines).toEqual([]);
      expect(r.key).toBe("");
    }
  });

  it("a confirmed payout is silence, not a page", () => {
    expect(decideMoneyAlert(snap({ status: "confirmed", detail: "14 payouts confirmed", settledCount: 14, confirmedCount: 14 })))
      .toEqual({ lines: [], key: "" });
  });

  it("no snapshot, and no flow block, are both silence", () => {
    expect(decideMoneyAlert(undefined)).toEqual({ lines: [], key: "" });
    expect(decideMoneyAlert(snap())).toEqual({ lines: [], key: "" });
  });

  // The detail line carries USDC totals that move every cycle; keying on it
  // would re-page on noise while the underlying problem is unchanged.
  it("the key tracks the GAP, so a drifting USDC total does not re-page", () => {
    const a = decideMoneyAlert(snap({ status: "shortfall", detail: "… 0.20 USDC …", settledCount: 14, confirmedCount: 2 }));
    const b = decideMoneyAlert(snap({ status: "shortfall", detail: "… 0.30 USDC …", settledCount: 14, confirmedCount: 2 }));
    expect(a.key).toBe(b.key);
  });

  it("but a WORSENING gap re-pages", () => {
    const a = decideMoneyAlert(snap({ status: "shortfall", detail: "d", settledCount: 14, confirmedCount: 2 }));
    const b = decideMoneyAlert(snap({ status: "shortfall", detail: "d", settledCount: 20, confirmedCount: 2 }));
    expect(a.key).not.toBe(b.key);
  });

  it("an unknowable gap still pages rather than being swallowed", () => {
    const r = decideMoneyAlert(snap({ status: "shortfall", detail: "d", settledCount: null, confirmedCount: null }));
    expect(r.lines).toHaveLength(1);
    expect(r.key).toBe("payout:unknown");
  });

  it("pages when the authoritative reward-bank liquid balance breaches its floor", () => {
    const r = decideMoneyAlert(snap(undefined, undefined, { amount: 0.32, floor: 2 }));
    expect(r.lines).toEqual([
      "• 🏦 reward bank floor breached: 0.32 USDC liquid < 2.00 USDC floor — operator top-up required; no automatic refill",
    ]);
    expect(r.key).toBe("reward-bank:below:2");
  });

  it("does not page at the floor, without a floor, or when liquid is unreadable", () => {
    expect(decideMoneyAlert(snap(undefined, undefined, { amount: 2, floor: 2 })))
      .toEqual({ lines: [], key: "" });
    expect(decideMoneyAlert(snap(undefined, undefined, { amount: 0.32, floor: null })))
      .toEqual({ lines: [], key: "" });
    expect(decideMoneyAlert(snap(undefined, undefined, { amount: null, floor: 2 })))
      .toEqual({ lines: [], key: "" });
  });

  it("keeps the floor-breach key stable as liquid drains, while a floor change re-pages", () => {
    const first = decideMoneyAlert(snap(undefined, undefined, { amount: 0.32, floor: 2 }));
    const lower = decideMoneyAlert(snap(undefined, undefined, { amount: 0.12, floor: 2 }));
    const newFloor = decideMoneyAlert(snap(undefined, undefined, { amount: 0.12, floor: 3 }));
    expect(lower.key).toBe(first.key);
    expect(newFloor.key).not.toBe(first.key);
  });

  it("combines simultaneous reward-bank and payout failures into one money page", () => {
    const r = decideMoneyAlert(snap(
      { status: "shortfall", detail: "2 payouts missing", settledCount: 14, confirmedCount: 12 },
      undefined,
      { amount: 0.32, floor: 2 },
    ));
    expect(r.lines).toHaveLength(2);
    expect(r.key).toBe("reward-bank:below:2|payout:2");
  });
});

describe("alertProvenance", () => {
  it("a stale monitor WARNS that the alert may describe old code", () => {
    const p = alertProvenance(snap(undefined, { status: "behind", runningSha: "824ae4c1f2d3", behindBy: 9 }));
    expect(p).toContain("9 commits behind main");
    expect(p).toContain("may describe stale code");
    expect(p).toContain("824ae4c1");
  });

  it("a current monitor just names its build", () => {
    expect(alertProvenance(snap(undefined, { status: "current", runningSha: "865942ef86220930", behindBy: 0 })))
      .toBe("monitor 865942ef");
  });

  it("an unknown version says it cannot confirm — never implies current", () => {
    const p = alertProvenance(snap(undefined, { status: "unknown", runningSha: null, behindBy: null }));
    expect(p).toContain("cannot confirm");
    expect(p).not.toContain("up to date");
  });

  it("no self block yields no footer rather than a fabricated one", () => {
    expect(alertProvenance(snap())).toBeUndefined();
    expect(alertProvenance(undefined)).toBeUndefined();
  });
});
