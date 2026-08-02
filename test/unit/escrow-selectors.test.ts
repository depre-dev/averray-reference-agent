import { describe, expect, it } from "vitest";

import {
  ESCROW_V2_ABI_SHA256,
  ESCROW_V2_ADDRESS,
  ESCROW_V2_SELECTORS,
  OBSERVED_SELECTORS,
} from "../../services/slack-operator/src/escrow-selectors.js";
import { summarizeGasSpend, type GasTx } from "../../services/slack-operator/src/gas-spend.js";

describe("the selector map", () => {
  it("covers every selector seen in live traffic", () => {
    // An unlisted selector renders as raw hex, which is honest but useless. If
    // traffic contains one we have not named, that is the signal to go look.
    for (const sel of OBSERVED_SELECTORS) {
      expect(ESCROW_V2_SELECTORS[sel], `${sel} has no name`).toBeTruthy();
    }
  });

  it("uses lowercase 0x-prefixed keys, as the RPC returns them", () => {
    // calldata arrives lowercase; a checksummed or bare key silently never
    // matches and every operation quietly renders as hex.
    for (const key of Object.keys(ESCROW_V2_SELECTORS)) {
      expect(key).toMatch(/^0x[0-9a-f]{8}$/);
    }
  });

  it("pins the provenance the names depend on", () => {
    // These names come from a frozen ABI, not from contracts/EscrowCore.sol in
    // this repo — which describes a DIFFERENT contract. If the deployment or
    // the ABI changes, the names must be re-verified, and this is what makes
    // that check possible rather than a matter of memory.
    expect(ESCROW_V2_ADDRESS).toBe("0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC");
    expect(ESCROW_V2_ABI_SHA256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("the map feeding the breakdown", () => {
  const tx = (selector: string, dot: number): GasTx => ({
    from: "0x5a6836c6d4d293f6e5377e6c28054f4171915813",
    to: "0x590ebe304e0c7672e2abf3161177d2b94a2ac3fc",
    selector,
    gasWei: BigInt(Math.round(dot * 1e6)) * 10n ** 12n,
    success: true,
  });

  it("names the live operations and leaves an unknown one as hex", () => {
    // The real 24h shape: resolve is the most expensive, and the pipeline
    // creates jobs with the fee waived.
    const spend = summarizeGasSpend(
      [tx("0xb08c763e", 0.0412), tx("0xbcb2689a", 0.0338), tx("0xfeedface", 0.001)],
      { labels: ESCROW_V2_SELECTORS, settledCount: 1 },
    );
    expect(spend.buckets[0]!.label).toBe("resolveSinglePayout");
    expect(spend.buckets[1]!.label).toBe("createSinglePayoutJobFeeWaived");
    expect(spend.buckets[2]!.label).toBe("0xfeedface");
  });

  it("reproduces the observed per-job cost against a 0.10 USDC reward", () => {
    // The number the whole exercise was for: gas as a unit cost, not a
    // countdown. ~0.097 DOT of gas to deliver a job paying 0.10 USDC.
    const oneJob = [
      tx("0xcca2acd6", 0.0046), tx("0xbcb2689a", 0.0338), tx("0x090cf6d5", 0.0149),
      tx("0x1b2ef921", 0.0050), tx("0xb08c763e", 0.0412),
    ];
    const spend = summarizeGasSpend(oneJob, { labels: ESCROW_V2_SELECTORS, settledCount: 1 });
    expect(spend.perSettlement).toBeCloseTo(0.0995, 3);
    expect(spend.buckets).toHaveLength(5);
  });
});
