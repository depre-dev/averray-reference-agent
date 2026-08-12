import { describe, expect, it } from "vitest";

import {
  decideDepositPoolAlerts,
  initialDepositPoolAlertState,
} from "../../services/slack-operator/src/money-alert.js";
import type { DepositPoolSnapshot } from "../../services/slack-operator/src/deposit-pool-feed.js";
import {
  buildProductHealthAlert,
  decideProductHealthAlert,
  evaluateProductHealth,
  initialProductHealthAlertState,
} from "../../services/slack-operator/src/product-health.js";

const amount = (raw: string) => ({ raw, decimals: 6 });

function pool(overrides: Partial<DepositPoolSnapshot> = {}): DepositPoolSnapshot {
  return {
    schemaVersion: 1,
    available: true,
    block: { number: 100 },
    pricingModel: "principal-cost-basis",
    totalAssets: amount("1000000"),
    totalShares: amount("1000000"),
    sharePrice: amount("1000000"),
    buffer: amount("1000000"),
    deployed: amount("0"),
    reconciled: true,
    yieldStatus: "not_yet_earning",
    flows: {
      status: "ok",
      depositorCount: 0,
      pendingUnfulfilledRedemptionAssets: amount("0"),
      recent: [],
      sharePriceQualifyingEvents: [],
      window: { fromBlock: 90, toBlock: 100, maxBlocks: 11, recentLimit: 8 },
    },
    ...overrides,
  };
}

function observe(
  current: DepositPoolSnapshot,
  state = initialDepositPoolAlertState(),
) {
  return decideDepositPoolAlerts({ current, state });
}

describe("the #1051 tombstone probe", () => {
  it("pages critically when cost-basis share price moves without a qualifying event", () => {
    const first = observe(pool());
    const moved = observe(pool({
      block: { number: 101 },
      totalAssets: amount("1100000"),
      sharePrice: amount("1100000"),
      buffer: amount("1100000"),
      flows: {
        ...pool().flows,
        window: { fromBlock: 101, toBlock: 101, maxBlocks: 1, recentLimit: 8 },
      },
    }), first.state);
    expect(moved.criticalLines).toHaveLength(1);
    expect(moved.criticalLines[0]).toContain("#1051 tombstone probe");
    expect(moved.key).toContain("deposit-pool:tombstone");
  });

  it("does not page when the same window contains a qualifying principal event", () => {
    const first = observe(pool());
    const moved = observe(pool({
      block: { number: 101 },
      totalAssets: amount("1100000"),
      sharePrice: amount("1100000"),
      buffer: amount("1100000"),
      flows: {
        ...pool().flows,
        sharePriceQualifyingEvents: [{ kind: "operator_principal_contributed", blockNumber: 101 }],
        window: { fromBlock: 101, toBlock: 101, maxBlocks: 1, recentLimit: 8 },
      },
    }), first.state);
    expect(moved.criticalLines).toEqual([]);
    expect(moved.key).toBe("");
  });

  it("retains the last comparable baseline across a log-read outage", () => {
    const first = observe(pool());
    const blind = observe(pool({
      block: { number: 101 },
      totalAssets: amount("1100000"),
      sharePrice: amount("1100000"),
      buffer: amount("1100000"),
      flows: {
        status: "unavailable",
        recent: [],
        lastError: "eth_getLogs timed out",
        window: { fromBlock: 101, toBlock: 101, maxBlocks: 1, recentLimit: 8 },
      },
    }), first.state);
    expect(blind.criticalLines).toEqual([]);

    const recovered = observe(pool({
      block: { number: 102 },
      totalAssets: amount("1100000"),
      sharePrice: amount("1100000"),
      buffer: amount("1100000"),
      flows: {
        ...pool().flows,
        window: { fromBlock: 101, toBlock: 102, maxBlocks: 2, recentLimit: 8 },
      },
    }), blind.state);
    expect(recovered.criticalLines).toHaveLength(1);
  });
});

describe("the buffer-floor ceremony switch", () => {
  const underPending = {
    buffer: amount("400000"),
    deployed: amount("600000"),
    flows: {
      ...pool().flows,
      pendingUnfulfilledRedemptionAssets: amount("500000"),
    },
  } satisfies Partial<DepositPoolSnapshot>;

  it("is wired but OFF before yield is earning", () => {
    expect(observe(pool({ ...underPending, yieldStatus: "not_yet_earning" })).criticalLines).toEqual([]);
  });

  it("flips on from the same yieldStatus signal, without a board release", () => {
    const result = observe(pool({ ...underPending, yieldStatus: "earning" }));
    expect(result.criticalLines).toHaveLength(1);
    expect(result.criticalLines[0]).toContain("buffer below pending unfulfilled redemptions");
  });
});

describe("the first-deposit milestone", () => {
  it("fires exactly once across repeated observations, including a later 0 → 1", () => {
    const zero = observe(pool());
    const first = observe(pool({ flows: { ...pool().flows, depositorCount: 1 } }), zero.state);
    const repeated = observe(pool({ flows: { ...pool().flows, depositorCount: 1 } }), first.state);
    const backToZero = observe(pool(), repeated.state);
    const secondCrossing = observe(pool({ flows: { ...pool().flows, depositorCount: 1 } }), backToZero.state);

    expect(first.positiveLines).toHaveLength(1);
    expect(first.positiveLines[0]).toContain("first deposit");
    expect(repeated.positiveLines).toEqual([]);
    expect(secondCrossing.positiveLines).toEqual([]);
  });
});

describe("the existing off-device money-alert path", () => {
  const healthy = evaluateProductHealth([{ name: "product_api", status: "ok", detail: "200" }]);

  it("folds the tombstone signal into a critical product-health page", () => {
    const baseline = decideProductHealthAlert({
      evaluation: healthy,
      state: initialProductHealthAlertState(),
      nowMs: 1_000,
      cooldownMs: 60_000,
      snapshot: { depositPool: { snapshot: pool() } },
    });
    const movedPool = pool({
      block: { number: 101 },
      totalAssets: amount("1100000"),
      sharePrice: amount("1100000"),
      buffer: amount("1100000"),
      flows: {
        ...pool().flows,
        window: { fromBlock: 101, toBlock: 101, maxBlocks: 1, recentLimit: 8 },
      },
    });
    const moved = decideProductHealthAlert({
      evaluation: healthy,
      state: baseline.state,
      nowMs: 2_000,
      cooldownMs: 60_000,
      snapshot: { depositPool: { snapshot: movedPool } },
    });
    expect(moved.alert).toBe(true);
    const payload = buildProductHealthAlert(
      healthy,
      "https://monitor.example",
      { depositPool: { snapshot: movedPool } },
      moved.poolAlerts,
    );
    expect(payload.text).toContain(":rotating_light:");
    expect(payload.text).toContain("CRITICAL #1051 tombstone probe");
  });

  it("pages the first deposit once through the same dedup state", () => {
    const zero = decideProductHealthAlert({
      evaluation: healthy,
      state: initialProductHealthAlertState(),
      nowMs: 1_000,
      cooldownMs: 60_000,
      snapshot: { depositPool: { snapshot: pool() } },
    });
    const one = pool({ flows: { ...pool().flows, depositorCount: 1 } });
    const first = decideProductHealthAlert({
      evaluation: healthy,
      state: zero.state,
      nowMs: 2_000,
      cooldownMs: 60_000,
      snapshot: { depositPool: { snapshot: one } },
    });
    const repeated = decideProductHealthAlert({
      evaluation: healthy,
      state: first.state,
      nowMs: 3_000,
      cooldownMs: 60_000,
      snapshot: { depositPool: { snapshot: one } },
    });
    expect(first.alert).toBe(true);
    expect(first.poolAlerts?.positiveLines).toHaveLength(1);
    expect(repeated.alert).toBe(false);
  });

  it("does not re-page an unrelated ongoing red after the positive milestone clears", () => {
    const red = evaluateProductHealth([{ name: "chain_height", status: "red", detail: "halt" }]);
    const zero = decideProductHealthAlert({
      evaluation: red,
      state: initialProductHealthAlertState(),
      nowMs: 1_000,
      cooldownMs: 60_000,
      snapshot: { depositPool: { snapshot: pool() } },
    });
    const one = pool({ flows: { ...pool().flows, depositorCount: 1 } });
    const milestone = decideProductHealthAlert({
      evaluation: red,
      state: zero.state,
      nowMs: 2_000,
      cooldownMs: 60_000,
      snapshot: { depositPool: { snapshot: one } },
    });
    const repeated = decideProductHealthAlert({
      evaluation: red,
      state: milestone.state,
      nowMs: 3_000,
      cooldownMs: 60_000,
      snapshot: { depositPool: { snapshot: one } },
    });
    expect(milestone.alert).toBe(true);
    expect(repeated.alert).toBe(false);
  });
});
