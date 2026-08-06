import { describe, expect, it } from "vitest";

import {
  evaluateProductHealth,
  redProbeKey,
  fetchProductHealth,
  deriveProductApiProbe,
  deriveChainProbe,
  deriveCapabilityProbe,
  deriveLatencyProbe,
  deriveMoneyPathProbe,
  probeTreasuryLiquidity,
  trackChainAdvance,
  chainHaltStatus,
  probeSignerLiquidity,
  decidePayoutEvidence,
  buildProductHealthAlert,
  decideWindowFit,
  measureBlockSeconds,
  readPayoutTransfers,
  resolvePayoutLookback,
  withFeeSplit,
  collectProductHealthProbes,
  chainBlockAge,
  decideProductHealthAlert,
  runProductHealthOnce,
  initialProductHealthAlertState,
  loadProductHealthConfig,
  networkEthRpc,
  appendHistory,
  probeSparkline,
  deriveProductHealthHistory,
  deriveLiquidityRunway,
  decideRunwayAlert,
  buildRunwayAlertPayload,
  initialRunwayAlertState,
  type ProbeResult,
  type SolvencyPoolData,
  type LiquidityRunway,
  type LiquidityRunwayPool,
  type ProductHealthConfig,
  type ProductHealthFetch,
  type ProductHealthPayload,
  type ProductHealthAlertState,
  type ProductHealthDeps,
  type ProductHealthSnapshot,
  type ProductHealthStatus,
} from "../../services/slack-operator/src/product-health.js";
import type { AlertPayload } from "../../services/slack-operator/src/alert-bridge.js";

// ── mocks (typed so the "Typecheck and test" job stays green) ──

function rpcMethod(init: RequestInit): string {
  try {
    return (JSON.parse(String(init.body)) as { method?: string }).method ?? "";
  } catch {
    return "";
  }
}

/** GET /health → healthBody; eth-RPC POSTs → chainId / latest-block / gas / usdc per method. */
function combinedFetch(cfg: {
  healthBody?: unknown;
  healthStatus?: number;
  rpcStatus?: number;
  gasHex?: string;
  usdcHex?: string;
  chainIdHex?: string;
  blockTimestampHex?: string;
  /** external_funnel catalog rows. Default empty — an empty funnel is a real,
   *  honest state, which is what the healthy scenario should exercise. */
  externalJobs?: unknown[];
  /** Live dispute window (seconds). The probe reads it; it is never hardcoded. */
  disputeWindowSeconds?: number;
}): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const status = cfg.healthStatus ?? 200;
      const ok = status >= 200 && status < 300;
      // The funnel probe reads two endpoints besides /health. Serving them by
      // URL keeps the mock honest: a GET that ignores its URL would make every
      // scenario look like whatever /health returned.
      const href = String(url);
      if (href.includes("/jobs")) {
        return { ok, status, json: async () => ({ jobs: cfg.externalJobs ?? [] }) } as unknown as Response;
      }
      if (href.includes("/poster/onboarding")) {
        return {
          ok,
          status,
          json: async () => ({
            workerFacts: { disputeWindow: { available: true, seconds: cfg.disputeWindowSeconds ?? 604800 } },
          }),
        } as unknown as Response;
      }
      return { ok, status, json: async () => cfg.healthBody ?? {} } as unknown as Response;
    }
    const status = cfg.rpcStatus ?? 200;
    if (status < 200 || status >= 300) {
      return { ok: false, status, json: async () => ({}) } as unknown as Response;
    }
    const m = rpcMethod(init ?? {});
    const result =
      m === "eth_chainId"
        ? cfg.chainIdHex
        : m === "eth_getBlockByNumber"
          ? { number: "0xa1e2c9", timestamp: cfg.blockTimestampHex }
          : m === "eth_getBalance"
            ? cfg.gasHex
            : cfg.usdcHex;
    return { ok: true, status: 200, json: async () => ({ result }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Signer-balance mock: eth_getBalance → gasHex, else usdcHex. */
function balances(gasHex: string, usdcHex: string): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    ({ ok: true, status: 200, json: async () => ({ result: rpcMethod(init ?? {}) === "eth_getBalance" ? gasHex : usdcHex }) }) as unknown as Response) as unknown as typeof fetch;
}

function healthFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
}

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

/** What undici actually throws when the container's resolver is down. */
function dnsFailingFetch(host = "api.averray.com"): typeof fetch {
  return (async () => {
    const inner = Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    throw Object.assign(new TypeError("fetch failed"), { cause: inner });
  }) as unknown as typeof fetch;
}

const probe = (name: string, status: ProbeResult["status"], detail = ""): ProbeResult => ({ name, status, detail });

// A realistic slice of the live Averray /health payload (testnet chainId 420420417).
const HEALTHY_BODY: ProductHealthPayload = {
  status: "ok",
  auth: { chainId: 420420417 },
  serviceHealth: { ok: true },
  capabilityHealth: { blockchain: "enabled", treasuryMutations: "available", xcmObserver: "staged", indexer: "unavailable", gasSponsor: "disabled" },
  warnings: [
    { code: "xcm_observer_staged", severity: "warning", message: "XCM observer is staged." },
    { code: "indexer_unavailable", severity: "warning", message: "Indexer capability is unavailable." },
    { code: "gas_sponsor_disabled", severity: "warning", message: "Gas sponsor capability is disabled." },
  ],
  components: {
    blockchain: { ok: true, enabled: true, blockNumber: 10612201, signerConfigured: true },
  },
  settlement: { settled24h: 42, stuck: 0, failed24h: 0, asOf: "2026-07-04T00:00:00Z" },
  addresses: { token: "0xusdc", agentAccountCore: "0xaac", escrowCore: "0xescrow", settlementSigner: "0xsigner", treasuryReserve: "0xreserve" },
  rewardBank: { liquid: 100, decimals: 6, asOf: "2026-07-04T00:00:00Z" },
};

const fetched = (body: ProductHealthPayload, over: Partial<ProductHealthFetch> = {}): ProductHealthFetch => ({
  configured: true,
  reachable: true,
  httpOk: true,
  status: 200,
  url: "https://api.x/health",
  body,
  ...over,
});

/** A /health read that died below HTTP — no response ever arrived. */
const unreachable = (over: Partial<ProductHealthFetch> = {}): ProductHealthFetch => ({
  configured: true,
  reachable: false,
  httpOk: false,
  status: 0,
  url: "https://api.x/health",
  error: "fetch failed",
  transport: { kind: "dns", code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.x" },
  latencyMs: 12,
  ...over,
});

const TESTNET_RPC = "https://eth-rpc-testnet.polkadot.io/";

const cfg = (over: Partial<ProductHealthConfig> = {}): ProductHealthConfig => ({
  apiBaseUrl: "https://api.x",
  apiHealthPath: "/health",
  rpcUrl: "http://rpc",
  chainMaxStaleSeconds: 600,
  haltSeverity: "auto",
  signerAddress: "0xabc",
  usdcAddress: "0xusdc",
  usdcDecimals: 6,
  minGasNative: 0,
  requiredCapabilities: ["blockchain", "treasuryMutations"],
  expectedWarnings: ["xcm_observer_staged", "indexer_unavailable", "gas_sponsor_disabled"],
  latencyWarnMs: 2000,
  latencyRedMs: 10000,
  maxStuck: 5,
  maxFailed24h: 3,
  settlementMaxStaleMinutes: 15,
  minRewardBank: 0,
  minTreasuryReserve: 5,
  minAac: 0,
  ...over,
});

describe("evaluateProductHealth", () => {
  it("overall status is the worst probe (red > degraded > ok)", () => {
    expect(evaluateProductHealth([probe("a", "ok")]).status).toBe("healthy");
    expect(evaluateProductHealth([probe("a", "ok"), probe("b", "degraded")]).status).toBe("degraded");
    expect(evaluateProductHealth([probe("a", "degraded"), probe("b", "red")]).status).toBe("red");
  });

  it("collects the red probes that drive the alert", () => {
    const e = evaluateProductHealth([probe("a", "red"), probe("b", "ok"), probe("c", "red")]);
    expect(e.redProbes.map((p) => p.name)).toEqual(["a", "c"]);
  });
});

describe("redProbeKey", () => {
  it("is order-independent", () => {
    const e1 = evaluateProductHealth([probe("c", "red"), probe("a", "red")]);
    const e2 = evaluateProductHealth([probe("a", "red"), probe("c", "red")]);
    expect(redProbeKey(e1)).toBe("a,c");
    expect(redProbeKey(e1)).toBe(redProbeKey(e2));
  });
});

describe("fetchProductHealth", () => {
  it("configured:false when the base url is unset (never a fake reachable)", async () => {
    const h = await fetchProductHealth({ baseUrl: undefined, healthPath: "/health", fetchImpl: healthFetch(200, HEALTHY_BODY) });
    expect(h.configured).toBe(false);
    expect(h.reachable).toBe(false);
  });

  it("parses the JSON body on a 2xx", async () => {
    const h = await fetchProductHealth({ baseUrl: "https://api.x", healthPath: "/health", fetchImpl: healthFetch(200, HEALTHY_BODY) });
    expect(h).toMatchObject({ configured: true, reachable: true, httpOk: true, status: 200 });
    expect(h.body?.components?.blockchain?.blockNumber).toBe(10612201);
  });

  it("reachable but not httpOk on a non-2xx", async () => {
    const h = await fetchProductHealth({ baseUrl: "https://api.x", healthPath: "/health", fetchImpl: healthFetch(503, {}) });
    expect(h).toMatchObject({ reachable: true, httpOk: false, status: 503 });
  });

  it("not reachable (with the error) when the request throws", async () => {
    const h = await fetchProductHealth({ baseUrl: "https://api.x", healthPath: "/health", fetchImpl: throwingFetch() });
    expect(h.reachable).toBe(false);
    expect(h.error).toContain("network down");
  });
});

describe("deriveProductApiProbe", () => {
  it("degraded (never fake green) when unconfigured", () => {
    expect(deriveProductApiProbe({ configured: false, reachable: false, httpOk: false, status: 0, url: "" }).status).toBe("degraded");
  });

  // ── 2026-08-06: five minutes of container-local DNS failure, paged as an
  // outage of a product that was serving 200s from outside the whole time. ──

  it("holds unknown — not red — on the FIRST unreachable cycle", () => {
    const r = deriveProductApiProbe(unreachable(), { transportRun: { code: "ENOTFOUND", consecutive: 1 } });
    expect(r.status).not.toBe("red");
    expect(r.reading).toBe("unknown");
  });

  it("names the cause code and the layer, never bare 'fetch failed'", () => {
    const r = deriveProductApiProbe(unreachable(), { transportRun: { code: "ENOTFOUND", consecutive: 1 } });
    expect(r.detail).toContain("ENOTFOUND");
    expect(r.detail).toContain("DNS resolution failed");
    expect(r.detail).not.toContain("fetch failed");
  });

  it("claims only what it knows: unreachable FROM HERE, product state unknown", () => {
    const r = deriveProductApiProbe(unreachable(), { transportRun: { code: "ENOTFOUND", consecutive: 1 } });
    expect(r.detail).toContain("probe cannot reach");
    expect(r.detail).toContain("unknown from here");
    // The claim it must never make on transport evidence alone.
    expect(r.detail).not.toMatch(/\bis down\b|\bunavailable\b/);
  });

  it("reds once the fault has persisted for the threshold — still worded as unreachability", () => {
    const r = deriveProductApiProbe(unreachable(), { transportRun: { code: "ENOTFOUND", consecutive: 3 } });
    expect(r.status).toBe("red");
    // Red is the volume, not a new claim: the reading is still unknown, so every
    // renderer words this as "unreachable", not as a verdict on the product.
    expect(r.reading).toBe("unknown");
    expect(r.detail).toContain("3 consecutive checks");
    expect(r.detail).toContain("unreachable from the monitor");
  });

  it("respects a configured threshold", () => {
    const at2 = { transportRun: { code: "ENOTFOUND", consecutive: 2 }, transportThreshold: 2 };
    expect(deriveProductApiProbe(unreachable(), at2).status).toBe("red");
    expect(deriveProductApiProbe(unreachable(), { ...at2, transportRun: { code: "ENOTFOUND", consecutive: 1 } }).status)
      .toBe("degraded");
  });

  it("treats an unclassified unreachable as a transport fault too (never silently red on cycle 1)", () => {
    // A caller that hand-builds the fetch result carries no `transport`. That is
    // an absence of classification, not evidence the product answered.
    const r = deriveProductApiProbe({ configured: true, reachable: false, httpOk: false, status: 0, url: "https://api.x/health", error: "boom" });
    expect(r.status).toBe("degraded");
    expect(r.reading).toBe("unknown");
  });

  it("an HTTP response is evidence about the PRODUCT — reds immediately, no hold", () => {
    // The distinction the whole change rests on: 503 means it answered.
    const r = deriveProductApiProbe(fetched(HEALTHY_BODY, { httpOk: false, status: 503 }));
    expect(r.status).toBe("red");
    expect(r.reading).toBeUndefined();
  });

  it("red on a non-2xx and on a self-reported unhealthy service", () => {
    expect(deriveProductApiProbe(fetched(HEALTHY_BODY, { httpOk: false, status: 503 })).status).toBe("red");
    expect(deriveProductApiProbe(fetched({ ...HEALTHY_BODY, serviceHealth: { ok: false } })).status).toBe("red");
  });

  it("ok on a healthy payload, surfacing the chain id it's watching", () => {
    const r = deriveProductApiProbe(fetched(HEALTHY_BODY));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("420420417");
  });
});

describe("probes that read OUT of /health, when /health never arrived", () => {
  // All four derive from the same one fetch. When it fails below HTTP they hold
  // no evidence about their subjects — so on 2026-08-06 one DNS failure
  // manufactured four simultaneous findings about a product nobody had reached.
  const dependents = (): Array<[string, ProbeResult]> => [
    ["chain_height", deriveChainProbe(unreachable())],
    ["capabilities", deriveCapabilityProbe(unreachable(), { requiredCapabilities: ["blockchain"], expectedWarnings: [] })],
    ["api_latency", deriveLatencyProbe(unreachable(), { warnMs: 2000, redMs: 8000 })],
    ["money_path", deriveMoneyPathProbe(unreachable(), { maxStuck: 5, maxFailed24h: 3, maxStaleMinutes: 30, nowMs: 0 })],
  ];

  it("reads unknown, not degraded — no reading is not a finding", () => {
    for (const [name, probe] of dependents()) {
      expect(probe.reading, name).toBe("unknown");
    }
  });

  it("never reds, however long the fault persists — product_api owns that claim", () => {
    for (const [name, probe] of dependents()) {
      expect(probe.status, name).not.toBe("red");
    }
  });

  it("says the subject is unknown AND what it is not being claimed to be", () => {
    // external_funnel's "funnel state unknown, not empty" is the model.
    const byName = new Map(dependents());
    expect(byName.get("money_path")!.detail).toContain("settlement state unknown, not stalled");
    expect(byName.get("chain_height")!.detail).toContain("chain height unknown, not halted");
    expect(byName.get("capabilities")!.detail).toContain("capability state unknown, not down");
    expect(byName.get("api_latency")!.detail).toContain("round-trip latency unknown, not slow");
  });

  it("carries the cause code so the fault is diagnosable from the line alone", () => {
    for (const [name, probe] of dependents()) {
      expect(probe.detail, name).toContain("ENOTFOUND");
    }
  });

  it("still reports a plain 503 as a degraded READING, not as unknown", () => {
    // The product answered. That is evidence, and it must keep its old meaning.
    const served503 = fetched(HEALTHY_BODY, { httpOk: false, status: 503 });
    const money = deriveMoneyPathProbe(served503, { maxStuck: 5, maxFailed24h: 3, maxStaleMinutes: 30, nowMs: 0 });
    expect(money.reading).toBeUndefined();
    expect(money.detail).toContain("settlement status unavailable");
  });
});

describe("deriveChainProbe (/health-derived)", () => {
  it("degraded (not a page) when /health is unreadable — product_api carries the red", () => {
    expect(deriveChainProbe({ configured: true, reachable: false, httpOk: false, status: 0, url: "u" }).status).toBe("degraded");
  });

  it("degraded when the payload has no blockchain component", () => {
    expect(deriveChainProbe(fetched({ status: "ok" })).status).toBe("degraded");
  });

  it("ok with the reported block height and chain id", () => {
    const r = deriveChainProbe(fetched(HEALTHY_BODY));
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("10,612,201");
    expect(r.detail).toContain("420420417");
  });

  it("red when the product reports its blockchain component unhealthy", () => {
    expect(deriveChainProbe(fetched({ ...HEALTHY_BODY, components: { blockchain: { ok: false, blockNumber: 10 } } })).status).toBe("red");
  });

  it("red when the chain reports block 0", () => {
    expect(deriveChainProbe(fetched({ ...HEALTHY_BODY, components: { blockchain: { ok: true, blockNumber: 0 } } })).status).toBe("red");
  });

  it("tracker fallback: static past the window halts (severity caller-supplied)", () => {
    const stale = (haltStatus: "red" | "degraded") => deriveChainProbe(fetched(HEALTHY_BODY), { staticForMs: 900_000, maxStaleSeconds: 600, haltStatus });
    expect(stale("degraded").status).toBe("degraded");
    expect(stale("degraded").detail).toContain("static for");
    expect(stale("red").status).toBe("red");
  });

  it("absolute block age fires immediately — no blind window (staticForMs = 0)", () => {
    const r = deriveChainProbe(fetched(HEALTHY_BODY), { staticForMs: 0, maxStaleSeconds: 600, haltStatus: "degraded", blockAgeSec: 3600 });
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("old");
  });

  it("a fresh absolute age wins over a stale tracker → ok", () => {
    expect(deriveChainProbe(fetched(HEALTHY_BODY), { staticForMs: 900_000, maxStaleSeconds: 600, haltStatus: "red", blockAgeSec: 12 }).status).toBe("ok");
  });

  it("ok when static but within the window (no absolute age available)", () => {
    expect(deriveChainProbe(fetched(HEALTHY_BODY), { staticForMs: 30_000, maxStaleSeconds: 600, haltStatus: "red" }).status).toBe("ok");
  });
});

describe("trackChainAdvance", () => {
  it("starts the clock at the first observation", () => {
    expect(trackChainAdvance(undefined, 100, 5000)).toEqual({ lastBlock: 100, lastAdvanceAtMs: 5000 });
  });

  it("resets the clock when the block advances", () => {
    expect(trackChainAdvance({ lastBlock: 100, lastAdvanceAtMs: 5000 }, 101, 9000)).toEqual({ lastBlock: 101, lastAdvanceAtMs: 9000 });
  });

  it("keeps the old advance time when the block is static (so staleness accrues)", () => {
    expect(trackChainAdvance({ lastBlock: 100, lastAdvanceAtMs: 5000 }, 100, 9000)).toEqual({ lastBlock: 100, lastAdvanceAtMs: 5000 });
  });

  it("holds the previous tracker when the block is missing", () => {
    expect(trackChainAdvance({ lastBlock: 100, lastAdvanceAtMs: 5000 }, undefined, 9000)).toEqual({ lastBlock: 100, lastAdvanceAtMs: 5000 });
  });
});

describe("chainHaltStatus", () => {
  it("auto: mainnet chainId pages (red), testnet freezes (degraded)", () => {
    expect(chainHaltStatus(420420419, "auto")).toBe("red"); // Polkadot Hub mainnet
    expect(chainHaltStatus(420420417, "auto")).toBe("degraded"); // testnet
    expect(chainHaltStatus(undefined, "auto")).toBe("degraded");
  });

  it("explicit override wins over the auto chainId rule", () => {
    expect(chainHaltStatus(420420417, "red")).toBe("red");
    expect(chainHaltStatus(420420419, "degraded")).toBe("degraded");
  });
});

describe("deriveMoneyPathProbe", () => {
  const NOW = Date.parse("2026-07-04T00:20:00Z");
  const base = { maxStuck: 5, maxFailed24h: 3, maxStaleMinutes: 15, nowMs: NOW };
  const withSettlement = (s: NonNullable<ProductHealthPayload["settlement"]>): ProductHealthFetch =>
    fetched({ ...HEALTHY_BODY, settlement: s });

  it("degraded when /health unreadable or the settlement block is absent", () => {
    expect(deriveMoneyPathProbe({ configured: true, reachable: false, httpOk: false, status: 0, url: "u" }, base).status).toBe("degraded");
    expect(deriveMoneyPathProbe(fetched({ status: "ok" }), base).status).toBe("degraded");
  });

  it("ok when nothing is stuck or failed (fresh counts)", () => {
    const r = deriveMoneyPathProbe(withSettlement({ settled24h: 42, stuck: 0, failed24h: 0, asOf: "2026-07-04T00:19:00Z" }), base);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("settled24h 42");
  });

  it("degrades only after submitted-not-settled work persists across two probes", () => {
    const settlement = {
      claimed24h: 2,
      submitted24h: 2,
      claimedNotSubmitted: 0,
      submittedNotSettled: 1,
      settled24h: 2,
      stuck: 0,
      failed24h: 0,
      asOf: "2026-07-04T00:19:00Z",
    };
    const first = deriveMoneyPathProbe(withSettlement(settlement), base);
    const sustained = deriveMoneyPathProbe(
      withSettlement(settlement),
      { ...base, previousSubmittedNotSettled: 1 },
    );

    expect(first.status).toBe("ok");
    expect(first.detail).toContain("submittedNotSettled 1");
    expect(sustained.status).toBe("degraded");
    expect(sustained.detail).toContain("submittedNotSettled 1 across 2 consecutive probes");
  });

  it("keeps claimed-not-submitted informational and omits zero gauges from detail", () => {
    const active = deriveMoneyPathProbe(
      withSettlement({
        claimed24h: 2,
        submitted24h: 1,
        claimedNotSubmitted: 1,
        submittedNotSettled: 0,
        settled24h: 1,
        stuck: 0,
        failed24h: 0,
        asOf: "2026-07-04T00:19:00Z",
      }),
      base,
    );
    const idle = deriveMoneyPathProbe(
      withSettlement({
        claimed24h: 2,
        submitted24h: 2,
        claimedNotSubmitted: 0,
        submittedNotSettled: 0,
        settled24h: 2,
        stuck: 0,
        failed24h: 0,
        asOf: "2026-07-04T00:19:00Z",
      }),
      base,
    );

    expect(active.status).toBe("ok");
    expect(active.detail).toContain("claimedNotSubmitted 1");
    expect(idle.detail).toBe("settled24h 2 (0 stuck, 0 failed)");
  });

  it("red when stuck ≥ maxStuck, or settlement failures ≥ maxFailed24h", () => {
    expect(deriveMoneyPathProbe(withSettlement({ stuck: 5, failed24h: 0, asOf: "2026-07-04T00:19:00Z" }), base).status).toBe("red");
    expect(deriveMoneyPathProbe(withSettlement({ stuck: 0, failed24h: 3, asOf: "2026-07-04T00:19:00Z" }), base).status).toBe("red");
  });

  it("degraded on some (below-threshold) stuck/failed", () => {
    expect(deriveMoneyPathProbe(withSettlement({ stuck: 1, failed24h: 0, asOf: "2026-07-04T00:19:00Z" }), base).status).toBe("degraded");
  });

  it("degraded when the counts are stale (asOf too old)", () => {
    const r = deriveMoneyPathProbe(withSettlement({ stuck: 0, failed24h: 0, asOf: "2026-07-04T00:00:00Z" }), base); // 20m > 15m
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("stale");
  });
});

describe("deriveLatencyProbe", () => {
  const thresholds = { warnMs: 2000, redMs: 10000 };

  it("degraded when unconfigured or no latency sample", () => {
    expect(deriveLatencyProbe({ configured: false, reachable: false, httpOk: false, status: 0, url: "" }, thresholds).status).toBe("degraded");
    expect(deriveLatencyProbe(fetched(HEALTHY_BODY), thresholds).status).toBe("degraded"); // no latencyMs
  });

  it("ok when fast", () => {
    const r = deriveLatencyProbe(fetched(HEALTHY_BODY, { latencyMs: 120 }), thresholds);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("120ms");
  });

  it("degraded when slow (≥ warn), red when very slow (≥ red)", () => {
    expect(deriveLatencyProbe(fetched(HEALTHY_BODY, { latencyMs: 3000 }), thresholds).status).toBe("degraded");
    expect(deriveLatencyProbe(fetched(HEALTHY_BODY, { latencyMs: 12000 }), thresholds).status).toBe("red");
  });

  it("degraded (not red) when unreachable — product_api carries the red", () => {
    expect(deriveLatencyProbe({ configured: true, reachable: false, httpOk: false, status: 0, url: "u", latencyMs: 12000 }, thresholds).status).toBe("degraded");
  });
});

describe("deriveCapabilityProbe", () => {
  const capConfig = {
    requiredCapabilities: ["blockchain", "treasuryMutations"],
    expectedWarnings: ["xcm_observer_staged", "indexer_unavailable", "gas_sponsor_disabled"],
  };

  it("degraded when /health is unreadable or has no capabilityHealth", () => {
    expect(deriveCapabilityProbe({ configured: true, reachable: false, httpOk: false, status: 0, url: "u" }, capConfig).status).toBe("degraded");
    expect(deriveCapabilityProbe(fetched({ status: "ok" }), capConfig).status).toBe("degraded");
  });

  it("ok while only the acknowledged warnings are present (required caps up)", () => {
    const r = deriveCapabilityProbe(fetched(HEALTHY_BODY), capConfig);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("acknowledged");
  });

  it("counts the live indexer synced state as healthy", () => {
    const body: ProductHealthPayload = {
      ...HEALTHY_BODY,
      capabilityHealth: {
        blockchain: "enabled",
        treasuryMutations: "available",
        xcmObserver: "staged",
        indexer: "synced",
        gasSponsor: "disabled",
      },
      warnings: [
        { code: "xcm_observer_staged", severity: "warning" },
        { code: "gas_sponsor_disabled", severity: "warning" },
      ],
    };
    const r = deriveCapabilityProbe(fetched(body), capConfig);
    expect(r.status).toBe("ok");
    // Required leads; the two deliberate states are NAMED rather than reduced
    // to "3/5 up", which read as two things being broken.
    expect(r.detail).toBe(
      "2/2 required up · xcmObserver staged, gasSponsor disabled (acknowledged)",
    );
  });

  // THE LIVE MAINNET PAYLOAD, exactly. `externalPostingWatcherLagSeconds` shares
  // the capabilityHealth object but is a METRIC — it has no healthy state, so it
  // counted as "not up" forever and made 7/7 unreachable by construction. The
  // board read "4/7 capabilities up" while every required capability was fine.
  it("does not count a metric as a capability, and shows it without judging it", () => {
    const body: ProductHealthPayload = {
      ...HEALTHY_BODY,
      capabilityHealth: {
        blockchain: "enabled",
        treasuryMutations: "available",
        xcmObserver: "staged",
        indexer: "synced",
        gasSponsor: "disabled",
        externalPosting: "enabled",
        externalPostingWatcherLagSeconds: 160,
      } as ProductHealthPayload["capabilityHealth"],
      warnings: [
        { code: "xcm_observer_staged", severity: "warning" },
        { code: "gas_sponsor_disabled", severity: "warning" },
      ],
    };
    const r = deriveCapabilityProbe(fetched(body), capConfig);
    expect(r.status).toBe("ok");
    expect(r.detail).toBe(
      "2/2 required up · xcmObserver staged, gasSponsor disabled (acknowledged) · external-posting watcher lag 160s",
    );
    // No threshold on the lag: nobody has decided what "too laggy" means, and
    // inventing one would manufacture an alarm.
    expect(r.status).not.toBe("degraded");
    expect(r.detail).not.toContain("4/7");
  });

  it("red when a REQUIRED capability isn't up (money path down)", () => {
    const body: ProductHealthPayload = { ...HEALTHY_BODY, capabilityHealth: { ...HEALTHY_BODY.capabilityHealth, treasuryMutations: "unavailable" } };
    const r = deriveCapabilityProbe(fetched(body), capConfig);
    expect(r.status).toBe("red");
    expect(r.detail).toContain("treasuryMutations");
  });

  it("degraded on a NEW warning outside the acknowledged baseline", () => {
    const body: ProductHealthPayload = { ...HEALTHY_BODY, warnings: [...(HEALTHY_BODY.warnings ?? []), { code: "redis_lag", severity: "warning", message: "redis is lagging" }] };
    const r = deriveCapabilityProbe(fetched(body), capConfig);
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("redis_lag");
  });

  it("red on a NEW error/critical-severity warning", () => {
    const body: ProductHealthPayload = { ...HEALTHY_BODY, warnings: [...(HEALTHY_BODY.warnings ?? []), { code: "settlement_stalled", severity: "critical", message: "settlement stalled" }] };
    expect(deriveCapabilityProbe(fetched(body), capConfig).status).toBe("red");
  });
});

describe("probeSignerLiquidity (direct RPC)", () => {
  const floors = { minGasNative: 0.1, minRewardBank: 5 };
  // 1 ETH = 1e18 wei = 0xDE0B6B3A7640000 ; 0.01 ETH = 1e16 = 0x2386F26FC10000
  // 10 USDC = 10_000_000 = 0x989680 ; 1 USDC = 1_000_000 = 0xF4240

  it("degraded when RPC / signer address are unconfigured", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: undefined, signerAddress: undefined, rewardBankLiquid: 10, ...floors, fetchImpl: balances("0x0", "0x0") });
    expect(r.status).toBe("degraded");
  });

  it("ok when gas and the in-contract reward bank are both above their floors", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 10, ...floors, fetchImpl: balances("0xDE0B6B3A7640000", "0x989680") });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("reward bank 10.00 USDC");
  });

  it("exposes structured signer gas + reward-bank pools for the Ops board", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 10, ...floors, fetchImpl: balances("0xDE0B6B3A7640000", "0x989680") });
    expect(r.pools?.map((p) => p.key)).toEqual(["signer_gas", "reward_bank"]);
    const reward = r.pools?.find((p) => p.key === "reward_bank");
    expect(reward?.amount).toBe(10);
    expect(reward?.unit).toBe("USDC");
    expect(reward?.floor).toBe(5);
  });

  it("red when native gas is below the floor", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 10, ...floors, fetchImpl: balances("0x2386F26FC10000", "0x989680") });
    expect(r.status).toBe("red");
    expect(r.detail).toContain("< 0.1");
  });

  it("red when the reward-bank position is below the floor", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 1, ...floors, fetchImpl: balances("0xDE0B6B3A7640000", "0xF4240") });
    expect(r.status).toBe("red");
    expect(r.detail).toContain("< 5");
  });

  it("degrades rather than reading wallet USDC when /health omits the reward bank", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: undefined, ...floors, fetchImpl: balances("0xDE0B6B3A7640000", "0x989680") });
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("reward bank unreadable");
  });

  it("degraded when the balance read fails", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 10, ...floors, fetchImpl: throwingFetch() });
    expect(r.status).toBe("degraded");
  });

  it("distinguishes a misconfigured JSON-RPC route from endpoint throttling", async () => {
    const withHttpStatus = (status: number): typeof fetch =>
      (async () =>
        ({ ok: false, status, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    const base = {
      rpcUrl: "http://rpc",
      signerAddress: "0xabc",
      rewardBankLiquid: 10,
      expectedChainId: 420420419,
      ...floors,
    };

    const wrongEndpoint = await probeSignerLiquidity({ ...base, fetchImpl: withHttpStatus(404) });
    expect(wrongEndpoint.detail).toContain("RPC endpoint misconfigured");
    expect(wrongEndpoint.detail).toContain("HTTP 404");

    const throttled = await probeSignerLiquidity({ ...base, fetchImpl: withHttpStatus(429) });
    expect(throttled.detail).toContain("RPC endpoint throttled");
    expect(throttled.detail).toContain("HTTP 429");
  });

  it("names WHICH piece is unconfigured (a cutover leaves solvency unmonitored)", async () => {
    const noRpc = await probeSignerLiquidity({ rpcUrl: undefined, signerAddress: "0xabc", rewardBankLiquid: 10, ...floors, fetchImpl: balances("0x0", "0x0") });
    expect(noRpc.detail).toContain("PRODUCT_HEALTH_RPC_URL");
    const noSigner = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: undefined, rewardBankLiquid: 10, ...floors, fetchImpl: balances("0x0", "0x0") });
    expect(noSigner.detail).toContain("PRODUCT_HEALTH_SIGNER_ADDRESS");
  });

  // ── chain guard ───────────────────────────────────────────────────────────
  // A healthy-but-WRONG-chain endpoint returns perfectly good balances for the
  // wrong signer. Never trust them: that's a fake-green on the money pillar.
  const TESTNET = "0x190f1b41"; // 420420417
  const MAINNET = "0x190f1b43"; // 420420419
  function chainedBalances(chainIdHex: string, gasHex: string, usdcHex: string): typeof fetch {
    return (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = rpcMethod(init ?? {});
      const result = method === "eth_chainId" ? chainIdHex : method === "eth_getBalance" ? gasHex : usdcHex;
      return { ok: true, status: 200, json: async () => ({ result }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("reads balances normally when the RPC is on the product's chain", async () => {
    const r = await probeSignerLiquidity({
      rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 10, ...floors,
      expectedChainId: 420420417,
      fetchImpl: chainedBalances(TESTNET, "0xDE0B6B3A7640000", "0x989680"),
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("reward bank 10.00 USDC");
    expect(r.pools?.find((p) => p.key === "signer_gas")?.unit).toBe("PAS");
  });

  it("labels mainnet gas as DOT from the product chainId", async () => {
    const r = await probeSignerLiquidity({
      rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 10, ...floors,
      expectedChainId: 420420419,
      fetchImpl: chainedBalances(MAINNET, "0xDE0B6B3A7640000", "0x989680"),
    });
    expect(r.status).toBe("ok");
    expect(r.pools?.find((p) => p.key === "signer_gas")?.unit).toBe("DOT");
  });

  it("RED + rpcOk:false when the product is on MAINNET but the RPC is a leftover testnet endpoint", async () => {
    // The exact cutover hazard: healthy testnet RPC, flush testnet signer, and the
    // mainnet signer could be dry. Must NOT report those balances as green.
    const r = await probeSignerLiquidity({
      rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 10, ...floors,
      expectedChainId: 420420419, // product is live on mainnet
      fetchImpl: chainedBalances(TESTNET, "0xDE0B6B3A7640000", "0x989680"), // fat testnet balances
    });
    expect(r.status).toBe("red"); // blind on mainnet pages
    expect(r.detail).toContain("chain mismatch");
    expect(r.detail).toContain("420420419");
    expect(r.detail).not.toContain("reward bank 10.00"); // no balance is trusted through a wrong-chain RPC
    expect(r.rpcOk).toBe(false); // drives failover past this endpoint, then escalates
  });

  it("degraded (not red) on a mismatch while the product is still on a testnet", async () => {
    const r = await probeSignerLiquidity({
      rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 10, ...floors,
      expectedChainId: 420420417,
      fetchImpl: chainedBalances(MAINNET, "0xDE0B6B3A7640000", "0x989680"),
    });
    expect(r.status).toBe("degraded");
    expect(r.rpcOk).toBe(false);
  });

  it("skips the guard when the product's chainId is unknown (no /health chainId)", async () => {
    const r = await probeSignerLiquidity({
      rpcUrl: "http://rpc", signerAddress: "0xabc", rewardBankLiquid: 10, ...floors,
      expectedChainId: undefined,
      fetchImpl: chainedBalances(TESTNET, "0xDE0B6B3A7640000", "0x989680"),
    });
    expect(r.status).toBe("ok");
    expect(r.pools?.find((p) => p.key === "signer_gas")?.unit).toBe("native");
  });
});

const CHAIN_ID_HEX = "0x" + (420420417).toString(16); // matches HEALTHY_BODY auth.chainId
const tsHex = (nowMs: number, secAgo: number): string => "0x" + BigInt(Math.floor(nowMs / 1000) - secAgo).toString(16);

describe("probeTreasuryLiquidity (direct RPC + /health rewardBank)", () => {
  const addresses = { token: "0xusdc", agentAccountCore: "0xaac", escrowCore: "0xescrow", treasuryReserve: "0xreserve" };
  const base = { addresses, usdcDecimals: 6, minRewardBank: 0, minTreasuryReserve: 5, minAac: 0, rpcUrl: "http://rpc" };
  // 10 USDC = 0x989680 ; 1 USDC = 0xF4240

  it("degraded when addresses or RPC are absent (forward-compat)", async () => {
    expect((await probeTreasuryLiquidity({ ...base, addresses: undefined, fetchImpl: balances("0x0", "0x989680") })).status).toBe("degraded");
    expect((await probeTreasuryLiquidity({ ...base, rpcUrl: undefined, fetchImpl: balances("0x0", "0x989680") })).status).toBe("degraded");
  });

  it("ok when pools are above floors; escrow shown as informational", async () => {
    const r = await probeTreasuryLiquidity({ ...base, rewardBankLiquid: 100, fetchImpl: balances("0x0", "0x989680") });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("reward 100.00");
    expect(r.detail).toContain("escrow 10.00");
  });

  it("exposes structured treasury pools (reward / reserve / aac / escrow-informational)", async () => {
    const r = await probeTreasuryLiquidity({ ...base, rewardBankLiquid: 100, fetchImpl: balances("0x0", "0x989680") });
    const byKey = Object.fromEntries((r.pools ?? []).map((p) => [p.key, p]));
    expect(byKey.reward_bank.amount).toBe(100);
    expect(byKey.reserve.amount).toBe(10);
    expect(byKey.escrow.informational).toBe(true);
    expect(byKey.escrow.floor).toBeUndefined();
  });

  it("red when the treasury reserve is below its floor", async () => {
    const r = await probeTreasuryLiquidity({ ...base, minTreasuryReserve: 50, rewardBankLiquid: 100, fetchImpl: balances("0x0", "0x989680") });
    expect(r.status).toBe("red");
    expect(r.detail).toContain("reserve 10.00 < 50");
  });

  it("red when the reward bank is below its floor", async () => {
    const r = await probeTreasuryLiquidity({ ...base, minRewardBank: 50, rewardBankLiquid: 10, fetchImpl: balances("0x0", "0x989680") });
    expect(r.status).toBe("red");
    expect(r.detail).toContain("reward 10.00 < 50");
  });

  it("declares an intentionally unfunded reserve when its floor is explicitly zero", async () => {
    const r = await probeTreasuryLiquidity({
      ...base,
      minTreasuryReserve: 0,
      treasuryReserveZeroReason: "pre-revenue reserve; payouts use the reward bank",
      rewardBankLiquid: 100,
      fetchImpl: balances("0x0", "0x0"),
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("intentionally unfunded: pre-revenue reserve");
    expect(r.pools?.find((pool) => pool.key === "reserve")?.note).toContain("Intentionally unfunded");
  });

  it("degrades when a zero reserve floor has no declared reason", async () => {
    const r = await probeTreasuryLiquidity({
      ...base,
      minTreasuryReserve: 0,
      rewardBankLiquid: 100,
      fetchImpl: balances("0x0", "0x0"),
    });
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("floor disabled without a declared reason");
  });

  it("degraded when a balance read fails", async () => {
    expect((await probeTreasuryLiquidity({ ...base, rewardBankLiquid: 100, fetchImpl: throwingFetch() })).status).toBe("degraded");
  });

  // Selector-aware mock: balanceOf → usdcHex; treasuryAccount() → an address;
  // positions() → six words with liquid first. Lets us assert the derived
  // protocol_revenue pool without touching the balanceOf path.
  function revenueFetch(cfg: { usdcHex: string; treasury?: string; positionsLiquidHex?: string }): typeof fetch {
    return (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const data = String((JSON.parse(String((init as RequestInit).body)) as { params: [{ data?: string }] }).params[0]?.data ?? "");
      let result: string = cfg.usdcHex;
      if (data.startsWith("0x339b2cff") && cfg.treasury) result = "0x" + cfg.treasury.replace(/^0x/, "").padStart(64, "0");
      else if (data.startsWith("0x4bd21445")) result = cfg.positionsLiquidHex ?? "0x" + "0".repeat(64 * 6);
      return { ok: true, status: 200, json: async () => ({ result }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("emits a protocol_revenue pool from the treasury's derived AAC position", async () => {
    // treasuryAccount() → 0x01e6…; positions().liquid = 0x1388 = 5000 raw = 0.005 USDC
    const r = await probeTreasuryLiquidity({
      ...base,
      rewardBankLiquid: 100,
      fetchImpl: revenueFetch({
        usdcHex: "0x989680",
        treasury: "0x01E6eed856e989201F4FF6346E18EAb7e46C874C",
        positionsLiquidHex: "0x" + (5000).toString(16).padStart(64, "0") + "0".repeat(64 * 5),
      }),
    });
    const revenue = (r.pools ?? []).find((p) => p.key === "protocol_revenue");
    expect(revenue).toBeDefined();
    expect(revenue?.amount).toBe(0.005);
    expect(revenue?.informational).toBe(true);
    expect(revenue?.status).toBe("ok"); // informational, never pages
  });

  it("omits protocol_revenue rather than faking a zero when the treasury read fails", async () => {
    // treasuryAccount() returns the zero address → reading is abandoned, no pool.
    const r = await probeTreasuryLiquidity({
      ...base,
      rewardBankLiquid: 100,
      fetchImpl: revenueFetch({ usdcHex: "0x989680", treasury: "0x0000000000000000000000000000000000000000" }),
    });
    expect((r.pools ?? []).some((p) => p.key === "protocol_revenue")).toBe(false);
  });
});

describe("collectProductHealthProbes (hybrid: /health chain + RPC balances)", () => {
  it("healthy: api ok (/health), chain ok (absolute block age), signer ok (direct RPC)", async () => {
    const { probes } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({ healthBody: HEALTHY_BODY, chainIdHex: CHAIN_ID_HEX, blockTimestampHex: tsHex(10_000_000, 12), gasHex: "0xDE0B6B3A7640000", usdcHex: "0x989680" }),
      { nowMs: 10_000_000 },
    );
    expect(probes.map((p) => p.name)).toEqual(["product_api", "chain_height", "signer_liquidity", "capabilities", "api_latency", "disk_headroom", "money_path", "treasury_liquidity", "external_funnel"]);
    expect(probes.map((p) => p.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(probes[2]?.detail).toContain("reward bank 100.00 USDC");
  });

  it("every CONFIG-DEPENDENT probe degrades when nothing is configured (never fake green)", async () => {
    const { probes } = await collectProductHealthProbes(cfg({ apiBaseUrl: undefined, rpcUrl: undefined }), combinedFetch({ healthBody: HEALTHY_BODY }), { nowMs: 1000 });
    // disk_headroom is deliberately excluded: it does not depend on product
    // config at all. It measures the local filesystem, that measurement
    // genuinely succeeds here, and the disk genuinely is fine — so reporting
    // "ok" is the honest answer, not a fake green. The invariant this test
    // protects is "a probe that CANNOT SEE must not report calm", and
    // disk_headroom can see. Its own unreadable→degraded path is covered in
    // disk-headroom.test.ts.
    const configDependent = probes.filter((p) => p.name !== "disk_headroom");
    expect(configDependent.map((p) => p.status)).toEqual(["degraded", "degraded", "degraded", "degraded", "degraded", "degraded", "degraded", "degraded"]);
    expect(probes.find((p) => p.name === "disk_headroom")).toBeDefined();
  });

  it("absolute age: a stale block halts IMMEDIATELY on a fresh start — no blind window (testnet → degraded)", async () => {
    const { probes } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({ healthBody: HEALTHY_BODY, chainIdHex: CHAIN_ID_HEX, blockTimestampHex: tsHex(10_000_000, 3600), gasHex: "0x1", usdcHex: "0x1" }),
      { advance: undefined, nowMs: 10_000_000 }, // advance undefined ⇒ staticForMs 0; only the absolute age can flag it
    );
    const chain = probes.find((p) => p.name === "chain_height");
    expect(chain?.status).toBe("degraded");
    expect(chain?.detail).toContain("old");
  });

  it("a stale block on MAINNET → chain_height red (pages: settlement down)", async () => {
    const mainnet: ProductHealthPayload = { ...HEALTHY_BODY, auth: { chainId: 420420419 } };
    const { probes } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({ healthBody: mainnet, chainIdHex: "0x" + (420420419).toString(16), blockTimestampHex: tsHex(10_000_000, 3600), gasHex: "0x1", usdcHex: "0x1" }),
      { nowMs: 10_000_000 },
    );
    expect(probes.find((p) => p.name === "chain_height")?.status).toBe("red");
  });

  it("RPC on the WRONG chain is ignored (drift-safe) → falls back to the block-advance tracker", async () => {
    const { probes } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({ healthBody: HEALTHY_BODY, chainIdHex: "0x" + (999).toString(16), gasHex: "0x1", usdcHex: "0x1" }),
      { advance: { lastBlock: 10612201, lastAdvanceAtMs: 0 }, nowMs: 700_000 },
    );
    const chain = probes.find((p) => p.name === "chain_height");
    expect(chain?.status).toBe("degraded");
    expect(chain?.detail).toContain("static for"); // tracker path, not absolute-age
  });

  it("returns an updated chain-advance tracker for the caller to persist", async () => {
    const { chainAdvance } = await collectProductHealthProbes(cfg(), combinedFetch({ healthBody: HEALTHY_BODY, gasHex: "0x1", usdcHex: "0x1" }), { advance: undefined, nowMs: 1000 });
    expect(chainAdvance).toEqual({ lastBlock: 10612201, lastAdvanceAtMs: 1000 });
  });

  it("emits the structured chain tick (height + observation + measured age) for the board ticker", async () => {
    const { snapshot } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({
        healthBody: HEALTHY_BODY,
        chainIdHex: CHAIN_ID_HEX,
        blockTimestampHex: tsHex(10_000_000, 12),
        gasHex: "0xDE0B6B3A7640000",
        usdcHex: "0x989680",
      }),
      { nowMs: 10_000_000 },
    );
    expect(snapshot.chain).toBeDefined();
    expect(snapshot.chain?.height).toBe(10612201);
    expect(snapshot.chain?.observedAtMs).toBe(10_000_000);
    expect(snapshot.chain?.blockAgeSec).toBe(12);
    expect(snapshot.chain?.lastAdvanceAtMs).toBe(10_000_000);
    expect(snapshot.chain?.freshSeconds).toBe(600);
  });

  it("omits the chain tick when /health reports no block height (never a placeholder number)", async () => {
    const { snapshot } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({
        healthBody: { ...HEALTHY_BODY, components: { blockchain: { ok: true, enabled: true, signerConfigured: true } } },
        chainIdHex: CHAIN_ID_HEX,
        gasHex: "0xDE0B6B3A7640000",
        usdcHex: "0x989680",
      }),
      { nowMs: 10_000_000 },
    );
    expect(snapshot.chain).toBeUndefined();
    // The rest of the snapshot still assembles — the ticker gap never blanks the board.
    expect(snapshot.chainId).toBe(420420417);
  });

  it("assembles the structured snapshot: chainId / network / solvency, and flow when settlement is present", async () => {
    const { snapshot } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({
        healthBody: {
          ...HEALTHY_BODY,
          settlement: {
            claimed24h: 41,
            submitted24h: 39,
            claimedNotSubmitted: 2,
            submittedNotSettled: 1,
            settled24h: 37,
            stuck: 1,
            failed24h: 0,
            asOf: "2026-07-05T00:00:00.000Z",
          },
        },
        chainIdHex: CHAIN_ID_HEX,
        blockTimestampHex: tsHex(10_000_000, 12),
        gasHex: "0xDE0B6B3A7640000",
        usdcHex: "0x989680",
      }),
      { nowMs: 10_000_000 },
    );
    expect(snapshot.chainId).toBe(420420417);
    expect(snapshot.network).toBe("testnet");
    expect(snapshot.solvency?.pools.filter((p) => p.key === "reward_bank")).toHaveLength(1);
    expect(snapshot.solvency?.pools.some((p) => p.key === "reward_bank" && p.amount === 100)).toBe(true);
    expect(snapshot.flow?.claimed24h).toBe(41);
    expect(snapshot.flow?.submitted24h).toBe(39);
    expect(snapshot.flow?.claimedNotSubmitted).toBe(2);
    expect(snapshot.flow?.submittedNotSettled).toBe(1);
    expect(snapshot.flow?.settled24h).toBe(37);
    expect(snapshot.flow?.stuck).toBe(1);
  });

  it("keeps new funnel fields absent for an older backend instead of fabricating zeros", async () => {
    const { snapshot } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({
        healthBody: {
          ...HEALTHY_BODY,
          settlement: {
            settled24h: 2,
            stuck: 0,
            failed24h: 0,
            asOf: "2026-07-05T00:00:00.000Z",
          },
        },
        gasHex: "0x1",
        usdcHex: "0x1",
      }),
      { nowMs: 1000 },
    );

    expect(snapshot.flow).toMatchObject({
      claimed24h: null,
      submitted24h: null,
      claimedNotSubmitted: null,
      submittedNotSettled: null,
      settled24h: 2,
    });
    expect(
      deriveMoneyPathProbe(
        fetched({
          ...HEALTHY_BODY,
          settlement: {
            settled24h: 2,
            stuck: 0,
            failed24h: 0,
            asOf: "2026-07-04T00:19:00Z",
          },
        }),
        { maxStuck: 5, maxFailed24h: 3, maxStaleMinutes: 15, nowMs: Date.parse("2026-07-04T00:20:00Z") },
      ),
    ).toMatchObject({ status: "ok", detail: "settled24h 2 (0 stuck, 0 failed)" });
  });

  it("degrades the collected money-path probe when the submitted backlog repeats", async () => {
    const { probes } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({
        healthBody: {
          ...HEALTHY_BODY,
          settlement: {
            claimed24h: 2,
            submitted24h: 2,
            claimedNotSubmitted: 0,
            submittedNotSettled: 1,
            settled24h: 2,
            stuck: 0,
            failed24h: 0,
            asOf: "2026-07-05T00:00:00.000Z",
          },
        },
        gasHex: "0x1",
        usdcHex: "0x1",
      }),
      { nowMs: 1000, previousSubmittedNotSettled: 1 },
    );

    expect(probes.find((probe) => probe.name === "money_path")).toMatchObject({
      status: "degraded",
      detail: expect.stringContaining("submittedNotSettled 1 across 2 consecutive probes"),
    });
  });

  it("keeps /health reward-bank solvency visible when direct RPC reads fail", async () => {
    const { probes, snapshot } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({
        healthBody: HEALTHY_BODY,
        rpcStatus: 429,
      }),
      { nowMs: 10_000_000 },
    );

    expect(probes.find((p) => p.name === "signer_liquidity")?.status).toBe("degraded");
    expect(snapshot.solvency?.pools).toContainEqual(
      expect.objectContaining({
        key: "reward_bank",
        amount: 100,
        unit: "USDC",
      }),
    );
  });

  it("omits the flow block when the product /health exposes no settlement (honest awaiting)", async () => {
    const { snapshot } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({ healthBody: { ...HEALTHY_BODY, settlement: undefined }, gasHex: "0x1", usdcHex: "0x1" }),
      { nowMs: 1000 },
    );
    expect(snapshot.flow).toBeUndefined();
    expect(snapshot.network).toBe("testnet");
  });
});

describe("chainBlockAge (absolute freshness, chain-matched)", () => {
  const NOW = 1_000_000; // nowSec = 1000

  it("undefined when no RPC is configured", async () => {
    expect(await chainBlockAge({ rpcUrl: undefined, expectedChainId: 420420417, nowMs: NOW, fetchImpl: combinedFetch({}) })).toBeUndefined();
  });

  it("returns the block age (s) when the RPC chainId matches /health", async () => {
    const age = await chainBlockAge({
      rpcUrl: "http://rpc",
      expectedChainId: 420420417,
      nowMs: NOW,
      fetchImpl: combinedFetch({ chainIdHex: "0x" + (420420417).toString(16), blockTimestampHex: "0x" + (1000 - 42).toString(16) }),
    });
    expect(age).toBe(42);
  });

  it("undefined when the RPC is on a DIFFERENT chain (drift-safe)", async () => {
    const age = await chainBlockAge({
      rpcUrl: "http://rpc",
      expectedChainId: 420420417,
      nowMs: NOW,
      fetchImpl: combinedFetch({ chainIdHex: "0x" + (420420419).toString(16), blockTimestampHex: "0x0" }),
    });
    expect(age).toBeUndefined();
  });

  it("undefined when the RPC read throws", async () => {
    expect(await chainBlockAge({ rpcUrl: "http://rpc", expectedChainId: 420420417, nowMs: NOW, fetchImpl: throwingFetch() })).toBeUndefined();
  });
});

describe("decideProductHealthAlert (de-dup)", () => {
  const red = evaluateProductHealth([probe("product_api", "red", "down")]);
  const healthy = evaluateProductHealth([probe("product_api", "ok")]);

  it("alerts on the rising edge (was clear)", () => {
    const d = decideProductHealthAlert({ evaluation: red, state: initialProductHealthAlertState(), nowMs: 1000, cooldownMs: 60_000 });
    expect(d.alert).toBe(true);
    expect(d.state.lastRedKey).toBe("product_api");
  });

  it("suppresses an unchanged red set within the cooldown", () => {
    const state: ProductHealthAlertState = { lastRedKey: "product_api", lastAlertAtMs: 1000 };
    expect(decideProductHealthAlert({ evaluation: red, state, nowMs: 2000, cooldownMs: 60_000 }).alert).toBe(false);
  });

  it("re-alerts after the cooldown elapses", () => {
    const state: ProductHealthAlertState = { lastRedKey: "product_api", lastAlertAtMs: 1000 };
    expect(decideProductHealthAlert({ evaluation: red, state, nowMs: 1000 + 60_000, cooldownMs: 60_000 }).alert).toBe(true);
  });

  it("alerts immediately when the red set changes", () => {
    const red2 = evaluateProductHealth([probe("chain_height", "red", "halt")]);
    const state: ProductHealthAlertState = { lastRedKey: "product_api", lastAlertAtMs: 1000 };
    expect(decideProductHealthAlert({ evaluation: red2, state, nowMs: 2000, cooldownMs: 60_000 }).alert).toBe(true);
  });

  it("resets the episode when healthy", () => {
    const state: ProductHealthAlertState = { lastRedKey: "product_api", lastAlertAtMs: 1000 };
    const d = decideProductHealthAlert({ evaluation: healthy, state, nowMs: 2000, cooldownMs: 60_000 });
    expect(d.alert).toBe(false);
    expect(d.state.lastRedKey).toBe("");
  });
});

describe("runProductHealthOnce", () => {
  function harness(probes: ProbeResult[]): { alerts: AlertPayload[]; deps: ProductHealthDeps } {
    let state = initialProductHealthAlertState();
    const alerts: AlertPayload[] = [];
    return {
      alerts,
      deps: {
        runProbes: async () => probes,
        alert: async (p) => {
          alerts.push(p);
          return true;
        },
        boardUrl: "https://board",
        nowMs: () => 5000,
        getAlertState: () => state,
        setAlertState: (s) => {
          state = s;
        },
        cooldownMs: 60_000,
      },
    };
  }

  it("does not alert when healthy", async () => {
    const h = harness([probe("product_api", "ok")]);
    const r = await runProductHealthOnce(h.deps);
    expect(r.status).toBe("healthy");
    expect(r.alerted).toBe(false);
  });

  it("does not alert when only degraded (a testnet freeze)", async () => {
    const h = harness([probe("chain_height", "degraded", "not advancing")]);
    const r = await runProductHealthOnce(h.deps);
    expect(r.status).toBe("degraded");
    expect(r.alerted).toBe(false);
  });

  it("alerts on red and renders the red probe detail", async () => {
    const h = harness([probe("signer_liquidity", "red", "gas 0.01 < 0.1")]);
    const r = await runProductHealthOnce(h.deps);
    expect(r.alerted).toBe(true);
    expect(h.alerts[0]?.text).toContain("signer_liquidity");
    expect(h.alerts[0]?.text).toContain("gas 0.01");
  });
});

describe("loadProductHealthConfig", () => {
  it("defaults: /health path, testnet RPC, 600s freshness, auto halt severity", () => {
    const c = loadProductHealthConfig({});
    expect(c.apiBaseUrl).toBeUndefined();
    expect(c.apiHealthPath).toBe("/health");
    expect(c.rpcUrl).toBe(TESTNET_RPC); // WALLET_NETWORK absent → testnet
    expect(c.chainMaxStaleSeconds).toBe(600);
    expect(c.haltSeverity).toBe("auto");
    expect(c.usdcDecimals).toBe(6);
    expect(c.minGasNative).toBe(0);
    expect(c.requiredCapabilities).toEqual(["blockchain", "treasuryMutations"]);
    expect(c.expectedWarnings).toContain("indexer_unavailable");
    expect(c.latencyWarnMs).toBe(2000);
    expect(c.latencyRedMs).toBe(10000);
    expect(c.maxStuck).toBe(5);
    expect(c.maxFailed24h).toBe(3);
    expect(c.settlementMaxStaleMinutes).toBe(15);
    expect(c.minTreasuryReserve).toBe(5);
    expect(c.minRewardBank).toBe(0);
    expect(c.minAac).toBe(0);
  });

  it("reads env overrides", () => {
    const c = loadProductHealthConfig({
      AVERRAY_API_BASE_URL: "https://api.x/",
      PRODUCT_HEALTH_RPC_URL: "http://rpc",
      PRODUCT_HEALTH_USDC_ADDRESS: "0xusdc",
      PRODUCT_HEALTH_MIN_REWARD_BANK: "5",
      PRODUCT_HEALTH_MIN_TREASURY_RESERVE: "0",
      PRODUCT_HEALTH_TREASURY_RESERVE_ZERO_REASON: "pre-revenue reserve",
      PRODUCT_HEALTH_HALT_SEVERITY: "red",
      PRODUCT_HEALTH_CHAIN_MAX_STALE_SECONDS: "120",
    });
    expect(c.apiBaseUrl).toBe("https://api.x");
    expect(c.rpcUrl).toBe("http://rpc");
    expect(c.usdcAddress).toBe("0xusdc");
    expect(c.minRewardBank).toBe(5);
    expect(c.minTreasuryReserve).toBe(0);
    expect(c.treasuryReserveZeroReason).toBe("pre-revenue reserve");
    expect(c.haltSeverity).toBe("red");
    expect(c.chainMaxStaleSeconds).toBe(120);
  });
});

describe("networkEthRpc", () => {
  it("resolves testnet to the live host (default + case-insensitive), leaves mainnet unset", () => {
    expect(networkEthRpc(undefined)).toBe(TESTNET_RPC);
    expect(networkEthRpc("TestNet")).toBe(TESTNET_RPC);
    expect(networkEthRpc("mainnet")).toBeUndefined();
  });
});

describe("appendHistory", () => {
  const snap = (at: number, status: ProductHealthStatus): ProductHealthSnapshot => ({
    at,
    status,
    probes: [probe("product_api", status === "healthy" ? "ok" : status === "red" ? "red" : "degraded")],
  });

  it("appends newest-last", () => {
    const h = appendHistory([snap(1, "healthy")], snap(2, "red"), 10);
    expect(h.map((s) => s.at)).toEqual([1, 2]);
  });

  it("bounds to maxLen, dropping the oldest", () => {
    let h: ProductHealthSnapshot[] = [];
    for (let i = 1; i <= 5; i++) h = appendHistory(h, snap(i, "healthy"), 3);
    expect(h.map((s) => s.at)).toEqual([3, 4, 5]);
  });

  it("maxLen <= 0 keeps everything (unbounded)", () => {
    expect(appendHistory([snap(1, "healthy")], snap(2, "healthy"), 0)).toHaveLength(2);
  });
});

describe("probeSparkline", () => {
  const history: ProductHealthSnapshot[] = [
    { at: 1, status: "healthy", probes: [probe("api", "ok")] },
    { at: 2, status: "red", probes: [probe("api", "red")] },
    { at: 3, status: "degraded", probes: [probe("api", "degraded")] },
  ];

  it("returns the last N statuses, oldest to newest", () => {
    expect(probeSparkline(history, "api", 10)).toEqual(["ok", "red", "degraded"]);
    expect(probeSparkline(history, "api", 2)).toEqual(["red", "degraded"]);
  });

  it("skips checks where the probe is absent", () => {
    const h: ProductHealthSnapshot[] = [...history, { at: 4, status: "healthy", probes: [probe("other", "ok")] }];
    expect(probeSparkline(h, "api", 10)).toEqual(["ok", "red", "degraded"]);
  });

  it("returns empty for an unknown probe", () => {
    expect(probeSparkline(history, "nope", 10)).toEqual([]);
  });
});

describe("deriveProductHealthHistory", () => {
  const HOUR = 3_600_000;
  const snap = (
    at: number,
    status: ProductHealthStatus,
    opts: { probes?: ProbeResult[]; latencyMs?: number | null; signerUsdc?: number | null } = {},
  ): ProductHealthSnapshot => ({
    at,
    status,
    probes: opts.probes ?? [probe("product_api", status === "healthy" ? "ok" : status)],
    latencyMs: opts.latencyMs,
    signerUsdc: opts.signerUsdc,
  });

  it("builds the uptime / latency / balance series oldest→newest", () => {
    const now = 100 * HOUR;
    const history = [
      snap(now - 2 * HOUR, "healthy", { latencyMs: 120, signerUsdc: 10 }),
      snap(now - 1 * HOUR, "degraded", { latencyMs: 240, signerUsdc: 8 }),
      snap(now, "red", { latencyMs: null, signerUsdc: null }),
    ];
    const b = deriveProductHealthHistory(history, now);
    expect(b.uptimeSeries).toEqual(["ok", "degraded", "red"]);
    expect(b.latencySeriesMs).toEqual([120, 240, null]);
    expect(b.balanceSeries).toEqual([10, 8, null]);
  });

  it("uptimePct24h uses only determinate product-api availability samples", () => {
    const now = 100 * HOUR;
    // A degraded product_api result is unknown, not evidence of either uptime or
    // downtime: two reachable samples / three determinate samples → 66.7%.
    const history = [
      snap(now - 3 * HOUR, "healthy"),
      snap(now - 2 * HOUR, "degraded"),
      snap(now - 1 * HOUR, "red"),
      snap(now, "healthy"),
    ];
    expect(deriveProductHealthHistory(history, now).uptimePct24h).toBe(66.7);
    // a check older than the 24h window doesn't count → null
    const stale = [snap(now - 30 * HOUR, "healthy")];
    expect(deriveProductHealthHistory(stale, now).uptimePct24h).toBeNull();
  });

  it("does not count monitor/RPC failures as product downtime", () => {
    const now = 100 * HOUR;
    const history = Array.from({ length: 5 }, (_, i) =>
      snap(now - (4 - i) * HOUR, "red", {
        probes: [
          probe("product_api", "ok", "HTTP 200 · service ok"),
          probe("signer_liquidity", "red", "balance read failed: RPC endpoint throttled (HTTP 429)"),
        ],
      }),
    );

    const block = deriveProductHealthHistory(history, now);
    expect(block.uptimePct24h).toBe(100);
    expect(block.uptimeSeries).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  it("bounds the series to maxSeries (newest-anchored); uptime% still spans the window", () => {
    const now = 100 * HOUR;
    const history = Array.from({ length: 60 }, (_, i) =>
      snap(now - (60 - i) * 60_000, "healthy", { latencyMs: i }),
    );
    const b = deriveProductHealthHistory(history, now, { maxSeries: 10 });
    expect(b.uptimeSeries).toHaveLength(10);
    expect(b.latencySeriesMs).toEqual(Array.from({ length: 10 }, (_, i) => 50 + i));
    expect(b.uptimePct24h).toBe(100); // all 60 in-window, none red
  });

  it("derives an incident episode — red severity wins, unrecovered stays open", () => {
    const now = 100 * HOUR;
    const history = [
      snap(now - 4 * HOUR, "healthy", { probes: [probe("chain_height", "ok")] }),
      snap(now - 3 * HOUR, "degraded", { probes: [probe("chain_height", "degraded", "chain not advancing")] }),
      snap(now - 2 * HOUR, "red", { probes: [probe("chain_height", "red", "chain halted")] }),
      snap(now - 1 * HOUR, "red", { probes: [probe("chain_height", "red", "chain halted")] }),
    ];
    const inc = deriveProductHealthHistory(history, now).incidents;
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({
      probe: "chain_height",
      severity: "red",
      startedAt: now - 3 * HOUR,
      endedAt: null,
      note: "chain halted",
    });
  });

  it("closes an incident on recovery and excludes awaiting-data degradations", () => {
    const now = 100 * HOUR;
    const history = [
      // a real degradation that recovers
      snap(now - 4 * HOUR, "degraded", { probes: [probe("api_latency", "degraded", "slow: 900ms")] }),
      snap(now - 3 * HOUR, "healthy", { probes: [probe("api_latency", "ok")] }),
      // an awaiting-data "degraded" (forward-compat gap) must NOT become an incident
      snap(now - 2 * HOUR, "degraded", { probes: [probe("money_path", "degraded", "does not expose settlement counts yet")] }),
      snap(now - 1 * HOUR, "degraded", { probes: [probe("money_path", "degraded", "does not expose settlement counts yet")] }),
    ];
    const inc = deriveProductHealthHistory(history, now).incidents;
    expect(inc).toHaveLength(1);
    expect(inc[0]).toMatchObject({
      probe: "api_latency",
      severity: "degraded",
      startedAt: now - 4 * HOUR,
      endedAt: now - 3 * HOUR,
    });
  });

  it("records one root incident when an unreadable /health fans out to dependent probes", () => {
    const now = 100 * HOUR;
    const probes: ProbeResult[] = [
      probe("product_api", "red", "unreachable: fetch failed"),
      probe("chain_height", "degraded", "chain status unavailable (product /health not readable)"),
      probe("capabilities", "degraded", "capability status unavailable (product /health not readable)"),
      probe("api_latency", "degraded", "no response after 45ms"),
      probe("money_path", "degraded", "settlement status unavailable (product /health not readable)"),
    ];
    const history = [snap(now, "red", { probes })];

    const incidents = deriveProductHealthHistory(history, now).incidents;
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      probe: "product_api",
      severity: "red",
      note: "unreachable: fetch failed",
    });
  });

  it("sorts multiple incidents newest-first", () => {
    const now = 100 * HOUR;
    const history = [
      snap(now - 5 * HOUR, "red", { probes: [probe("product_api", "red", "503")] }),
      snap(now - 4 * HOUR, "healthy", { probes: [probe("product_api", "ok")] }),
      snap(now - 2 * HOUR, "degraded", { probes: [probe("chain_height", "degraded", "chain not advancing")] }),
      snap(now - 1 * HOUR, "degraded", { probes: [probe("chain_height", "degraded", "chain not advancing")] }),
    ];
    const inc = deriveProductHealthHistory(history, now).incidents;
    expect(inc.map((i) => i.probe)).toEqual(["chain_height", "product_api"]);
  });

  it("no history → empty series, null uptime, no incidents", () => {
    const b = deriveProductHealthHistory([], 100 * HOUR);
    expect(b.uptimeSeries).toEqual([]);
    expect(b.latencySeriesMs).toEqual([]);
    expect(b.balanceSeries).toEqual([]);
    expect(b.uptimePct24h).toBeNull();
    expect(b.incidents).toEqual([]);
  });
});

describe("deriveLiquidityRunway", () => {
  const HOUR = 3_600_000;
  const bal = (at: number, usdc: number | null, gas: number | null = null): ProductHealthSnapshot => ({
    at,
    status: "healthy",
    probes: [],
    signerUsdc: usdc,
    signerGas: gas,
  });
  const usdcPool = (amount: number | null, floor: number | null = 1): SolvencyPoolData => ({
    key: "reward_bank",
    label: "reward bank",
    amount,
    unit: "USDC",
    floor,
    status: "ok",
  });

  const gasPool = (amount: number, floor = 1): SolvencyPoolData => ({
    key: "signer_gas", label: "signer gas", amount, unit: "DOT", floor, status: "ok",
  });

  it("a TOP-UP no longer cancels the burn — measured spend has no balance in it", () => {
    // THE DEFECT. A slope fitted to balances reads a deposit as refilling, so
    // burn <= 0, hoursToFloor null, "stable". The burn does not shrink; it
    // vanishes — exactly when the operator is most engaged with the pool.
    // Observed live: 1.9622728 + 5 − 2.049685 = 4.9125877, a rising balance
    // while gas was being spent the whole time.
    const now = 10 * HOUR;
    const risingBalance = [
      bal(now - 6 * HOUR, null, 2.0),
      bal(now - 3 * HOUR, null, 6.5), // the top-up lands
      bal(now, null, 6.2),
    ];
    const slopeOnly = deriveLiquidityRunway(risingBalance, [gasPool(6.2)], now);
    expect(slopeOnly.pools[0]!.hoursToFloor, "the slope hides the burn").toBeNull();
    expect(slopeOnly.pools[0]!.basis).toBe("balance-slope");

    // Same window, same top-up, measured consumption: the countdown survives.
    const measured = deriveLiquidityRunway(risingBalance, [gasPool(6.2)], now, {
      measuredBurn: { signer_gas: { perHour: 0.0702, windowHours: 24 } },
    });
    expect(measured.pools[0]!.basis).toBe("measured-spend");
    expect(measured.pools[0]!.hoursToFloor).toBeCloseTo((6.2 - 1) / 0.0702, 0);
    expect(measured.note).toContain("at the last 24h of measured burn");
  });

  it("a measured rate projects even with NO history at all", () => {
    // The slope needs 3 samples over 15 minutes held in memory, and that memory
    // resets on every deploy — so right after a restart the board could not
    // project anything. A rate read from chain does not care.
    const r = deriveLiquidityRunway([], [gasPool(9.52)], 10 * HOUR, {
      measuredBurn: { signer_gas: { perHour: 0.0702, windowHours: 24 } },
    });
    expect(r.pools[0]!.estimable).toBe(true);
    // 8.52 DOT above floor at 0.0702/h ≈ 121h ≈ 5 days, against the ~3d the
    // six-hour balance regression was reporting on the live board.
    expect(r.pools[0]!.hoursToFloor! / 24).toBeGreaterThan(4.5);
  });

  it("zero measured spend is stable, and says so without a countdown", () => {
    const r = deriveLiquidityRunway([], [gasPool(9.52)], 10 * HOUR, {
      measuredBurn: { signer_gas: { perHour: 0, windowHours: 24 } },
    });
    expect(r.pools[0]!.hoursToFloor).toBeNull();
    expect(r.pools[0]!.status).toBe("ok");
    expect(r.pools[0]!.estimable).toBe(true);
  });

  it("projects a countdown from a steady drain (degraded band)", () => {
    const now = 6 * HOUR;
    // 19 → 13 over 6h = 1 USDC/h; floor 1 ⇒ (13-1)/1 = 12h ⇒ degraded
    const history = Array.from({ length: 7 }, (_, i) => bal(i * HOUR, 19 - i));
    const r = deriveLiquidityRunway(history, [usdcPool(13)], now);
    expect(r.pools).toHaveLength(1);
    expect(r.pools[0].burnPerHour).toBeCloseTo(1, 6);
    expect(r.pools[0].hoursToFloor).toBeCloseTo(12, 6);
    expect(r.pools[0].status).toBe("degraded");
    expect(r.note).toBe("reward bank ~12h to floor from the balance trend");
  });

  it("pages (red) when the floor is < 6h out", () => {
    const now = 6 * HOUR;
    // 13 → 5 over 4h = 2/h; current 5, floor 1 ⇒ (5-1)/2 = 2h ⇒ red
    const history = [bal(2 * HOUR, 13), bal(3 * HOUR, 11), bal(4 * HOUR, 9), bal(5 * HOUR, 7), bal(6 * HOUR, 5)];
    const r = deriveLiquidityRunway(history, [usdcPool(5)], now);
    expect(r.pools[0].hoursToFloor).toBeCloseTo(2, 6);
    expect(r.pools[0].status).toBe("red");
    expect(r.note).toBe("reward bank ~2h to floor from the balance trend");
  });

  it("reads stable — not a fake countdown — when the balance is flat", () => {
    const now = 6 * HOUR;
    const history = Array.from({ length: 7 }, (_, i) => bal(i * HOUR, 5));
    const r = deriveLiquidityRunway(history, [usdcPool(5)], now);
    expect(r.pools[0].hoursToFloor).toBeNull();
    expect(r.pools[0].estimable).toBe(true);
    expect(r.pools[0].status).toBe("ok");
    expect(r.note).toBe("stable — no depletion trend");
  });

  it("reads stable when the balance is refilling (rising)", () => {
    const now = 6 * HOUR;
    const history = Array.from({ length: 7 }, (_, i) => bal(i * HOUR, 3 + i));
    const r = deriveLiquidityRunway(history, [usdcPool(9)], now);
    expect(r.pools[0].hoursToFloor).toBeNull();
    expect(r.pools[0].burnPerHour ?? 0).toBeLessThanOrEqual(0);
    expect(r.note).toBe("stable — no depletion trend");
  });

  it("awaits samples (not stable) when there is too little data", () => {
    const now = 6 * HOUR;
    const history = [bal(5 * HOUR, 8), bal(6 * HOUR, 7)]; // 2 samples < min 3
    const r = deriveLiquidityRunway(history, [usdcPool(7)], now);
    expect(r.pools[0].estimable).toBe(false);
    expect(r.pools[0].hoursToFloor).toBeNull();
    expect(r.note).toBeNull(); // no estimable pool ⇒ frontend shows awaiting-data
  });

  it("reports 0h at/below the floor regardless of trend", () => {
    const now = 6 * HOUR;
    const history = Array.from({ length: 7 }, (_, i) => bal(i * HOUR, 1));
    const r = deriveLiquidityRunway(history, [usdcPool(1, 1)], now); // current == floor
    expect(r.pools[0].hoursToFloor).toBe(0);
    expect(r.pools[0].status).toBe("red");
    expect(r.note).toBe("reward bank at floor");
  });

  it("skips informational + series-less pools; the nearest depleting pool wins the note", () => {
    const now = 6 * HOUR;
    const history = Array.from({ length: 7 }, (_, i) => bal(i * HOUR, 19 - i, 5000)); // gas flat 5000
    const pools: SolvencyPoolData[] = [
      { key: "signer_gas", label: "signer gas", amount: 5000, unit: "PAS", floor: 1, status: "ok" }, // stable, kept
      usdcPool(13), // draining ⇒ 12h
      { key: "reserve", label: "Treasury reserve", amount: 100, unit: "USDC", floor: 25, status: "ok" }, // no series ⇒ skip
      { key: "escrow", label: "Escrow", amount: 96, unit: "USDC", status: "ok", informational: true }, // informational ⇒ skip
    ];
    const r = deriveLiquidityRunway(history, pools, now);
    expect(r.pools.map((p) => p.key)).toEqual(["signer_gas", "reward_bank"]);
    expect(r.note).toBe("reward bank ~12h to floor from the balance trend"); // gas is stable ⇒ usdc is the nearest
  });
});

describe("decideRunwayAlert", () => {
  const HOUR = 3_600_000;
  const pool = (key: string, status: ProbeResult["status"], hours: number | null = 5): LiquidityRunwayPool => ({
    key,
    label: key,
    unit: "USDC",
    current: 3,
    floor: 1,
    burnPerHour: 0.4,
    hoursToFloor: hours,
    estimable: true,
    status,
  });
  const rw = (...pools: LiquidityRunwayPool[]): LiquidityRunway => ({ pools, note: null });

  it("fires on the rising edge into the danger band, then stays quiet within cooldown", () => {
    const first = decideRunwayAlert({ runway: rw(pool("reward_bank", "degraded")), state: initialRunwayAlertState(), nowMs: 1000, cooldownMs: HOUR });
    expect(first.alert).toBe(true);
    const again = decideRunwayAlert({ runway: rw(pool("reward_bank", "degraded")), state: first.state, nowMs: 1000 + 5 * 60_000, cooldownMs: HOUR });
    expect(again.alert).toBe(false);
  });

  it("re-fires when the danger worsens (degraded → red) even within cooldown", () => {
    const first = decideRunwayAlert({ runway: rw(pool("reward_bank", "degraded")), state: initialRunwayAlertState(), nowMs: 0, cooldownMs: HOUR });
    const worse = decideRunwayAlert({ runway: rw(pool("reward_bank", "red", 2)), state: first.state, nowMs: 60_000, cooldownMs: HOUR });
    expect(worse.alert).toBe(true);
  });

  it("re-fires after the cooldown while the danger persists", () => {
    const first = decideRunwayAlert({ runway: rw(pool("reward_bank", "degraded")), state: initialRunwayAlertState(), nowMs: 0, cooldownMs: HOUR });
    const later = decideRunwayAlert({ runway: rw(pool("reward_bank", "degraded")), state: first.state, nowMs: HOUR + 1, cooldownMs: HOUR });
    expect(later.alert).toBe(true);
  });

  it("clears (no alert, key reset) once every pool is out of the band", () => {
    const first = decideRunwayAlert({ runway: rw(pool("reward_bank", "red", 2)), state: initialRunwayAlertState(), nowMs: 0, cooldownMs: HOUR });
    const safe = decideRunwayAlert({ runway: rw(pool("reward_bank", "ok", null)), state: first.state, nowMs: 60_000, cooldownMs: HOUR });
    expect(safe.alert).toBe(false);
    expect(safe.state.lastDangerKey).toBe("");
  });

  it("stays quiet when nothing is in the danger band", () => {
    const d = decideRunwayAlert({ runway: rw(pool("reward_bank", "ok", null), pool("signer_gas", "ok", null)), state: initialRunwayAlertState(), nowMs: 0, cooldownMs: HOUR });
    expect(d.alert).toBe(false);
  });
});

describe("buildRunwayAlertPayload", () => {
  const pool = (key: string, status: ProbeResult["status"], hours: number): LiquidityRunwayPool => ({
    key,
    label: key === "reward_bank" ? "reward bank" : "signer gas",
    unit: "USDC",
    current: 3,
    floor: 1,
    burnPerHour: 0.4,
    hoursToFloor: hours,
    estimable: true,
    status,
  });

  it("summarises the danger pools nearest-first with a board link", () => {
    const runway: LiquidityRunway = { pools: [pool("signer_gas", "degraded", 20), pool("reward_bank", "red", 3)], note: null };
    const p = buildRunwayAlertPayload(runway, "https://board");
    expect(p.count).toBe(2);
    expect(p.items[0].id).toBe("runway-reward_bank"); // nearest first
    expect(p.items[0].title).toContain("~3h to floor");
    expect(p.boardUrl).toBe("https://board");
    expect(p.text).toContain("reward bank ~3h to floor");
    expect(p.text).toContain("operator action");
  });

  it("excludes stable pools from the payload", () => {
    const runway: LiquidityRunway = { pools: [{ ...pool("reward_bank", "ok", 0), hoursToFloor: null }, pool("signer_gas", "degraded", 10)], note: null };
    const p = buildRunwayAlertPayload(runway, "https://board");
    expect(p.count).toBe(1);
    expect(p.items[0].id).toBe("runway-signer_gas");
  });
});

// ── payout evidence ────────────────────────────────────────────────────────
// `settled24h` counts rows in the product's DB. These prove money actually
// moved, and the DISCREPANCY between the two is the signal.
describe("decidePayoutEvidence (pure verdict)", () => {
  const base = { windowBlocks: 14400, tolerance: 1 };

  it("confirmed when on-chain transfers match the settled count", () => {
    const r = decidePayoutEvidence({ ...base, confirmedCount: 13, confirmedUsdc: 4.2, settledCount: 13 });
    expect(r.status).toBe("confirmed");
    expect(r.detail).toContain("13 payouts confirmed on-chain");
    expect(r.detail).toContain("4.20 USDC");
  });

  it("SHORTFALL when jobs are marked settled but the money never moved", () => {
    // The failure nothing else on the board can see today.
    const r = decidePayoutEvidence({ ...base, confirmedCount: 9, confirmedUsdc: 2.7, settledCount: 13 });
    expect(r.status).toBe("shortfall");
    expect(r.detail).toContain("13 jobs marked settled");
    expect(r.detail).toContain("4 unaccounted for");
    expect(r.detail).toContain("investigate");
  });

  it("tolerates a 1-job gap — the two windows have different clocks", () => {
    // settled24h is a rolling 24h; the log read is an approximate block window.
    // Crying wolf on a boundary artifact trains the operator to ignore the real one.
    const r = decidePayoutEvidence({ ...base, confirmedCount: 12, confirmedUsdc: 3.6, settledCount: 13 });
    expect(r.status).toBe("confirmed");
  });

  it("more transfers than settled jobs is never a shortfall", () => {
    expect(decidePayoutEvidence({ ...base, confirmedCount: 20, confirmedUsdc: 6, settledCount: 13 }).status).toBe("confirmed");
  });

  it("UNVERIFIED (never 'nothing paid') when the read failed or is off", () => {
    const r = decidePayoutEvidence({
      ...base, confirmedCount: null, confirmedUsdc: null, settledCount: 13, windowBlocks: null,
      unverifiedReason: "payout evidence off (set PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED=true)",
    });
    expect(r.status).toBe("unverified");
    expect(r.detail).toContain("PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED");
    expect(r.confirmedCount).toBeNull(); // never 0 — 0 would read as "nothing paid"
  });

  it("reports real evidence even with nothing to compare against", () => {
    const r = decidePayoutEvidence({ ...base, confirmedCount: 3, confirmedUsdc: 1.5, settledCount: null });
    expect(r.status).toBe("confirmed");
    expect(r.detail).toContain("no settled count to compare");
  });
});

describe("resolvePayoutLookback — size the window, do not assume it", () => {
  // decideWindowFit already computed the right number and only ever PRINTED it
  // ("~40909 blocks would match"). Reporting the correct window while scanning
  // the wrong one leaves the operator reconciling two numbers by hand forever.
  it("derives the window from the measured block time", () => {
    // Mainnet 2026-08-02: 2.112s/block, so 24h is 40909 blocks — not the 43200
    // that was configured for an assumed 2.0s.
    const r = resolvePayoutLookback({ blockSeconds: 2.112, maxBlocks: 60000, targetHours: 24 });
    expect(r.blocks).toBe(40909);
    expect(r.derived).toBe(true);
  });

  it("treats the configured value as a CEILING, never as the window", () => {
    // It exists for RPCs that cap eth_getLogs ranges — a limit on what we may
    // ask for, not a statement about how long 24 hours is.
    const r = resolvePayoutLookback({ blockSeconds: 2.112, maxBlocks: 10000, targetHours: 24 });
    expect(r.blocks).toBe(10000);
    expect(r.derived).toBe(true);
  });

  it("falls back to the ceiling when the chain could not be sampled", () => {
    // An unmeasured block time is exactly when a guess is least trustworthy, so
    // behaviour stays what the operator configured and the fit reads unchecked.
    for (const bad of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = resolvePayoutLookback({ blockSeconds: bad, maxBlocks: 43200, targetHours: 24 });
      expect(r.blocks).toBe(43200);
      expect(r.derived).toBe(false);
    }
  });

  it("would have caught the 6s assumption that shipped as the default", () => {
    // The old default was 14400 with the comment "~24h at a 6s block time". At
    // the real 2.112s that spans 8.4 HOURS against a 24h ledger count — the
    // SHORT direction, which under-counts payouts and manufactures a shortfall.
    const span = (14400 * 2.112) / 3600;
    expect(span).toBeLessThan(9);
    const r = resolvePayoutLookback({ blockSeconds: 2.112, maxBlocks: 14400, targetHours: 24 });
    expect(r.blocks).toBe(14400); // ceiling binds — and decideWindowFit says "suspect"
  });
});

describe("withFeeSplit — the split must actually reach the payload", () => {
  // THE REGRESSION, found on the live board. readPayoutTransfers computed
  // feeCount/feeUsdc/feesSeparated correctly and PayoutEvidence never carried
  // them, so /monitor/product-health shipped with the fields simply absent.
  // The full suite stayed green because nothing asserted the assembly — the
  // split was right and invisible.
  const verdict = {
    status: "confirmed" as const, detail: "ok",
    confirmedCount: 16, confirmedUsdc: 2.9, settledCount: 16, windowBlocks: 43200,
  };

  it("carries the fee numbers through to the evidence", () => {
    const r = withFeeSplit(verdict, { feeCount: 3, feeUsdc: 0.105, feesSeparated: true });
    expect(r.feeCount).toBe(3);
    expect(r.feeUsdc).toBeCloseTo(0.105, 6);
    expect(r.feesSeparated).toBe(true);
  });

  it("preserves the verdict untouched", () => {
    // Fees explain which settlements were counted; they must not alter whether
    // payouts reconcile.
    const r = withFeeSplit(verdict, { feeCount: 3, feeUsdc: 0.105, feesSeparated: true });
    expect(r.status).toBe("confirmed");
    expect(r.confirmedCount).toBe(16);
    expect(r.settledCount).toBe(16);
  });

  it("passes through NULL when fees could not be separated", () => {
    const r = withFeeSplit(verdict, { feeCount: null, feeUsdc: null, feesSeparated: false });
    expect(r.feeCount).toBeNull();
    expect(r.feesSeparated).toBe(false);
    // null, not absent: a reader must be able to tell "could not look" from
    // "this build does not report fees at all".
    expect("feeCount" in r).toBe(true);
  });
});

describe("readPayoutTransfers (chain-guarded log read)", () => {
  const USDC = "0x0000053900000000000000000000000001200000";
  const cfg = {
    rpcUrl: "http://rpc", sourceAddress: "0xaac", usdcAddress: USDC,
    usdcDecimals: 6, lookbackBlocks: 100,
  };
  const word = (v: string) => v.replace(/^0x/, "").padStart(64, "0");
  /**
   * A ReservationSettled log, shaped exactly as mainnet emits it:
   * data = [asset, amount]. Captured from a real payout on 2026-07-29
   * (0.1 USDC, block ~18.8M) — the layout this probe has to parse.
   */
  const settled = (usdc: number, asset: string = USDC) => ({
    topics: [
      "0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee",
      `0x${word("0xj0b")}`,
      `0x${word("0x5a6836c6d4d293f6e5377e6c28054f4171915813")}`,
      `0x${word("0x1734cd78a79cb3c1d926af5ae0ab466d9dfddc55")}`,
    ],
    data: `0x${word(asset)}${word(`0x${Math.round(usdc * 1e6).toString(16)}`)}`,
  });

  // eth_chainId → chain, eth_blockNumber → height, eth_getLogs → payout events.
  function rpc(chainIdHex: string, logs: unknown): typeof fetch {
    return (async (_u: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const m = rpcMethod(init ?? {});
      const result = m === "eth_chainId" ? chainIdHex : m === "eth_blockNumber" ? "0x3e8" : logs;
      return { ok: true, status: 200, json: async () => ({ result }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("counts payout events and sums the USDC actually moved", async () => {
    const logs = [settled(1), settled(2)];
    const r = await readPayoutTransfers({ ...cfg, expectedChainId: 420420419, fetchImpl: rpc("0x190f1b43", logs) });
    expect(r.count).toBe(2);
    expect(r.usdc).toBeCloseTo(3, 6);
    expect(r.windowBlocks).toBe(100);
  });

  // ── Fees ride the SAME event, distinguished only by recipient ────────────
  const TREASURY = "0x01e6eed856e989201f4ff6346e18eab7e46c874c";
  /** Same event, recipient = the fee treasury. Revenue, not a payout. */
  const feeCredit = (usdc: number) => ({
    ...settled(usdc),
    topics: [
      "0x3cdc0be5ec7141f2342208f6404c1b1852936343f0edf1fda179e6c9f46573ee",
      `0x${word("0xfee")}`,
      `0x${word("0x5a6836c6d4d293f6e5377e6c28054f4171915813")}`,
      `0x${word(TREASURY)}`,
    ],
  });

  it("does NOT count a fee credit as a payout", async () => {
    // THE DEFECT, from mainnet 2026-08-02: the panel read 19 confirmed against
    // 16 settled and called it "no gap". The excess of exactly 3 was exactly
    // the 3 fee credits — same ReservationSettled event, recipient = treasury.
    const logs = [settled(1), settled(1), feeCredit(0.05)];
    const r = await readPayoutTransfers({
      ...cfg, expectedChainId: 420420419, feeRecipientAddress: TREASURY,
      fetchImpl: rpc("0x190f1b43", logs),
    });
    expect(r.count).toBe(2);
    expect(r.usdc).toBeCloseTo(2, 6);
    expect(r.feeCount).toBe(1);
    expect(r.feeUsdc).toBeCloseTo(0.05, 6);
    expect(r.feesSeparated).toBe(true);
  });

  it("keeps a real shortfall visible instead of letting fees mask it", async () => {
    // WHY IT MATTERS. A fee arrives on every fee-bearing settlement, so the
    // inflation is permanent: three missing payouts plus three fee credits net
    // to zero and `shortfall` can never fire. Ledger claims 5; the chain has 2
    // payouts and 3 fees. Conflated that reads 5 — clean. Split, the gap lives.
    const logs = [settled(1), settled(1), feeCredit(0.05), feeCredit(0.05), feeCredit(0.05)];
    const r = await readPayoutTransfers({
      ...cfg, expectedChainId: 420420419, feeRecipientAddress: TREASURY,
      fetchImpl: rpc("0x190f1b43", logs),
    });
    expect(r.count).toBe(2);
    expect(r.count! + (r.feeCount ?? 0)).toBe(5); // what it used to report
  });

  it("says it CANNOT separate fees rather than assuming none", async () => {
    // Without a treasury address the two are indistinguishable. Reporting 0
    // fees would claim none were taken; null says we could not look — the same
    // unverified-vs-shortfall distinction the rest of the board makes.
    const r = await readPayoutTransfers({
      ...cfg, expectedChainId: 420420419, fetchImpl: rpc("0x190f1b43", [settled(1), feeCredit(0.05)]),
    });
    expect(r.feesSeparated).toBe(false);
    expect(r.feeCount).toBeNull();
    expect(r.feeUsdc).toBeNull();
    expect(r.count).toBe(2); // legacy behaviour, honestly flagged
  });

  it("matches the recipient case-insensitively", async () => {
    // topic3 arrives lowercase from the RPC; a checksummed address in config
    // must still match, or the split silently never fires.
    const r = await readPayoutTransfers({
      ...cfg, expectedChainId: 420420419,
      feeRecipientAddress: "0x01E6EEd856E989201F4fF6346E18eAb7e46C874C",
      fetchImpl: rpc("0x190f1b43", [settled(1), feeCredit(0.05)]),
    });
    expect(r.feeCount).toBe(1);
    expect(r.count).toBe(1);
  });

  // The amount is the SECOND data word. Reading the whole 64-byte `data` as one
  // integer — correct for a single-word ERC-20 Transfer — is off by ~10^48 and
  // would put an absurd USDC figure on a live money board.
  it("reads the amount from data[1], not from the whole data blob", async () => {
    const r = await readPayoutTransfers({ ...cfg, expectedChainId: 420420419, fetchImpl: rpc("0x190f1b43", [settled(0.1)]) });
    expect(r.usdc).toBeCloseTo(0.1, 6);
  });

  // Invariant 9: a settlement in another asset is NOT USDC. Folding it into the
  // USDC total is the same class of error as the DOT/USDC display math (#…).
  it("skips a settlement in a DIFFERENT asset rather than counting it as USDC", async () => {
    const other = "0x0000006400000000000000000000000001200000";
    const logs = [settled(1), settled(99, other)];
    const r = await readPayoutTransfers({ ...cfg, expectedChainId: 420420419, fetchImpl: rpc("0x190f1b43", logs) });
    expect(r.count).toBe(1);
    expect(r.usdc).toBeCloseTo(1, 6);
  });

  it("a truncated log is skipped, never counted as a zero-value payout", async () => {
    const logs = [settled(1), { topics: [], data: "0x" }];
    const r = await readPayoutTransfers({ ...cfg, expectedChainId: 420420419, fetchImpl: rpc("0x190f1b43", logs) });
    expect(r.count).toBe(1);
    expect(r.usdc).toBeCloseTo(1, 6);
  });

  it("refuses logs from the WRONG CHAIN — same guard as balances (#543)", async () => {
    const logs = [settled(1)];
    const r = await readPayoutTransfers({ ...cfg, expectedChainId: 420420419, fetchImpl: rpc("0x190f1b41", logs) });
    expect(r.count).toBeNull(); // a wrong-chain payout count would be confidently wrong
    expect(r.reason).toContain("chain 420420417");
  });

  it("a failed/rate-limited read is unverified, never zero", async () => {
    const r = await readPayoutTransfers({ ...cfg, fetchImpl: throwingFetch() });
    expect(r.count).toBeNull();
    expect(r.reason).toContain("log read failed");
  });

  it("unconfigured is unverified too", async () => {
    const r = await readPayoutTransfers({ ...cfg, usdcAddress: undefined, fetchImpl: rpc("0x190f1b43", []) });
    expect(r.count).toBeNull();
    expect(r.reason).toContain("not configured");
  });

  it("names the payout SOURCE when that's what's missing — the bug that shipped", async () => {
    const r = await readPayoutTransfers({ ...cfg, sourceAddress: undefined, fetchImpl: rpc("0x190f1b43", []) });
    expect(r.count).toBeNull();
    expect(r.reason).toContain("agentAccountCore");
  });
});

// Regression: the first live run watched the signer EOA instead of
// AgentAccountCore, found zero transfers, and put "12 unaccounted for" on a
// live money board. A total miss must accuse the INSTRUMENT, not the money.
describe("decidePayoutEvidence — a 100% miss is a broken filter, not lost money", () => {
  const base = { windowBlocks: 14400, tolerance: 1 };

  it("zero confirmed against real settled jobs is UNVERIFIED, never a shortfall", () => {
    const r = decidePayoutEvidence({ ...base, confirmedCount: 0, confirmedUsdc: 0, settledCount: 12 });
    expect(r.status).toBe("unverified"); // was "shortfall" — the false alarm
    expect(r.detail).toContain("check the contract address and event topic");
    expect(r.detail).not.toContain("unaccounted for");
  });

  it("but ONE observed transfer proves the filter works — then a shortfall is trustworthy", () => {
    const r = decidePayoutEvidence({ ...base, confirmedCount: 1, confirmedUsdc: 0.3, settledCount: 12 });
    expect(r.status).toBe("shortfall");
    expect(r.detail).toContain("11 unaccounted for");
  });

  it("zero settled AND zero confirmed is a quiet period, not an alarm", () => {
    expect(decidePayoutEvidence({ ...base, confirmedCount: 0, confirmedUsdc: 0, settledCount: 0 }).status).toBe("unverified");
  });
});

describe("decideWindowFit — measure the chain, don't assume it", () => {
  // The real 2026-07-29 defect: sized "~24h at 6s/block" on a ~2.1s chain.
  it("flags the shipped 14400/6s assumption against real ~2.1s blocks", () => {
    const fit = decideWindowFit({ blockSeconds: 2.11, lookbackBlocks: 14400, targetHours: 24 });
    expect(fit.status).toBe("suspect");
    expect(fit.spanHours).toBeCloseTo(8.4, 1);
    expect(fit.detail).toContain("too SHORT");
    expect(fit.detail).toMatch(/~40\d{3} blocks would match|~4[01]\d{3} blocks/);
  });

  it("accepts the corrected 43200 window", () => {
    const fit = decideWindowFit({ blockSeconds: 2.11, lookbackBlocks: 43200, targetHours: 24 });
    expect(fit.status).toBe("ok");
    expect(fit.spanHours).toBeCloseTo(25.3, 1);
  });

  it("an UNMEASURED chain is 'unknown', never a silent pass", () => {
    const fit = decideWindowFit({ blockSeconds: null, lookbackBlocks: 43200, targetHours: 24 });
    expect(fit.status).toBe("unknown");
    expect(fit.detail).toContain("not measured");
    expect(fit.spanHours).toBeNull();
  });

  it.each([[0], [-1], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "a nonsense block time (%s) degrades to unknown rather than dividing by it",
    (bs) => {
      expect(decideWindowFit({ blockSeconds: bs as number, lookbackBlocks: 43200, targetHours: 24 }).status).toBe("unknown");
    },
  );

  it("names the direction — long is safe, short manufactures the alarm", () => {
    const long = decideWindowFit({ blockSeconds: 2.11, lookbackBlocks: 200000, targetHours: 24 });
    expect(long.status).toBe("suspect");
    expect(long.detail).toContain("longer than the comparison period");
  });
});

describe("a suspect window SUPPRESSES a shortfall — instrument is not money", () => {
  const base = { confirmedUsdc: 0.2, windowBlocks: 14400, tolerance: 1 };

  it("the exact shipped false alarm becomes unverified, not a payout accusation", () => {
    const r = decidePayoutEvidence({
      ...base, confirmedCount: 2, settledCount: 14,
      window: decideWindowFit({ blockSeconds: 2.11, lookbackBlocks: 14400, targetHours: 24 }),
    });
    expect(r.status).toBe("unverified"); // NOT "shortfall"
    expect(r.detail).toContain("cannot compare");
    expect(r.detail).not.toMatch(/^14 jobs marked settled/);
  });

  it("a REAL shortfall still reports when the window is sound", () => {
    const r = decidePayoutEvidence({
      ...base, confirmedCount: 2, settledCount: 14, windowBlocks: 43200,
      window: decideWindowFit({ blockSeconds: 2.11, lookbackBlocks: 43200, targetHours: 24 }),
    });
    expect(r.status).toBe("shortfall");
  });

  it("an UNKNOWN window does not suppress — we only suppress on positive evidence of a bad instrument", () => {
    const r = decidePayoutEvidence({
      ...base, confirmedCount: 2, settledCount: 14,
      window: decideWindowFit({ blockSeconds: null, lookbackBlocks: 43200, targetHours: 24 }),
    });
    expect(r.status).toBe("shortfall");
  });

  it("a suspect window never turns a healthy count INTO a problem", () => {
    const r = decidePayoutEvidence({
      ...base, confirmedCount: 14, settledCount: 14,
      window: decideWindowFit({ blockSeconds: 2.11, lookbackBlocks: 14400, targetHours: 24 }),
    });
    expect(r.status).toBe("confirmed");
  });

  it("the fit rides along on the evidence for the board to render", () => {
    const window = decideWindowFit({ blockSeconds: 2.11, lookbackBlocks: 43200, targetHours: 24 });
    expect(decidePayoutEvidence({ ...base, confirmedCount: 14, settledCount: 14, window }).window).toEqual(window);
  });
});

describe("measureBlockSeconds", () => {
  function rpc(head: number, stamps: Record<number, number>): typeof fetch {
    return (async (_u: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      let result: unknown = null;
      if (body.method === "eth_blockNumber") result = `0x${head.toString(16)}`;
      if (body.method === "eth_getBlockByNumber") {
        const n = Number(BigInt(body.params[0]));
        result = stamps[n] === undefined ? null : { timestamp: `0x${stamps[n].toString(16)}` };
      }
      return { ok: true, status: 200, json: async () => ({ result }) } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("derives seconds per block from two real timestamps", async () => {
    const s = await measureBlockSeconds({
      rpcUrl: "http://rpc", sampleBlocks: 1000,
      fetchImpl: rpc(11000, { 11000: 1_000_000 + 2110, 10000: 1_000_000 }),
    });
    expect(s).toBeCloseTo(2.11, 3);
  });

  it("a missing block yields null, so the fit reads 'unchecked' not 'fine'", async () => {
    expect(await measureBlockSeconds({ rpcUrl: "http://rpc", sampleBlocks: 1000, fetchImpl: rpc(11000, { 11000: 5 }) }))
      .toBeNull();
  });

  it("non-advancing timestamps yield null rather than 0 or a negative rate", async () => {
    expect(await measureBlockSeconds({
      rpcUrl: "http://rpc", sampleBlocks: 1000,
      fetchImpl: rpc(11000, { 11000: 1_000_000, 10000: 1_000_000 }),
    })).toBeNull();
  });

  it("no rpc url, or a throwing endpoint, is null — never an invented rate", async () => {
    expect(await measureBlockSeconds({ sampleBlocks: 1000, fetchImpl: rpc(1, {}) })).toBeNull();
    expect(await measureBlockSeconds({ rpcUrl: "http://rpc", sampleBlocks: 1000, fetchImpl: throwingFetch() })).toBeNull();
  });
});

describe("a payout shortfall pages even with every probe green", () => {
  const green = evaluateProductHealth([
    { name: "product_api", status: "ok", detail: "" },
    { name: "money_path", status: "ok", detail: "" },
  ]);
  const shortfallSnap = {
    chainId: 420420419,
    flow: { payout: { status: "shortfall", detail: "14 settled, only 2 confirmed — 12 unaccounted for", settledCount: 14, confirmedCount: 2 } },
  } as never;

  it("fires — it is not a probe, so it could never reach the gate before", () => {
    const r = decideProductHealthAlert({
      evaluation: green, state: initialProductHealthAlertState(), nowMs: 1_000, cooldownMs: 60_000,
      snapshot: shortfallSnap,
    });
    expect(r.alert).toBe(true);
  });

  it("does NOT re-fire on the next cycle while the gap is unchanged", () => {
    const first = decideProductHealthAlert({
      evaluation: green, state: initialProductHealthAlertState(), nowMs: 1_000, cooldownMs: 60_000, snapshot: shortfallSnap,
    });
    const second = decideProductHealthAlert({
      evaluation: green, state: first.state, nowMs: 2_000, cooldownMs: 60_000, snapshot: shortfallSnap,
    });
    expect(second.alert).toBe(false);
  });

  it("UNVERIFIED stays silent — our blind spot is not a page", () => {
    const r = decideProductHealthAlert({
      evaluation: green, state: initialProductHealthAlertState(), nowMs: 1_000, cooldownMs: 60_000,
      snapshot: { chainId: 1, flow: { payout: { status: "unverified", detail: "cannot compare", settledCount: 14, confirmedCount: null } } } as never,
    });
    expect(r.alert).toBe(false);
  });

  it("the page leads with money and stamps the monitor version", () => {
    const mixed = evaluateProductHealth([
      { name: "api_latency", status: "red", detail: "2100ms" },
      { name: "money_path", status: "red", detail: "3 stuck" },
    ]);
    const text = buildProductHealthAlert(mixed, "http://board", {
      chainId: 420420419,
      flow: { payout: { status: "shortfall", detail: "12 unaccounted for", settledCount: 14, confirmedCount: 2 } },
      self: { status: "behind", detail: "", runningSha: "824ae4c1f2d3", behindBy: 9, oldestUnshippedAt: null },
    } as never).text;
    const lines = text.split("\n");
    expect(lines[1]).toContain("payout shortfall");        // money leads
    expect(lines[2]).toContain("money_path");              // then money probes
    expect(lines[3]).toContain("api_latency");             // latency last
    expect(text).toContain("9 commits behind main");       // provenance
    expect(text).toContain("3 money-blocking signals");
  });
});

// ── THE 2026-08-06 INCIDENT, END TO END ─────────────────────────────────────
//
// Container-local DNS failed 14:58:33–15:03:34 UTC. The product was never down;
// 200s were served from outside throughout. What shipped to a human was
// "Product API is red — https://api.averray.com/health unreachable: fetch
// failed", and on-call was paged.
//
// This drives the real collector across cycles, because the hold only works if
// the run state is actually threaded — a correct decision function wired to a
// state that resets every tick reproduces the incident exactly.
describe("a container DNS failure, cycle by cycle", () => {
  const cycle = async (transportRun: Awaited<ReturnType<typeof collectProductHealthProbes>>["transportRun"]) =>
    collectProductHealthProbes(cfg(), dnsFailingFetch(), {
      nowMs: 10_000_000,
      ...(transportRun ? { transportRun } : {}),
    });

  it("does not page on the first two cycles, and pages on the third", async () => {
    const first = await cycle(undefined);
    const api1 = first.probes.find((p) => p.name === "product_api")!;
    expect(api1.status).not.toBe("red");
    expect(api1.reading).toBe("unknown");
    expect(first.transportRun).toEqual({ code: "ENOTFOUND", consecutive: 1 });

    const second = await cycle(first.transportRun);
    expect(second.probes.find((p) => p.name === "product_api")!.status).not.toBe("red");

    const third = await cycle(second.transportRun);
    const api3 = third.probes.find((p) => p.name === "product_api")!;
    expect(api3.status).toBe("red");
    expect(api3.detail).toContain("3 consecutive checks");
  });

  it("names ENOTFOUND rather than relaying undici's 'fetch failed'", async () => {
    const { probes } = await cycle(undefined);
    const api = probes.find((p) => p.name === "product_api")!;
    expect(api.detail).toContain("ENOTFOUND");
    expect(api.detail).not.toContain("fetch failed");
  });

  it("leaves every /health-derived probe UNKNOWN, not degraded", async () => {
    const { probes } = await cycle(undefined);
    const byName = new Map(probes.map((p) => [p.name, p] as const));
    for (const name of ["chain_height", "capabilities", "api_latency", "money_path"]) {
      expect(byName.get(name)!.reading, name).toBe("unknown");
      expect(byName.get(name)!.status, name).not.toBe("red");
    }
  });

  it("clears the run the instant a read succeeds", async () => {
    const blind = await cycle(undefined);
    const recovered = await collectProductHealthProbes(
      cfg(),
      combinedFetch({ healthBody: HEALTHY_BODY, chainIdHex: CHAIN_ID_HEX, blockTimestampHex: tsHex(10_000_000, 12), gasHex: "0xDE0B6B3A7640000", usdcHex: "0x989680" }),
      { nowMs: 10_000_000, ...(blind.transportRun ? { transportRun: blind.transportRun } : {}) },
    );
    expect(recovered.transportRun).toBeUndefined();
    const api = recovered.probes.find((p) => p.name === "product_api")!;
    expect(api.status).toBe("ok");
    expect(api.reading).toBeUndefined();
  });

  it("does not count our own blindness as product downtime", async () => {
    // uptime% is over DETERMINATE product_api samples. A window in which we
    // could not reach the host contains no evidence either way, and folding it
    // in would publish our DNS outage as the product's availability figure.
    const blind = await cycle(undefined);
    const api = blind.probes.find((p) => p.name === "product_api")!;
    const history = [
      { at: 1_000, status: "healthy" as ProductHealthStatus, probes: [probe("product_api", "ok", "200")] },
      { at: 2_000, status: "degraded" as ProductHealthStatus, probes: [api] },
    ];
    const derived = deriveProductHealthHistory(history, 3_000);
    expect(derived.uptimePct24h).toBe(100);
    expect(derived.uptimeSamples).toBe(1);
  });
});
