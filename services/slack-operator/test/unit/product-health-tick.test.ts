import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGasSpendCache } from "../../src/gas-spend-cache.js";
import { createCrossCheckCache } from "../../src/payout-crosscheck-cache.js";
import { createReceiptProbeCache } from "../../src/receipt-signature-probe.js";
import { __resetGithubAuthorsForTests, readAdminGithubAuthors } from "../../src/github-authors.js";
import { readArrivalsFeed } from "../../src/arrivals-feed.js";
import { readBankFeed } from "../../src/bank-feed-fetch.js";
import { readDepositPoolFeed } from "../../src/deposit-pool-feed.js";
import { loadProductHealthConfig, collectProductHealthProbes, __resetGasAttributionForTests } from "../../src/product-health.js";
import {
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
    expect(api).toMatchObject({ status: "degraded", detail: "timed out after 20s" });
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

describe("index tick wiring", () => {
  const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

  it("arrival delivery is after publish and is not awaited", () => {
    const publishAt = source.indexOf("productHealthSnapshotBlocks = {");
    const markAt = source.indexOf("ctx.markPublished()");
    const deliverAt = source.indexOf("deliverArrivalAlerts({");
    expect(publishAt).toBeGreaterThan(0);
    expect(markAt).toBeGreaterThan(publishAt);
    expect(deliverAt).toBeGreaterThan(markAt);
    expect(source).not.toMatch(/await deliverArrivalAlerts\(/);
  });

  it("arrivals and arrival_alerts are bounded in index", () => {
    expect(source).toMatch(/name:\s*"arrivals",/);
    expect(source).toMatch(/name:\s*"arrival_alerts",/);
    expect(source).not.toMatch(/await readArrivalsFeed\(/);
    expect(source).not.toMatch(/await readArrivalAlerts\(/);
    expect(source).toContain('ctx.post("readIncidents"');
    expect(source).toContain('ctx.post("appendIncidents"');
    expect(source).toContain('ctx.post("appendStuckIncidents"');
    expect(source).toContain('ctx.post("readSocialQueue"');
    expect(source).toContain('ctx.post("readSocialSignal"');
    expect(source).toContain('ctx.post("composeDigest"');
  });

  it("the D4 alert channel uses the arrival Slack timeout", () => {
    const assignment = source.match(/const alertChannel: AlertChannel = slackAlertChannel\([^)]*\)/);
    expect(assignment?.[0]).toContain("ARRIVAL_ALERTS_SLACK_TIMEOUT_MS");
    expect(assignment?.[0]).not.toMatch(/1e9|1_000_000_000|1000000000/);
  });

  it("the generation check is the gate, not a local always-true", () => {
    expect(source).toContain("runGuardedProductHealthTick");
    expect(source).not.toMatch(/const live = \(\) => true/);
    expect(source).toContain("ctx.live()");
    expect(source).toContain("productHealthRefreshSuppressed(");
    expect(source).toContain("closeOpenStuckTickIncidents(");
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
