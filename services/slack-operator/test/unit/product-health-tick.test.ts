import { afterEach, describe, expect, it, vi } from "vitest";

import { clearServerAlertMute, setServerAlertMute, type AlertChannel } from "../../src/alert-bridge.js";
import { __resetArrivalAlertsForTests } from "../../src/arrival-alerts.js";
import {
  DIGEST_COMPLETION_TIMEOUT_MS,
  createProductHealthCheckState,
  createProductHealthSlackChannels,
  runProductHealthCheck,
  type ProductHealthCheckState,
} from "../../src/product-health-check.js";

import { createGasSpendCache } from "../../src/gas-spend-cache.js";
import { createCrossCheckCache } from "../../src/payout-crosscheck-cache.js";
import { createReceiptProbeCache } from "../../src/receipt-signature-probe.js";
import { __resetGithubAuthorsForTests, readAdminGithubAuthors } from "../../src/github-authors.js";
import { readArrivalsFeed } from "../../src/arrivals-feed.js";
import { readBankFeed } from "../../src/bank-feed-fetch.js";
import { readDepositPoolFeed } from "../../src/deposit-pool-feed.js";
import { loadProductHealthConfig, collectProductHealthProbes, __resetGasAttributionForTests } from "../../src/product-health.js";
import {
  POST_PUBLISH_BUDGET_MS,
  PROBE_DEADLINE_MS,
  ProductHealthTickGate,
  closeOpenStuckTickIncidents,
  decideMonitorRefreshAlert,
  productHealthRefreshSuppressed,
  probeTimeoutDetail,
  runGuardedProductHealthTick,
  runWithDeadline,
  type ProbeLog,
} from "../../src/product-health-tick.js";

const logsOf = (): { entries: Array<{ level: string; probe?: string; msg?: string; durationMs?: number }>; log: ProbeLog } => {
  const entries: Array<{ level: string; probe?: string; msg?: string; durationMs?: number }> = [];
  const push = (level: string) => (obj: Record<string, unknown>, msg?: string) => {
    entries.push({
      level,
      ...(typeof obj.probe === "string" ? { probe: obj.probe } : {}),
      ...(typeof obj.durationMs === "number" ? { durationMs: obj.durationMs } : {}),
      ...(msg ? { msg } : {}),
    });
  };
  return { entries, log: { debug: push("debug"), warn: push("warn") } };
};

describe("per-probe deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a probe whose promise never settles degrades and the caller continues", async () => {
    vi.useFakeTimers();
    const { entries, log } = logsOf();
    let settled = false;
    const pending = runWithDeadline({
      name: "product_api",
      log,
      run: () => new Promise(() => {}),
      onTimeout: (detail) => ({ name: "product_api", status: "degraded" as const, detail }),
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    expect(settled).toBe(true);
    await expect(pending).resolves.toEqual({
      name: "product_api",
      status: "degraded",
      detail: probeTimeoutDetail(PROBE_DEADLINE_MS),
    });
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "debug", probe: "product_api", msg: "product_health_probe_start" }),
      expect.objectContaining({ level: "warn", probe: "product_api", msg: "product_health_probe_deadline" }),
    ]));
  });

  it("logs a probe that runs longer than 10s", async () => {
    vi.useFakeTimers();
    const { entries, log } = logsOf();
    let resolve: (value: string) => void = () => {};
    const pending = runWithDeadline({
      name: "bank_feed",
      log,
      run: () => new Promise<string>((r) => { resolve = r; }),
      onTimeout: () => "timed out",
    });
    await vi.advanceTimersByTimeAsync(11_000);
    resolve("ok");
    await expect(pending).resolves.toBe("ok");
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: "debug", probe: "bank_feed", msg: "product_health_probe_done" }),
      expect.objectContaining({ level: "warn", probe: "bank_feed", msg: "product_health_probe_slow" }),
    ]));
  });

  it("collectProductHealthProbes finishes when fetch never settles, with product_api degraded", async () => {
    vi.useFakeTimers();
    __resetGasAttributionForTests();
    const config = loadProductHealthConfig({
      AVERRAY_API_BASE_URL: "https://api.example",
      PRODUCT_HEALTH_RPC_URL: "",
      WALLET_NETWORK: "none",
      PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED: "false",
      PRODUCT_HEALTH_GAS_ATTRIBUTION_ENABLED: "false",
    });
    const hung = (() => new Promise<Response>(() => {})) as typeof fetch;
    let settled = false;
    const pending = collectProductHealthProbes(config, hung, { nowMs: 1_700_000_000_000 }).then((result) => {
      settled = true;
      return result;
    });
    for (let i = 0; i < 20 && !settled; i += 1) {
      await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    }
    expect(settled).toBe(true);
    const result = await pending;
    const api = result.probes.find((probe) => probe.name === "product_api");
    expect(api?.status).toBe("degraded");
    expect(api?.detail).toContain("check 1 of 3");
    expect(api?.detail).toContain("no response before the timeout");
    expect(api?.detail).not.toBe("timed out after 20s");
    expect(result.transportRun?.consecutive).toBe(1);
  });

  it("three consecutive /health timeouts go red as unreachable from the monitor", async () => {
    vi.useFakeTimers();
    __resetGasAttributionForTests();
    const config = loadProductHealthConfig({
      AVERRAY_API_BASE_URL: "https://api.example",
      PRODUCT_HEALTH_RPC_URL: "",
      WALLET_NETWORK: "none",
      PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED: "false",
      PRODUCT_HEALTH_GAS_ATTRIBUTION_ENABLED: "false",
    });
    const hung = (() => new Promise<Response>(() => {})) as typeof fetch;
    let transportRun: Awaited<ReturnType<typeof collectProductHealthProbes>>["transportRun"];
    const statuses: string[] = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      let settled = false;
      const pending = collectProductHealthProbes(config, hung, {
        nowMs: 1_700_000_000_000,
        deadlineMs: 1_000,
        ...(transportRun ? { transportRun } : {}),
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(settled).toBe(true);
      const result = await pending;
      transportRun = result.transportRun;
      const api = result.probes.find((probe) => probe.name === "product_api");
      statuses.push(`${api?.status}:${api?.detail ?? ""}`);
    }
    expect(transportRun?.consecutive).toBe(3);
    expect(statuses[0]).toContain("degraded");
    expect(statuses[0]).toContain("check 1 of 3");
    expect(statuses[2]).toContain("red");
    expect(statuses[2]).toContain("unreachable from the monitor");
  });

  it("configured treasury, signer, payout, lifecycle, and bank probes degrade on a hung fetch", async () => {
    vi.useFakeTimers();
    __resetGasAttributionForTests();
    const { entries, log } = logsOf();
    const deadlineMs = 500;
    const detail = probeTimeoutDetail(deadlineMs);
    const config = loadProductHealthConfig({
      AVERRAY_API_BASE_URL: "https://api.example",
      PRODUCT_HEALTH_RPC_URL: "https://rpc.example",
      PRODUCT_HEALTH_SIGNER_ADDRESS: "0xabc",
      PRODUCT_HEALTH_USDC_ADDRESS: "0x0000000000000000000000000000000000000001",
      PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED: "true",
      PRODUCT_HEALTH_BANK_FEED_URL: "http://bank.internal/feed",
      PRODUCT_HEALTH_GAS_ATTRIBUTION_ENABLED: "false",
      WALLET_NETWORK: "none",
    });
    const treasuryAccount = `0x${"ab".repeat(20)}`;
    const feeWord = `0x${treasuryAccount.slice(2).padStart(64, "0")}`;
    const health = {
      status: "ok",
      auth: { chainId: 420420417 },
      addresses: {
        token: "0x0000000000000000000000000000000000000001",
        agentAccountCore: "0x0000000000000000000000000000000000000002",
        escrowCore: "0x0000000000000000000000000000000000000003",
        treasuryReserve: "0x0000000000000000000000000000000000000004",
      },
      rewardBank: { liquid: 10 },
      components: { blockchain: { ok: true, blockNumber: 100 } },
      settlement: { settled24h: 1, paidSettled24h: 1, stuck: 0, failed24h: 0, asOf: "2026-10-10T00:00:00Z" },
    };
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const href = String(url);
      if ((init?.method ?? "GET") === "GET" && href.includes("/health")) {
        return { ok: true, status: 200, json: async () => health } as unknown as Response;
      }
      if ((init?.method ?? "GET") === "POST") {
        let data = "";
        let method = "";
        try {
          const body = JSON.parse(String(init?.body)) as { method?: string; params?: unknown[] };
          method = body.method ?? "";
          const call = body.params?.[0];
          if (call && typeof call === "object" && "data" in call && typeof call.data === "string") data = call.data;
        } catch { /* a non-rpc body hangs with everything else */ }
        // fee_recipient must answer so payout and job_lifecycle actually await their reads.
        if (method === "eth_call" && data.startsWith("0x339b2cff")) {
          return { ok: true, status: 200, json: async () => ({ result: feeWord }) } as unknown as Response;
        }
      }
      return await new Promise<Response>(() => {});
    }) as typeof fetch;
    let settled = false;
    const pending = collectProductHealthProbes(config, fetchImpl, {
      nowMs: 1_700_000_000_000,
      deadlineMs,
      log,
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(deadlineMs * 4);
    expect(settled).toBe(true);
    const result = await pending;
    expect(result.probes.find((probe) => probe.name === "signer_liquidity")).toMatchObject({
      status: "degraded",
      detail,
    });
    expect(result.probes.find((probe) => probe.name === "treasury_liquidity")).toMatchObject({
      status: "degraded",
      detail,
    });
    expect(result.snapshot.bank?.unavailable).toBe(detail);
    expect(result.snapshot.flow?.payout?.detail).toBe(detail);
    expect(result.snapshot.lifecycle).toBeUndefined();
    for (const probe of ["treasury_liquidity", "job_lifecycle", "payout_transfers", "signer_liquidity", "bank_feed"]) {
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ probe, msg: "product_health_probe_deadline" }),
      ]));
    }
  });

  it("fee_recipient, self_freshness, and credential_expiry each degrade when their read hangs", async () => {
    vi.useFakeTimers();
    __resetGasAttributionForTests();
    const deadlineMs = 500;
    const hang = new Promise<Response>(() => {});
    const health = {
      status: "ok",
      auth: { chainId: 420420417 },
      addresses: { escrowCore: "0x0000000000000000000000000000000000000003" },
      serviceHealth: { ok: true },
    };
    const cases: Array<{ env: Record<string, string>; probe: string; readCert?: () => Promise<{ validToMs: number | null }> }> = [
      {
        probe: "fee_recipient",
        env: {
          AVERRAY_API_BASE_URL: "https://api.example",
          PRODUCT_HEALTH_RPC_URL: "https://rpc.example",
          PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED: "true",
          PRODUCT_HEALTH_GAS_ATTRIBUTION_ENABLED: "false",
          WALLET_NETWORK: "none",
        },
      },
      {
        probe: "self_freshness",
        env: {
          AVERRAY_API_BASE_URL: "https://api.example",
          PRODUCT_HEALTH_RPC_URL: "",
          PRODUCT_HEALTH_SELF_REPO: "acme/monitor",
          AVERRAY_GIT_SHA: "abc123",
          PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED: "false",
          PRODUCT_HEALTH_GAS_ATTRIBUTION_ENABLED: "false",
          WALLET_NETWORK: "none",
        },
      },
      {
        probe: "credential_expiry",
        env: {
          AVERRAY_API_BASE_URL: "https://api.example",
          PRODUCT_HEALTH_RPC_URL: "",
          PRODUCT_HEALTH_CERT_HOSTS: "certs.example",
          PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED: "false",
          PRODUCT_HEALTH_GAS_ATTRIBUTION_ENABLED: "false",
          WALLET_NETWORK: "none",
        },
        readCert: () => new Promise(() => {}),
      },
    ];
    for (const item of cases) {
      const { entries, log } = logsOf();
      const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET" && String(url).includes("/health")) {
          return { ok: true, status: 200, json: async () => health } as unknown as Response;
        }
        return await hang;
      }) as typeof fetch;
      let settled = false;
      const pending = collectProductHealthProbes(loadProductHealthConfig(item.env), fetchImpl, {
        nowMs: 1_700_000_000_000,
        deadlineMs,
        log,
        ...(item.readCert ? { readCert: item.readCert } : {}),
      }).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(deadlineMs * 4);
      expect(settled, item.probe).toBe(true);
      await pending;
      expect(entries, item.probe).toEqual(expect.arrayContaining([
        expect.objectContaining({ probe: item.probe, msg: "product_health_probe_deadline" }),
      ]));
    }
  });
});

describe("tick watchdog and generation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a tick that never completes is abandoned, the next tick runs, and the late result is discarded", async () => {
    vi.useFakeTimers();
    const notes: string[] = [];
    const gate = new ProductHealthTickGate({
      intervalMs: () => 60_000,
      now: () => Date.now(),
      onStuck: (event) => notes.push(event.note),
    });
    const written: string[] = [];
    const first = gate.tryBegin();
    expect(first).not.toBeNull();
    gate.enter("product_api");
    let releaseFirst: (value: string) => void = () => {};
    const firstWork = new Promise<string>((resolve) => { releaseFirst = resolve; });
    const firstDone = (async () => {
      const value = await firstWork;
      return gate.finish(first!.generation, () => { written.push(value); });
    })();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^product-health tick stuck since .+ in product_api$/);
    const second = gate.tryBegin();
    expect(second?.generation).toBe(2);
    expect(gate.finish(second!.generation, () => { written.push("new"); })).toBe(true);

    releaseFirst("old");
    await expect(firstDone).resolves.toBe(false);
    expect(written).toEqual(["new"]);
  });
});

describe("production tick guard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("live() drops a late publish after a newer tick", async () => {
    vi.useFakeTimers();
    const gate = new ProductHealthTickGate({
      intervalMs: () => 60_000,
      now: () => Date.now(),
      onStuck: () => {},
    });
    const published: string[] = [];
    let releaseFirst: (value: string) => void = () => {};
    const first = runGuardedProductHealthTick(gate, async (ctx) => {
      const value = await new Promise<string>((resolve) => { releaseFirst = resolve; });
      if (!ctx.live()) return;
      published.push(value);
    });
    await vi.advanceTimersByTimeAsync(120_000);
    const second = runGuardedProductHealthTick(gate, async (ctx) => {
      if (!ctx.live()) return;
      published.push("new");
    });
    await second;
    releaseFirst("timed out");
    await first;
    expect(published).toEqual(["new"]);
  });

  it("a post-publish hang is named, and an empty pending set says after publish", async () => {
    vi.useFakeTimers();
    const notes: string[] = [];
    const gate = new ProductHealthTickGate({
      intervalMs: () => 5_000,
      now: () => Date.now(),
      onStuck: (event) => notes.push(event.note),
    });
    void runGuardedProductHealthTick(gate, async (ctx) => {
      ctx.markPublished();
      await ctx.post("readIncidents", () => new Promise(() => {}), null);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.pendingNames()).toContain("post_publish:readIncidents");
    // Watchdog is 2 × 5s, inside the 20s post deadline, so the note names the await.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notes[0]).toContain("post_publish:readIncidents");

    notes.length = 0;
    const gate2 = new ProductHealthTickGate({
      intervalMs: () => 5_000,
      now: () => Date.now(),
      onStuck: (event) => notes.push(event.note),
    });
    void runGuardedProductHealthTick(gate2, async (ctx) => {
      ctx.markPublished();
      await new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(notes[0]).toContain("after publish");
    expect(notes[0]).not.toContain("unknown");
  });

  it("mute suppresses the refresh page", () => {
    const suppressed = productHealthRefreshSuppressed({ muteUntilMs: 5_000, nowMs: 1_000, quiet: false });
    expect(suppressed.muted).toBe(true);
    const decision = decideMonitorRefreshAlert({
      enabled: true,
      lastCompletedAtMs: 0,
      heartbeatStartedAtMs: 0,
      nowMs: 10 * 60_000,
      checkIntervalMs: 5 * 60_000,
      paged: false,
      muted: suppressed.muted,
      quiet: suppressed.quiet,
    });
    expect(decision.page).toBe(false);
  });

  it("closes an open stuck-tick incident", () => {
    const closed = closeOpenStuckTickIncidents([
      { probe: "product_health_tick", endedAt: null, id: "product_health_tick-1" },
      { probe: "money_path", endedAt: null, id: "money-1" },
    ], 50);
    expect(closed.writes).toEqual([
      { probe: "product_health_tick", endedAt: 50, id: "product_health_tick-1" },
    ]);
    expect(closed.incidents[1]?.endedAt).toBeNull();
  });
});

describe("product health tick behaviour", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearServerAlertMute();
    __resetArrivalAlertsForTests();
    __resetGithubAuthorsForTests();
  });

  const baseEnv = {
    AVERRAY_API_BASE_URL: "https://api.example",
    PRODUCT_HEALTH_RPC_URL: "",
    PRODUCT_HEALTH_BANK_FEED_URL: "http://bank.internal/feed",
    PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED: "false",
    PRODUCT_HEALTH_GAS_ATTRIBUTION_ENABLED: "false",
    WALLET_NETWORK: "none",
    ARRIVAL_ALERTS_SLACK_ENABLED: "0",
  };

  function okFetch(body: unknown = { status: "ok", serviceHealth: { ok: true } }): typeof fetch {
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET" && String(url).includes("/health")) {
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
  }

  function harness(over: {
    env?: Record<string, string>;
    fetchImpl?: typeof fetch;
    intervalMs?: number;
    alertChannel?: AlertChannel;
    readIncidents?: () => Promise<Array<{ id: string; probe: string; severity: "red"; startedAt: number; endedAt: number | null; note?: string }> | null>;
    appendIncidents?: () => Promise<void>;
    readSocialQueue?: () => Promise<{ state: "unreadable"; drafts: []; problem: string }>;
    readSocialSignal?: () => Promise<{ text: string; tone: "degraded" }>;
    requestCompletion?: (req: unknown, options: { timeoutMs?: number }) => Promise<string>;
    publishNarration?: () => Promise<{ ok: boolean; reason: string; detail: string }>;
    readBuzzConfig?: () => { config: { relayUrl: string; agentSecretKeyHex: string; authTag: string[]; channelId: string } | null };
    decideProbeTransitions?: () => {
      alerts: Array<{ probe: string; kind: string; text: string; key: string }>;
      keys: Set<string>;
      next: Map<string, { name: string; status: "ok"; detail: string }>;
      streaks: Map<string, number>;
    };
    recordCollaboration?: () => void;
    state?: ProductHealthCheckState;
  } = {}) {
    vi.useFakeTimers();
    __resetGasAttributionForTests();
    const state = over.state ?? createProductHealthCheckState();
    const intervalMs = over.intervalMs ?? 120_000;
    const gate = new ProductHealthTickGate({
      intervalMs: () => intervalMs,
      now: () => Date.now(),
      onStuck: () => {},
    });
    const channels = createProductHealthSlackChannels({
      webhookUrl: "https://hooks.example/slack",
      onRefreshDelivered: () => { state.refreshPaged = true; },
      onArrivalDelivered: () => {},
    });
    const env = { ...baseEnv, ...over.env };
    let settled = false;
    const run = () => runProductHealthCheck({
      state,
      gate,
      env,
      fetchImpl: over.fetchImpl ?? okFetch(),
      enabled: true,
      intervalMs,
      cooldownMs: 60_000,
      alertChannel: over.alertChannel ?? channels.alertChannel,
      arrivalAlertChannel: channels.arrivalAlertChannel,
      getAdminReadSession: async () => ({ token: "t" }),
      deriveSigner: () => undefined,
      ...(over.readIncidents ? { readIncidents: over.readIncidents as never } : {}),
      ...(over.appendIncidents ? { appendIncidents: over.appendIncidents } : {}),
      ...(over.readSocialQueue ? { readSocialQueue: over.readSocialQueue as never } : {}),
      ...(over.readSocialSignal ? { readSocialSignal: over.readSocialSignal as never } : {}),
      ...(over.requestCompletion ? { requestCompletion: over.requestCompletion as never } : {}),
      ...(over.publishNarration ? { publishNarration: over.publishNarration as never } : {}),
      ...(over.readBuzzConfig ? { readBuzzConfig: over.readBuzzConfig as never } : {}),
      ...(over.decideProbeTransitions ? { decideProbeTransitions: over.decideProbeTransitions as never } : {}),
      ...(over.recordCollaboration ? { recordCollaboration: over.recordCollaboration as never } : {}),
    }).then(() => { settled = true; });
    return { state, gate, run, settled: () => settled, channels };
  }

  it("hung arrivals and arrival-alert fetches still publish the tick", async () => {
    const fetched = harness({
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        const href = String(url);
        if ((init?.method ?? "GET") === "GET" && href.includes("/health")) {
          return { ok: true, status: 200, json: async () => ({ status: "ok", serviceHealth: { ok: true } }) } as unknown as Response;
        }
        if (
          href.includes("/monitor/arrivals")
          || href.includes("/admin/arrivals/alerts")
          || href.includes("/monitor/deposit-pool")
          || href.includes("/admin/status")
          || href.includes("/admin/ops/bank-moves")
        ) {
          return await new Promise<Response>(() => {});
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch,
      appendIncidents: async () => {},
      readIncidents: async () => [],
    });
    const pending = fetched.run();
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(fetched.settled(), fetched.gate.pendingNames().join(",") || "none pending").toBe(true);
    await pending;
    expect(fetched.state.snapshot?.arrivals).toMatchObject({ unavailable: "arrivals feed timed out after 20s" });
    expect(fetched.state.snapshot?.arrivalAlerts?.unavailable).toBe("timeout");
    expect(fetched.state.snapshot?.bankMoves).toEqual({ state: "unavailable", text: "not reported" });
    expect(fetched.state.history.length).toBeGreaterThan(0);
    expect(fetched.gate.pendingNames()).toEqual([]);
  });

  it("a hung readIncidents finishes the tick, closes stuck incidents, and does not mark hydration", async () => {
    const { state, run, settled } = harness({
      readIncidents: () => new Promise(() => {}),
      appendIncidents: async () => {},
    });
    state.incidents = [{
      id: "product_health_tick-1",
      probe: "product_health_tick",
      severity: "red",
      startedAt: 1,
      endedAt: null,
      note: "stuck",
    }];
    const pending = run();
    await vi.advanceTimersByTimeAsync(PROBE_DEADLINE_MS);
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(settled()).toBe(true);
    await pending;
    expect(state.incidentsHydrated).toBe(false);
    expect(state.incidents.find((incident) => incident.id === "product_health_tick-1")?.endedAt).toEqual(expect.any(Number));
  });

  it("mute suppresses the refresh page from the tick", async () => {
    const pages: string[] = [];
    const alertChannel: AlertChannel = {
      name: "slack",
      dispatch: async (payload) => {
        pages.push(payload.text);
        return true;
      },
    };
    const { state, run } = harness({ alertChannel, intervalMs: 60_000 });
    const anchor = Date.now() - 180_000;
    state.history = [{ at: anchor, status: "degraded", probes: [] }];
    state.heartbeatStartedAt = anchor;
    setServerAlertMute(Date.now() + 60_000);
    await run();
    expect(pages.filter((text) => text.includes("monitor not refreshing"))).toEqual([]);
  });

  it("pages once per episode, only after Slack accepts, and a late completion does not re-arm", async () => {
    const pages: string[] = [];
    const alertChannel: AlertChannel = {
      name: "slack",
      dispatch: async (payload) => {
        pages.push(payload.text);
        return true;
      },
    };
    const intervalMs = 60_000;
    const { state, run } = harness({ alertChannel, intervalMs });
    const anchor = Date.now() - intervalMs * 3;
    state.history = [{ at: anchor, status: "degraded", probes: [] }];
    state.heartbeatStartedAt = anchor;
    await run();
    expect(state.refreshPaged).toBe(true);
    expect(pages.filter((text) => text.includes("monitor not refreshing"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await run();
    await vi.advanceTimersByTimeAsync(intervalMs * 2);
    await run();
    expect(pages.filter((text) => text.includes("monitor not refreshing"))).toHaveLength(1);
  });

  it("a Slack POST that succeeds after the timeout still consumes the refresh episode", async () => {
    const original = globalThis.fetch;
    let finish: (value: Response) => void = () => {};
    let slackCalls = 0;
    globalThis.fetch = (() => {
      slackCalls += 1;
      return new Promise<Response>((resolve) => { finish = resolve; });
    }) as typeof fetch;
    try {
      const intervalMs = 60_000;
      const { state, run } = harness({ intervalMs });
      const anchor = Date.now() - intervalMs * 3;
      state.history = [{ at: anchor, status: "degraded", probes: [] }];
      state.heartbeatStartedAt = anchor;
      const pending = run();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(state.refreshPaged).toBe(false);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(state.refreshPaged).toBe(false);
      finish(new Response("ok", { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(state.refreshPaged).toBe(true);
      await vi.advanceTimersByTimeAsync(intervalMs * 2);
      await run();
      expect(slackCalls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not wait for arrival delivery after the snapshot is published", async () => {
    let generation = 0;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.includes("/health")) {
        return { ok: true, status: 200, json: async () => ({ status: "ok", serviceHealth: { ok: true } }) } as unknown as Response;
      }
      if (href.includes("/admin/arrivals/alerts")) {
        generation += 1;
        const id = generation === 1 ? "external_wallet_first:0x1" : "external_wallet_first:0x2";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            schemaVersion: "averray.arrival-alerts.v1",
            ready: [{ id, kind: "external_wallet_first", subject: "wallet", status: "ready" }],
            pending: [],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
    const original = globalThis.fetch;
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    try {
      const { run } = harness({
        fetchImpl,
        env: { ARRIVAL_ALERTS_SLACK_ENABLED: "1" },
      });
      await run();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      let settled = false;
      const second = run().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(true);
      await second;
    } finally {
      globalThis.fetch = original;
    }
  });

  it("an abandoned tick does not publish over the newer snapshot", async () => {
    let releaseHealth = false;
    const fetchImpl = (async (url: RequestInfo | URL) => {
      if (String(url).includes("/health")) {
        if (!releaseHealth) return await new Promise<Response>(() => {});
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", serviceHealth: { ok: true }, auth: { chainId: 111 } }),
        } as unknown as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    }) as typeof fetch;
    const { state, run } = harness({ fetchImpl, intervalMs: 5_000 });
    const first = run();
    await vi.advanceTimersByTimeAsync(10_000);
    releaseHealth = true;
    await run();
    expect(state.snapshot?.chainId).toBe(111);
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
    expect(state.snapshot?.chainId).toBe(111);
  });

  it("settle lets the next tick start without waiting for the watchdog", async () => {
    const { state, run } = harness();
    await run();
    await run();
    expect(state.history).toHaveLength(2);
  });

  it("post() does not run after the tick is abandoned", async () => {
    let calls = 0;
    let first = true;
    const { run } = harness({
      intervalMs: 5_000,
      readIncidents: () => {
        if (first) {
          first = false;
          return new Promise(() => {});
        }
        return Promise.resolve([]);
      },
      appendIncidents: async () => { calls += 1; },
    });
    const abandoned = run();
    await vi.advanceTimersByTimeAsync(10_000);
    await run();
    const afterSecond = calls;
    await vi.advanceTimersByTimeAsync(10_000);
    await abandoned;
    expect(calls).toBe(afterSecond);
  });

  it("a late readIncidents result does not hydrate over the newer tick", async () => {
    let release: (value: Array<{ id: string; probe: string; severity: "red"; startedAt: number; endedAt: null }>) => void = () => {};
    let first = true;
    const { state, run } = harness({
      intervalMs: 5_000,
      readIncidents: () => {
        if (first) {
          first = false;
          return new Promise((resolve) => { release = resolve; });
        }
        return Promise.resolve([]);
      },
    });
    const abandoned = run();
    await vi.advanceTimersByTimeAsync(10_000);
    await run();
    expect(state.incidentsHydrated).toBe(true);
    release([{ id: "from-abandoned", probe: "money_path", severity: "red", startedAt: 1, endedAt: null }]);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(state.incidents.some((incident) => incident.id === "from-abandoned")).toBe(false);
    await vi.advanceTimersByTimeAsync(20_000);
    await abandoned;
    expect(state.incidents.some((incident) => incident.id === "from-abandoned")).toBe(false);
  });

  it("asks Hermes for the digest inside the post deadline", async () => {
    const timeouts: number[] = [];
    const { run } = harness({
      env: {
        BUZZ_MORNING_DIGEST: "1",
        BUZZ_DIGEST_TIME: "00:00",
        BUZZ_DIGEST_TZ: "UTC",
        OLLAMA_API_KEY: "test-key",
      },
      requestCompletion: async (_req, options) => {
        timeouts.push(options.timeoutMs ?? 0);
        return "plain";
      },
    });
    await run();
    expect(timeouts).toEqual([DIGEST_COMPLETION_TIMEOUT_MS]);
    expect(DIGEST_COMPLETION_TIMEOUT_MS).toBeLessThan(PROBE_DEADLINE_MS);
  });

  it("a digest whose post steps hang finishes inside the post-publish budget", async () => {
    let signalCalls = 0;
    const { run, settled } = harness({
      env: {
        BUZZ_MORNING_DIGEST: "1",
        BUZZ_DIGEST_TIME: "00:00",
        BUZZ_DIGEST_TZ: "UTC",
        OLLAMA_API_KEY: "test-key",
      },
      readIncidents: async () => [],
      appendIncidents: async () => {},
      readSocialQueue: () => new Promise(() => {}),
      readSocialSignal: () => {
        signalCalls += 1;
        return new Promise(() => {});
      },
      requestCompletion: () => new Promise(() => {}),
    });
    const pending = run();
    await vi.advanceTimersByTimeAsync(POST_PUBLISH_BUDGET_MS + 5_000);
    expect(settled()).toBe(true);
    await pending;
    expect(signalCalls).toBe(1);
  });

  it("stops calling Buzz after the first probe-transition timeout", async () => {
    let publishes = 0;
    const { run } = harness({
      readIncidents: async () => [],
      appendIncidents: async () => {},
      readBuzzConfig: () => ({
        config: { relayUrl: "https://buzz.example", agentSecretKeyHex: "aa", authTag: ["ops"], channelId: "c" },
      }),
      decideProbeTransitions: () => ({
        alerts: [
          { probe: "money_path", kind: "entered", text: "one", key: "a" },
          { probe: "treasury_liquidity", kind: "entered", text: "two", key: "b" },
        ],
        keys: new Set(["a", "b"]),
        next: new Map(),
        streaks: new Map(),
      }),
      publishNarration: () => {
        publishes += 1;
        return new Promise(() => {});
      },
    });
    const pending = run();
    for (let step = 0; step < 40; step += 1) {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      vi.advanceTimersByTime(1_000);
    }
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    await pending;
    expect(publishes).toBe(1);
  });

  it("an abandoned tick that resumes after the next tick does not rewrite shared state", async () => {
    const messages: string[] = [];
    let healthCalls = 0;
    let appends = 0;
    let releaseStuck: () => void = () => {};
    const { state, run } = harness({
      intervalMs: 5_000,
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET" && String(url).includes("/health")) {
          healthCalls += 1;
          const first = healthCalls === 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              status: "ok",
              serviceHealth: { ok: !first },
              rewardBank: { liquid: first ? 1 : 100 },
            }),
          } as unknown as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }) as typeof fetch,
      readIncidents: async () => [],
      appendIncidents: () => {
        appends += 1;
        if (appends === 2) return new Promise<void>((resolve) => { releaseStuck = resolve; });
        return Promise.resolve();
      },
      recordCollaboration: ((input: { text?: string }) => {
        messages.push(input.text ?? "");
        return { id: String(messages.length) };
      }) as never,
    });
    state.prevProductHealthStatus = "healthy";
    const abandoned = run();
    for (let step = 0; step < 10; step += 1) {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      vi.advanceTimersByTime(1_000);
    }
    await run();
    const snap = () => ({
      runway: JSON.stringify(state.runwayAlertState),
      status: state.prevProductHealthStatus,
      redAnnounced: state.opsNarrationRedAnnounced ?? null,
      probes: [...state.prevProbes.entries()].map(([name, probe]) => `${name}:${probe.status}:${probe.detail}`).sort(),
      keys: [...state.postedProbeKeys].sort(),
      streaks: [...state.probeStreaks.entries()].sort(),
      messages: [...messages],
      history: state.history.map((row) => row.at),
      incidents: state.incidents.map((row) => ({ id: row.id, endedAt: row.endedAt ?? null })),
    });
    const afterNext = snap();
    releaseStuck();
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    await abandoned;
    expect(snap()).toEqual(afterNext);
  });

  it("a fully hung digest tick finishes inside the post-publish budget without calling Hermes", async () => {
    let composeCalls = 0;
    const { run, settled } = harness({
      env: {
        PRODUCT_HEALTH_RPC_URL: "https://rpc.example",
        PRODUCT_HEALTH_PAYOUT_EVIDENCE_ENABLED: "true",
        PRODUCT_HEALTH_PAYOUT_SOURCE_ADDRESS: "0x0000000000000000000000000000000000000002",
        PRODUCT_HEALTH_USDC_ADDRESS: "0x0000000000000000000000000000000000000001",
        PRODUCT_HEALTH_SIGNER_ADDRESS: "0xabc",
        BUZZ_MORNING_DIGEST: "1",
        BUZZ_DIGEST_TIME: "00:00",
        BUZZ_DIGEST_TZ: "UTC",
        OLLAMA_API_KEY: "test-key",
      },
      fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
      alertChannel: {
        name: "slack",
        dispatch: () => new Promise(() => {}),
      },
      readIncidents: () => new Promise(() => {}),
      appendIncidents: () => new Promise(() => {}),
      readSocialQueue: () => new Promise(() => {}),
      readSocialSignal: () => new Promise(() => {}),
      requestCompletion: () => {
        composeCalls += 1;
        return new Promise(() => {});
      },
      readBuzzConfig: () => ({
        config: { relayUrl: "https://buzz.example", agentSecretKeyHex: "aa", authTag: ["ops"], channelId: "c" },
      }),
      publishNarration: () => new Promise(() => {}),
    });
    const pending = run();
    await vi.advanceTimersByTimeAsync(140_000);
    expect(settled()).toBe(true);
    await pending;
    expect(composeCalls).toBe(0);
  });

  it("records an arrival Slack POST that succeeds after the channel timeout", async () => {
    vi.useFakeTimers();
    const delivered: string[] = [];
    const { arrivalAlertChannel } = createProductHealthSlackChannels({
      webhookUrl: "https://hooks.example/slack",
      onRefreshDelivered: () => {},
      onArrivalDelivered: (id) => delivered.push(id),
    });
    const original = globalThis.fetch;
    let finish: (value: Response) => void = () => {};
    globalThis.fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch;
    try {
      const pending = arrivalAlertChannel.dispatch({
        count: 1,
        items: [{ id: "external_wallet_first:0xlate", title: "late" }],
        boardUrl: "https://monitor.example/monitor",
        text: "opened",
      });
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(pending).resolves.toBe(false);
      expect(delivered).toEqual([]);
      finish(new Response("ok", { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(delivered).toEqual(["external_wallet_first:0xlate"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("pages again after an on-time recovery releases the latch", async () => {
    const pages: string[] = [];
    const alertChannel: AlertChannel = {
      name: "slack",
      dispatch: async (payload) => {
        pages.push(payload.text);
        return true;
      },
    };
    const intervalMs = 60_000;
    const { state, run } = harness({ alertChannel, intervalMs });
    const anchor = Date.now() - intervalMs * 3;
    state.history = [{ at: anchor, status: "degraded", probes: [] }];
    state.heartbeatStartedAt = anchor;
    await run();
    expect(pages.filter((text) => text.includes("monitor not refreshing"))).toHaveLength(1);
    const recoveredAt = Date.now();
    state.previousCompletedAt = recoveredAt - intervalMs;
    state.history = [{ at: recoveredAt, status: "degraded", probes: [] }];
    state.refreshPaged = true;
    await vi.advanceTimersByTimeAsync(1_000);
    await run();
    expect(state.refreshPaged).toBe(false);
    await vi.advanceTimersByTimeAsync(intervalMs * 2);
    await run();
    expect(pages.filter((text) => text.includes("monitor not refreshing"))).toHaveLength(2);
  });

  it("does not send a second refresh page while the first POST is in flight", async () => {
    let calls = 0;
    const alertChannel: AlertChannel = {
      name: "slack",
      dispatch: () => {
        calls += 1;
        return new Promise(() => {});
      },
    };
    const intervalMs = 60_000;
    const { state, run } = harness({
      alertChannel,
      intervalMs,
      fetchImpl: (() => new Promise<Response>(() => {})) as typeof fetch,
    });
    const anchor = Date.now() - intervalMs * 3;
    state.history = [{ at: anchor, status: "degraded", probes: [] }];
    state.heartbeatStartedAt = anchor;
    const first = run();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(state.refreshPageInFlight).toBe(true);
    const second = run();
    await Promise.resolve();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.allSettled([first, second]);
  });
});

describe("monitor refresh alert", () => {
  const since = Date.parse("2026-10-10T16:55:50.000Z");
  const intervalMs = 5 * 60_000;
  const base = {
    enabled: true,
    lastCompletedAtMs: since,
    heartbeatStartedAtMs: since,
    nowMs: since + intervalMs * 2,
    checkIntervalMs: intervalMs,
    paged: false,
    previousCompletedAtMs: null as number | null,
    muted: false,
    quiet: false,
  };

  it("pages once, and not while muted or in quiet hours", () => {
    expect(decideMonitorRefreshAlert({ ...base, muted: true }).page).toBe(false);
    expect(decideMonitorRefreshAlert({ ...base, quiet: true }).page).toBe(false);
    expect(decideMonitorRefreshAlert({ ...base, muted: true }).paged).toBe(false);
    const first = decideMonitorRefreshAlert(base);
    expect(first.page).toBe(true);
    expect(first.sinceMs).toBe(since);
    const second = decideMonitorRefreshAlert({ ...base, paged: first.paged });
    expect(second.page).toBe(false);
    const afterUnmute = decideMonitorRefreshAlert({ ...base, muted: false, paged: false });
    expect(afterUnmute.page).toBe(true);
  });

  it("re-arms after an on-time completion", () => {
    const paged = decideMonitorRefreshAlert(base);
    const recovered = decideMonitorRefreshAlert({
      ...base,
      nowMs: since + intervalMs,
      previousCompletedAtMs: since - intervalMs,
      paged: paged.paged,
    });
    expect(recovered.page).toBe(false);
    expect(recovered.paged).toBe(false);
  });

  it("a late completion does not page the same freeze again", () => {
    const first = decideMonitorRefreshAlert(base);
    expect(first.page).toBe(true);
    const lateAt = since + intervalMs * 3;
    const slipped = decideMonitorRefreshAlert({
      ...base,
      lastCompletedAtMs: lateAt,
      previousCompletedAtMs: since,
      nowMs: lateAt + 60_000,
      paged: first.paged,
    });
    expect(slipped.page).toBe(false);
    expect(slipped.paged).toBe(true);
    const still = decideMonitorRefreshAlert({
      ...base,
      lastCompletedAtMs: lateAt,
      previousCompletedAtMs: since,
      nowMs: lateAt + intervalMs * 2,
      paged: slipped.paged,
    });
    expect(still.page).toBe(false);
  });
});

describe("shared in-flight slots clear on timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    __resetGithubAuthorsForTests();
  });

  it("gas, cross-check, and receipt caches drop a read that never settles", async () => {
    vi.useFakeTimers();
    let gasCalls = 0;
    const gas = createGasSpendCache({
      attemptTimeoutMs: 1_000,
      read: () => { gasCalls += 1; return new Promise(() => {}); },
      settledCount: () => 1,
    });
    gas.maybeRefresh(0);
    await vi.advanceTimersByTimeAsync(1_000);
    gas.maybeRefresh(2_000);
    expect(gasCalls).toBe(2);
    expect(gas.read(2_000)).toMatchObject({ unreadable: true, reason: "timed out after 1s" });

    let crossCalls = 0;
    const cross = createCrossCheckCache({
      configured: true,
      attemptTimeoutMs: 1_000,
      intervalMs: 0,
      retryIntervalMs: 0,
      run: () => { crossCalls += 1; return new Promise(() => {}); },
    });
    cross.maybeRefresh(0);
    await vi.advanceTimersByTimeAsync(1_000);
    cross.maybeRefresh(2_000);
    expect(crossCalls).toBe(2);

    let receiptCalls = 0;
    const receipt = createReceiptProbeCache({
      attemptTimeoutMs: 1_000,
      intervalMs: 0,
      run: () => { receiptCalls += 1; return new Promise(() => {}); },
    });
    receipt.maybeRefresh(0);
    await vi.advanceTimersByTimeAsync(1_000);
    receipt.maybeRefresh(2_000);
    expect(receiptCalls).toBe(2);
    expect(receipt.read().detail).toContain("timed out after 1s");

    let stamped = 0;
    const held = createReceiptProbeCache({
      attemptTimeoutMs: 1_000,
      intervalMs: 60_000,
      run: () => { stamped += 1; return new Promise(() => {}); },
    });
    held.maybeRefresh(0);
    await vi.advanceTimersByTimeAsync(1_000);
    held.maybeRefresh(2_000);
    expect(stamped).toBe(1);
    held.maybeRefresh(61_000);
    expect(stamped).toBe(2);
  });

  it("github authors, bank, deposit, and arrivals settle when fetch ignores abort", async () => {
    vi.useFakeTimers();
    const hung = (() => new Promise<Response>(() => {})) as typeof fetch;
    const authors = readAdminGithubAuthors({
      baseUrl: "https://api.example",
      getSession: async () => ({ token: "t" }),
      fetchImpl: hung,
      nowMs: 0,
      timeoutMs: 40,
      minIntervalMs: 0,
    });
    const bank = readBankFeed({ url: "http://bank.internal/feed", fetchImpl: hung, timeoutMs: 40 });
    const deposit = readDepositPoolFeed({ url: "http://bank.internal/pool", fetchImpl: hung, timeoutMs: 40 });
    const arrivals = readArrivalsFeed({ baseUrl: "https://api.example", fetchImpl: hung, timeoutMs: 40 });
    await vi.advanceTimersByTimeAsync(40);
    await expect(authors).resolves.toMatchObject({ unavailable: "timeout" });
    await expect(bank).resolves.toMatchObject({ reason: expect.stringMatching(/ETIMEDOUT|timed out/i) });
    await expect(deposit).resolves.toMatchObject({ unavailable: expect.stringMatching(/ETIMEDOUT|timed out/i) });
    await expect(arrivals).resolves.toMatchObject({ unavailable: expect.stringMatching(/ETIMEDOUT|timed out/i) });
  });
});
