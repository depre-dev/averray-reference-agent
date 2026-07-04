import { describe, expect, it } from "vitest";

import {
  evaluateProductHealth,
  redProbeKey,
  probeProductApi,
  probeChainHeight,
  probeSignerLiquidity,
  decideProductHealthAlert,
  runProductHealthOnce,
  initialProductHealthAlertState,
  loadProductHealthConfig,
  networkEthRpc,
  appendHistory,
  probeSparkline,
  type ProbeResult,
  type ProductHealthAlertState,
  type ProductHealthDeps,
  type ProductHealthSnapshot,
  type ProductHealthStatus,
} from "../../services/slack-operator/src/product-health.js";
import type { AlertPayload } from "../../services/slack-operator/src/alert-bridge.js";

// ── mock fetch (typed so the "Typecheck and test" job stays green) ──

interface MockResponse {
  ok?: boolean;
  status?: number;
  result?: string;
  error?: string;
}
type FetchHandler = (url: string, init: RequestInit) => MockResponse;

function mockFetch(handler: FetchHandler): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const r = handler(String(url), init ?? {});
    const status = r.status ?? 200;
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => (r.error ? { error: { message: r.error } } : { result: r.result }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

function rpcMethod(init: RequestInit): string {
  try {
    return (JSON.parse(String(init.body)) as { method?: string }).method ?? "";
  } catch {
    return "";
  }
}

const probe = (name: string, status: ProbeResult["status"], detail = ""): ProbeResult => ({ name, status, detail });

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

describe("probeProductApi", () => {
  it("degraded (never fake green) when the base url is unconfigured", async () => {
    const r = await probeProductApi({ baseUrl: undefined, healthPath: "/health", fetchImpl: mockFetch(() => ({ status: 200 })) });
    expect(r.status).toBe("degraded");
  });

  it("ok on a 2xx", async () => {
    const r = await probeProductApi({ baseUrl: "https://api.x", healthPath: "/health", fetchImpl: mockFetch(() => ({ status: 200 })) });
    expect(r.status).toBe("ok");
  });

  it("red on a non-2xx", async () => {
    const r = await probeProductApi({ baseUrl: "https://api.x", healthPath: "/health", fetchImpl: mockFetch(() => ({ status: 503 })) });
    expect(r.status).toBe("red");
  });

  it("red when the endpoint is unreachable", async () => {
    const r = await probeProductApi({ baseUrl: "https://api.x", healthPath: "/health", fetchImpl: throwingFetch() });
    expect(r.status).toBe("red");
  });
});

describe("probeChainHeight", () => {
  it("degraded when the RPC url is unconfigured", async () => {
    const r = await probeChainHeight({ rpcUrl: undefined, fetchImpl: mockFetch(() => ({ result: "0x1" })) });
    expect(r.status).toBe("degraded");
  });

  it("ok when the chain reports a positive height (height-only, no freshness threshold)", async () => {
    const r = await probeChainHeight({ rpcUrl: "http://rpc", fetchImpl: mockFetch(() => ({ result: { number: "0x2a" } })) });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("42");
  });

  it("red when the chain reports block 0", async () => {
    const r = await probeChainHeight({ rpcUrl: "http://rpc", fetchImpl: mockFetch(() => ({ result: { number: "0x0" } })) });
    expect(r.status).toBe("red");
  });

  it("degraded (not a page) on an RPC hiccup — our dependency, not a product outage", async () => {
    const r = await probeChainHeight({ rpcUrl: "http://rpc", fetchImpl: mockFetch(() => ({ error: "upstream busy" })) });
    expect(r.status).toBe("degraded");
  });

  // Halt detection — the whole point: a frozen chain still answers RPC.
  const NOW_MS = 1_783_000_000_000; // fixed clock; NOW_MS/1000 = 1_783_000_000 s
  const at = (secAgo: number) => "0x" + BigInt(Math.floor(NOW_MS / 1000) - secAgo).toString(16);

  it("red when the latest block is stale beyond the freshness threshold (chain halted)", async () => {
    const r = await probeChainHeight({
      rpcUrl: "http://rpc",
      maxStaleSeconds: 600,
      now: () => NOW_MS,
      fetchImpl: mockFetch(() => ({ result: { number: "0x2a", timestamp: at(3600) } })), // 60m old
    });
    expect(r.status).toBe("red");
    expect(r.detail).toContain("stalled");
    expect(r.detail).toContain("42");
  });

  it("ok when the latest block is fresh (advancing) under the threshold", async () => {
    const r = await probeChainHeight({
      rpcUrl: "http://rpc",
      maxStaleSeconds: 600,
      now: () => NOW_MS,
      fetchImpl: mockFetch(() => ({ result: { number: "0x2a", timestamp: at(12) } })), // 12s old
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("42");
  });

  it("degraded when the chain returns a block with no number", async () => {
    const r = await probeChainHeight({ rpcUrl: "http://rpc", fetchImpl: mockFetch(() => ({ result: { hash: "0xabc" } })) });
    expect(r.status).toBe("degraded");
    expect(r.detail).toContain("no latest block");
  });
});

describe("probeSignerLiquidity", () => {
  const floors = { usdcDecimals: 6, minGasNative: 0.1, minUsdc: 5 };
  // 1 ETH = 1e18 wei = 0xDE0B6B3A7640000 ; 0.01 ETH = 1e16 = 0x2386F26FC10000
  // 10 USDC = 10_000_000 = 0x989680 ; 1 USDC = 1_000_000 = 0xF4240
  const balances = (gasHex: string, usdcHex: string): typeof fetch =>
    mockFetch((_url, init) => ({ result: rpcMethod(init) === "eth_getBalance" ? gasHex : usdcHex }));

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
    const red2 = evaluateProductHealth([probe("signer_liquidity", "red", "low")]);
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
    expect(h.alerts).toHaveLength(0);
  });

  it("does not alert when only degraded (unconfigured probes)", async () => {
    const h = harness([probe("chain_height", "degraded", "not configured")]);
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

const TESTNET_RPC = "https://eth-rpc-testnet.polkadot.io/";

describe("loadProductHealthConfig", () => {
  it("defaults the RPC to the network endpoint (Option B); signer/USDC resolve elsewhere", () => {
    const c = loadProductHealthConfig({});
    expect(c.apiBaseUrl).toBeUndefined();
    expect(c.rpcUrl).toBe(TESTNET_RPC); // WALLET_NETWORK absent → testnet
    expect(c.signerAddress).toBeUndefined(); // derived in the wiring from AGENT_WALLET_PRIVATE_KEY, not here
    expect(c.usdcAddress).toBeUndefined();
    expect(c.apiHealthPath).toBe("/health");
    expect(c.usdcDecimals).toBe(6);
    expect(c.minGasNative).toBe(0);
    expect(c.minUsdc).toBe(0);
  });

  it("selects the RPC by WALLET_NETWORK, leaving mainnet unset until confirmed", () => {
    expect(loadProductHealthConfig({ WALLET_NETWORK: "testnet" }).rpcUrl).toBe(TESTNET_RPC);
    expect(loadProductHealthConfig({ WALLET_NETWORK: "mainnet" }).rpcUrl).toBeUndefined();
  });

  it("reads env overrides; an explicit RPC wins over the network map", () => {
    const c = loadProductHealthConfig({
      AVERRAY_API_BASE_URL: "https://api.x/",
      PRODUCT_HEALTH_RPC_URL: "http://rpc",
      PRODUCT_HEALTH_MIN_USDC: "5",
      PRODUCT_HEALTH_MIN_GAS_NATIVE: "0.1",
    });
    expect(c.apiBaseUrl).toBe("https://api.x");
    expect(c.rpcUrl).toBe("http://rpc");
    expect(c.minUsdc).toBe(5);
    expect(c.minGasNative).toBe(0.1);
  });
});

describe("networkEthRpc", () => {
  it("resolves testnet (default + case-insensitive), leaves mainnet/unknown unset", () => {
    expect(networkEthRpc(undefined)).toBe(TESTNET_RPC);
    expect(networkEthRpc("testnet")).toBe(TESTNET_RPC);
    expect(networkEthRpc("TestNet")).toBe(TESTNET_RPC);
    expect(networkEthRpc("mainnet")).toBeUndefined();
    expect(networkEthRpc("weird")).toBeUndefined();
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
