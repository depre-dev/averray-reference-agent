import { describe, expect, it } from "vitest";

import {
  depositPoolUrlFromBankFeed,
  normalizeDepositPoolFeed,
  readDepositPoolFeed,
} from "../../services/slack-operator/src/deposit-pool-feed.js";
import { loadProductHealthConfig } from "../../services/slack-operator/src/product-health.js";

const amount = (raw: string) => ({ raw, decimals: 6 });

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    available: true,
    pool: "0x1111111111111111111111111111111111111111",
    asset: "0x2222222222222222222222222222222222222222",
    block: { number: 101, hash: "0xabc", timestamp: 1_786_000_000 },
    pricingModel: "principal-cost-basis",
    totalAssets: amount("1500000"),
    totalShares: amount("1000000"),
    sharePrice: amount("1500000"),
    buffer: amount("500000"),
    deployed: amount("1000000"),
    reconciled: true,
    reconciliation: {
      equation: "buffer + deployed = totalAssets",
      accountedRaw: "1500000",
      differenceRaw: "0",
    },
    caps: {
      totalAssetCap: amount("10000000"),
      perAgentAssetCap: amount("2000000"),
      headroom: amount("8500000"),
      utilizationBps: "1500",
    },
    yieldStatus: "not_yet_earning",
    yieldStatusText: "Capital deployment has not been enabled",
    flows: {
      status: "ok",
      depositorCount: 2,
      depositorCountModel: "distinct-deposit-owners-in-event-window",
      pendingUnfulfilledRedemptionShares: amount("0"),
      pendingUnfulfilledRedemptionAssets: amount("0"),
      recent: [{
        type: "Deposit",
        blockNumber: 101,
        logIndex: 2,
        txHash: "0xfeed",
        owner: "0x3333333333333333333333333333333333333333",
        assetsRaw: "500000",
        sharesRaw: "333333",
      }],
      sharePriceQualifyingEvents: [],
      window: { fromBlock: 90, toBlock: 101, maxBlocks: 12, recentLimit: 8 },
      lastError: null,
    },
    producerMayAddThisLater: { ignored: true },
    ...overrides,
  };
}

describe("normalizeDepositPoolFeed", () => {
  it("allowlists the v1 snapshot and reconstructs raw caps with the asset decimals", () => {
    const result = normalizeDepositPoolFeed(payload());
    expect(result).toMatchObject({
      snapshot: {
        schemaVersion: 1,
        pricingModel: "principal-cost-basis",
        totalAssets: amount("1500000"),
        caps: {
          totalAssetCap: amount("10000000"),
          perAgentAssetCap: amount("2000000"),
          headroom: amount("8500000"),
          utilizationBps: 1500,
        },
        flows: {
          status: "ok",
          depositorCount: 2,
          pendingUnfulfilledRedemptionAssets: amount("0"),
          recent: [{ kind: "deposit", blockNumber: 101, assets: amount("500000"), sharesRaw: "333333" }],
          sharePriceQualifyingEvents: [],
          window: { fromBlock: 90, toBlock: 101, maxBlocks: 12, recentLimit: 8 },
        },
      },
    });
    expect(result).not.toHaveProperty("snapshot.flows.recent.0.owner");
    expect(JSON.stringify(result)).not.toContain("0x3333333333333333333333333333333333333333");
    expect(JSON.stringify(result)).not.toContain("producerMayAddThisLater");
  });

  it("turns an unconfigured profile into UNAVAILABLE, never an empty pool", () => {
    expect(normalizeDepositPoolFeed({
      schemaVersion: 1,
      available: false,
      reason: "deposit_pool_not_configured",
    })).toEqual({ unavailable: "deposit pool unavailable — deposit_pool_not_configured" });
  });

  it("labels a reconciliation mismatch as a fault and withholds impossible numbers", () => {
    const result = normalizeDepositPoolFeed(payload({
      reconciled: false,
      reconciliation: {
        equation: "buffer + deployed = totalAssets",
        accountedRaw: "1400000",
        differenceRaw: "100000",
      },
    }));
    expect(result).toEqual({
      fault: "deposit pool incoherent — producer reported reconciliation failure",
    });
    expect(result).not.toHaveProperty("snapshot");
  });

  it("labels a share-price mismatch as a fault instead of rendering it", () => {
    const result = normalizeDepositPoolFeed(payload({ sharePrice: amount("2000000") }));
    expect(result).toEqual({
      fault: "deposit pool incoherent — share price is inconsistent with total assets and shares",
    });
  });

  it("keeps live balances when the bounded log read fails and degrades only flows", () => {
    const result = normalizeDepositPoolFeed(payload({
      flows: {
        status: "unavailable",
        depositorCount: null,
        depositorCountModel: "distinct-deposit-owners-in-event-window",
        pendingUnfulfilledRedemptionShares: null,
        pendingUnfulfilledRedemptionAssets: null,
        recent: null,
        sharePriceQualifyingEvents: null,
        window: { fromBlock: 90, toBlock: 101, maxBlocks: 12, recentLimit: 8 },
        lastError: "eth_getLogs returned HTTP 429",
      },
    }));
    expect(result).toMatchObject({
      snapshot: {
        totalAssets: amount("1500000"),
        buffer: amount("500000"),
        flows: {
          status: "unavailable",
          lastError: "eth_getLogs returned HTTP 429",
          window: { fromBlock: 90, toBlock: 101, maxBlocks: 12, recentLimit: 8 },
        },
      },
    });
  });
});

describe("readDepositPoolFeed", () => {
  it("derives the internal sibling URL and never uses the public API base", async () => {
    const config = loadProductHealthConfig({
      PRODUCT_HEALTH_API_BASE_URL: "https://api.example",
      PRODUCT_HEALTH_BANK_FEED_URL: "http://agent-mainnet-backend:8787/monitor/bank-lane?x=1",
    });
    const internalUrl = depositPoolUrlFromBankFeed(config.bankFeedUrl);
    expect(internalUrl).toBe("http://agent-mainnet-backend:8787/monitor/deposit-pool");
    expect(internalUrl).not.toContain(config.apiBaseUrl ?? "api.example");
    expect(depositPoolUrlFromBankFeed(undefined)).toBeUndefined();

    let requested = "";
    const result = await readDepositPoolFeed({
      url: internalUrl,
      fetchImpl: (async (url: RequestInfo | URL) => {
        requested = String(url);
        return { ok: false, status: 404 } as Response;
      }) as typeof fetch,
    });
    expect(requested).toBe("http://agent-mainnet-backend:8787/monitor/deposit-pool");
    expect(requested).not.toContain("api.example");
    expect(result).toEqual({ unavailable: "deposit pool unreachable — platform returned HTTP 404" });
  });
});
