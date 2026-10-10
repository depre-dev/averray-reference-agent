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
  decideMonitorRefreshAlert,
  probeTimeoutDetail,
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

describe("monitor refresh alert", () => {
  const since = Date.parse("2026-10-10T16:55:50.000Z");
  const intervalMs = 5 * 60_000;
  const base = {
    enabled: true,
    lastCompletedAtMs: since,
    heartbeatStartedAtMs: since,
    nowMs: since + intervalMs * 2,
    checkIntervalMs: intervalMs,
    pagedForMs: null as number | null,
    muted: false,
    quiet: false,
  };

  it("pages once, and not while muted or in quiet hours", () => {
    expect(decideMonitorRefreshAlert({ ...base, muted: true }).page).toBe(false);
    expect(decideMonitorRefreshAlert({ ...base, quiet: true }).page).toBe(false);
    expect(decideMonitorRefreshAlert({ ...base, muted: true }).pagedForMs).toBeNull();
    const first = decideMonitorRefreshAlert(base);
    expect(first.page).toBe(true);
    expect(first.sinceMs).toBe(since);
    const second = decideMonitorRefreshAlert({ ...base, pagedForMs: first.pagedForMs });
    expect(second.page).toBe(false);
    const afterUnmute = decideMonitorRefreshAlert({ ...base, muted: false, pagedForMs: null });
    expect(afterUnmute.page).toBe(true);
  });

  it("re-arms after a tick completes", () => {
    const paged = decideMonitorRefreshAlert(base);
    const recovered = decideMonitorRefreshAlert({
      ...base,
      nowMs: since + intervalMs,
      pagedForMs: paged.pagedForMs,
    });
    expect(recovered.page).toBe(false);
    expect(recovered.pagedForMs).toBeNull();
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
