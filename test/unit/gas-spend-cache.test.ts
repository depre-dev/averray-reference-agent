import { describe, expect, it, vi } from "vitest";

import { createGasSpendCache } from "../../services/slack-operator/src/gas-spend-cache.js";
import type { GasReadResult } from "../../services/slack-operator/src/gas-spend-read.js";
import type { GasTx } from "../../services/slack-operator/src/gas-spend.js";

const SIGNER = "0x5a6836c6d4d293f6e5377e6c28054f4171915813";
const dot = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const tx = (sel: string, d: number): GasTx =>
  ({ from: SIGNER, to: "0xesc", selector: sel, gasWei: dot(d), success: true });

const ok = (txs: GasTx[], over: Partial<GasReadResult> = {}): GasReadResult =>
  ({ txs, otherSenders: [], truncated: false, blocksScanned: 40000, ...over });

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); };

describe("the heartbeat never waits", () => {
  it("returns null before the first successful read, not an empty breakdown", async () => {
    // An empty breakdown summarises to "0 DOT spent" and reads as FREE. Null
    // reads as not-yet-known, which is what it is.
    const cache = createGasSpendCache({ read: async () => ok([tx("0xa", 1)]), settledCount: () => 1 });
    expect(cache.read(1000)).toBeNull();
    cache.maybeRefresh(1000);
    await settle();
    expect(cache.read(1000)).not.toBeNull();
  });

  it("maybeRefresh returns immediately rather than blocking on the read", () => {
    let resolved = false;
    const cache = createGasSpendCache({
      read: () => new Promise((r) => setTimeout(() => { resolved = true; r(ok([])); }, 50)),
      settledCount: () => 1,
    });
    cache.maybeRefresh(0);
    // The point: control is back here with the read still in flight.
    expect(resolved).toBe(false);
  });

  it("does not stack passes while one is running", async () => {
    // Each pass is ~174 RPC calls against an endpoint that rate-limits by
    // answering 404. A slow read plus a fast heartbeat must not pile up.
    let calls = 0;
    const cache = createGasSpendCache({
      read: async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return ok([]); },
      settledCount: () => 1,
    });
    for (let i = 0; i < 5; i += 1) cache.maybeRefresh(i);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1);
  });
});

describe("staleness is labelled, not laundered", () => {
  it("ages the snapshot at read time", async () => {
    const cache = createGasSpendCache({ read: async () => ok([tx("0xa", 1)]), settledCount: () => 1 });
    cache.maybeRefresh(0);
    await settle();
    expect(cache.read(0)!.ageMs).toBe(0);
    expect(cache.read(600_000)!.ageMs).toBe(600_000);
  });

  it("refreshes only once the interval has passed", async () => {
    let calls = 0;
    const cache = createGasSpendCache({
      read: async () => { calls += 1; return ok([]); },
      settledCount: () => 1,
      refreshMs: 1000,
    });
    cache.maybeRefresh(0); await settle();
    cache.maybeRefresh(500); await settle();
    expect(calls).toBe(1);
    cache.maybeRefresh(1500); await settle();
    expect(calls).toBe(2);
  });
});

describe("a failed refresh degrades to visibly-old, never to zero", () => {
  it("keeps the previous figures and says why they stopped moving", async () => {
    let fail = false;
    const cache = createGasSpendCache({
      read: async () => (fail ? { txs: [], otherSenders: [], truncated: false, blocksScanned: 0, reason: "rpc 404" } : ok([tx("0xa", 2)])),
      settledCount: () => 1,
      refreshMs: 100,
    });
    cache.maybeRefresh(0); await settle();
    expect(cache.read(0)!.totalDot).toBeCloseTo(2, 6);

    fail = true;
    cache.maybeRefresh(1000); await settle();
    const s = cache.read(1000)!;
    // The figures are the PREVIOUS ones, and the age keeps climbing.
    expect(s.totalDot).toBeCloseTo(2, 6);
    expect(s.staleReason).toContain("rpc 404");
    expect(s.ageMs).toBe(1000);
  });

  it("reports the error without throwing into the heartbeat", async () => {
    const onError = vi.fn();
    const cache = createGasSpendCache({
      read: async () => { throw new Error("boom"); },
      settledCount: () => 1,
      onError,
    });
    expect(() => cache.maybeRefresh(0)).not.toThrow();
    await settle();
    expect(onError).toHaveBeenCalledWith("boom");
  });
});

describe("what it carries through", () => {
  it("passes labels and the settlement count into the summary", async () => {
    const cache = createGasSpendCache({
      read: async () => ok([tx("0xb08c763e", 0.04), tx("0xzz", 0.06)]),
      settledCount: () => 2,
      labels: { "0xb08c763e": "resolveSinglePayout" },
    });
    cache.maybeRefresh(0); await settle();
    const s = cache.read(0)!;
    expect(s.buckets.find((b) => b.selector === "0xb08c763e")!.label).toBe("resolveSinglePayout");
    expect(s.perSettlement).toBeCloseTo(0.05, 6);
  });

  it("carries truncation and other senders onto the snapshot", async () => {
    const cache = createGasSpendCache({
      read: async () => ok([tx("0xa", 1)], { truncated: true, otherSenders: [{ address: "0xother", count: 4 }] }),
      settledCount: () => 1,
    });
    cache.maybeRefresh(0); await settle();
    const s = cache.read(0)!;
    expect(s.truncated).toBe(true);
    expect(s.otherSenders).toEqual([{ address: "0xother", count: 4 }]);
  });
});
