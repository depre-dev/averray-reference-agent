import { describe, expect, it } from "vitest";

import { getBoardHealth } from "../../packages/averray-mcp/src/board-health.js";

const env = { AVERRAY_MONITOR_BASE_URL: "http://monitor:8790" } as NodeJS.ProcessEnv;

const payload = {
  enabled: true,
  at: 1_700_000_000_000,
  checkIntervalMs: 300_000,
  checks: 42,
  verdict: { headline: "NOMINAL", tone: "ok", sub: "money is moving", reason: "nominal" },
  probes: [{ name: "money_path", status: "ok", detail: "settled24h 15" }],
  buzz: { status: "ok", detail: "delivered 4m ago" },
};

const ok = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as never;

describe("getBoardHealth", () => {
  it("hands back the board's verdict, not a summary of it", () => {
    // The whole point: the agent reads a CONCLUSION produced by the same tested
    // deriveOpsVerdict the operator's screen renders. Anything reduced or
    // re-ranked here would be a third opinion.
    return getBoardHealth({ env, fetchImpl: ok(payload) }).then((r) => {
      expect(r.reachable).toBe(true);
      expect(r.verdict).toEqual(payload.verdict);
      expect(r.verdictReason).toBe("nominal");
    });
  });

  it("points the agent at reason and away from the prose", async () => {
    const r = await getBoardHealth({ env, fetchImpl: ok(payload) });
    const g = r.guidance as Record<string, unknown>;
    expect(g.readFirst).toBe("verdict.reason");
    expect(g.neverMatchOn).toEqual(["verdict.headline", "verdict.sub"]);
  });

  it("names the OTHER health tool so the two are not confused", async () => {
    // averray_ops_health reads Postgres and answers a different question. The
    // two can legitimately disagree, and an agent quoting one as the other is
    // the exact failure this tool exists to prevent.
    const r = await getBoardHealth({ env, fetchImpl: ok(payload) });
    expect(String((r.guidance as Record<string, unknown>).notThisTool)).toContain("averray_ops_health");
  });

  it("an unreachable board is UNKNOWN, never healthy", async () => {
    const r = await getBoardHealth({
      env,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
    });
    expect(r.reachable).toBe(false);
    expect(r.verdict).toBeNull();
    expect(r.error).toContain("ECONNREFUSED");
    expect(String((r.guidance as Record<string, unknown>).say)).toContain("UNKNOWN");
  });

  it("an HTTP error is also unknown, with the status", async () => {
    const r = await getBoardHealth({
      env,
      fetchImpl: (async () => ({ ok: false, status: 503 }) as unknown as Response) as never,
    });
    expect(r.reachable).toBe(false);
    expect(r.error).toBe("HTTP 503");
  });

  it("monitoring switched OFF is not health — it is the absence of it", async () => {
    // enabled:false passed through as a reading is how a switched-off monitor
    // gets reported as a quiet one.
    const r = await getBoardHealth({ env, fetchImpl: ok({ ...payload, enabled: false }) });
    expect(r.monitoringEnabled).toBe(false);
    expect(String(r.note)).toContain("unknown, not healthy");
  });

  it("does not judge staleness — it hands over the clock and says so", async () => {
    // How old a snapshot is is a property of the READER. The board layers its
    // own staleness on top of the shared verdict rather than baking it in.
    const r = await getBoardHealth({ env, fetchImpl: ok(payload) });
    expect(r.at).toBe(payload.at);
    expect(r.checkIntervalMs).toBe(payload.checkIntervalMs);
    expect(String(r.staleness)).toContain("Judge it yourself");
  });

  it("carries the supporting blocks an explanation needs", async () => {
    const r = await getBoardHealth({ env, fetchImpl: ok(payload) });
    expect(r.probes).toEqual(payload.probes);
    expect(r.buzz).toEqual(payload.buzz);
  });

  it("declares itself read-only", async () => {
    const r = await getBoardHealth({ env, fetchImpl: ok(payload) });
    expect(r.mutates).toBe(false);
  });
});
