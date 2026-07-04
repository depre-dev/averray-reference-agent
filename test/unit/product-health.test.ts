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
  collectProductHealthProbes,
  chainBlockAge,
  decideProductHealthAlert,
  runProductHealthOnce,
  initialProductHealthAlertState,
  loadProductHealthConfig,
  networkEthRpc,
  appendHistory,
  probeSparkline,
  type ProbeResult,
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
  gasHex?: string;
  usdcHex?: string;
  chainIdHex?: string;
  blockTimestampHex?: string;
}): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      const status = cfg.healthStatus ?? 200;
      return { ok: status >= 200 && status < 300, status, json: async () => cfg.healthBody ?? {} } as unknown as Response;
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
  minUsdc: 0,
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

  it("red when unreachable", () => {
    const r = deriveProductApiProbe({ configured: true, reachable: false, httpOk: false, status: 0, url: "https://api.x/health", error: "ENOTFOUND" });
    expect(r.status).toBe("red");
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
  const floors = { usdcDecimals: 6, minGasNative: 0.1, minUsdc: 5 };
  // 1 ETH = 1e18 wei = 0xDE0B6B3A7640000 ; 0.01 ETH = 1e16 = 0x2386F26FC10000
  // 10 USDC = 10_000_000 = 0x989680 ; 1 USDC = 1_000_000 = 0xF4240

  it("degraded when RPC / signer address are unconfigured", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: undefined, signerAddress: undefined, usdcAddress: undefined, ...floors, fetchImpl: balances("0x0", "0x0") });
    expect(r.status).toBe("degraded");
  });

  it("ok when gas and USDC are both above their floors", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", usdcAddress: "0xusdc", ...floors, fetchImpl: balances("0xDE0B6B3A7640000", "0x989680") });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("USDC 10.00");
  });

  it("red when native gas is below the floor", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", usdcAddress: "0xusdc", ...floors, fetchImpl: balances("0x2386F26FC10000", "0x989680") });
    expect(r.status).toBe("red");
    expect(r.detail).toContain("< 0.1");
  });

  it("red when USDC is below the floor", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", usdcAddress: "0xusdc", ...floors, fetchImpl: balances("0xDE0B6B3A7640000", "0xF4240") });
    expect(r.status).toBe("red");
    expect(r.detail).toContain("< 5");
  });

  it("degraded when the balance read fails", async () => {
    const r = await probeSignerLiquidity({ rpcUrl: "http://rpc", signerAddress: "0xabc", usdcAddress: "0xusdc", ...floors, fetchImpl: throwingFetch() });
    expect(r.status).toBe("degraded");
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

  it("degraded when a balance read fails", async () => {
    expect((await probeTreasuryLiquidity({ ...base, rewardBankLiquid: 100, fetchImpl: throwingFetch() })).status).toBe("degraded");
  });
});

describe("collectProductHealthProbes (hybrid: /health chain + RPC balances)", () => {
  it("healthy: api ok (/health), chain ok (absolute block age), signer ok (direct RPC)", async () => {
    const { probes } = await collectProductHealthProbes(
      cfg(),
      combinedFetch({ healthBody: HEALTHY_BODY, chainIdHex: CHAIN_ID_HEX, blockTimestampHex: tsHex(10_000_000, 12), gasHex: "0xDE0B6B3A7640000", usdcHex: "0x989680" }),
      { nowMs: 10_000_000 },
    );
    expect(probes.map((p) => p.name)).toEqual(["product_api", "chain_height", "signer_liquidity", "capabilities", "api_latency", "money_path", "treasury_liquidity"]);
    expect(probes.map((p) => p.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(probes[2]?.detail).toContain("USDC 10.00");
  });

  it("all degraded when nothing is configured (never fake green)", async () => {
    const { probes } = await collectProductHealthProbes(cfg({ apiBaseUrl: undefined, rpcUrl: undefined }), combinedFetch({ healthBody: HEALTHY_BODY }), { nowMs: 1000 });
    expect(probes.map((p) => p.status)).toEqual(["degraded", "degraded", "degraded", "degraded", "degraded", "degraded", "degraded"]);
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
    expect(c.minUsdc).toBe(0);
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
      PRODUCT_HEALTH_MIN_USDC: "5",
      PRODUCT_HEALTH_HALT_SEVERITY: "red",
      PRODUCT_HEALTH_CHAIN_MAX_STALE_SECONDS: "120",
    });
    expect(c.apiBaseUrl).toBe("https://api.x");
    expect(c.rpcUrl).toBe("http://rpc");
    expect(c.usdcAddress).toBe("0xusdc");
    expect(c.minUsdc).toBe(5);
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
