import { describe, expect, it } from "vitest";

import { phoneArrivals, phonePool } from "./phone-spec.js";
import type { ProductHealth } from "./product-health.js";

describe("phonePool — the deposit pool in one line", () => {
  const snap = (over: Record<string, unknown> = {}) =>
    ({ snapshot: { schemaVersion: 1, available: true, ...over } }) as unknown as ProductHealth["depositPool"];

  it("an EMPTY readable pool is ok, not an alarm — it was born empty", () => {
    // The desktop says this with a `BORN EMPTY · ZEROES ARE MEASURED` kicker.
    // The phone has no room for the kicker, so the tone must carry it.
    const lane = phonePool(snap({
      totalAssets: { raw: "0", decimals: 6 },
      flows: { status: "ok", depositorCount: 0 },
      yieldStatus: "not_yet_earning",
    }));
    expect(lane?.tone).toBe("ok");
    expect(lane?.line).toBe("POOL 0 USDC in · 0 depositors · not yet earning");
  });

  it("renders the live shape", () => {
    const lane = phonePool(snap({
      totalAssets: { raw: "10000000", decimals: 6 },
      flows: { status: "ok", depositorCount: 1 },
      yieldStatus: "earning",
    }));
    expect(lane?.line).toBe("POOL 10 USDC in · 1 depositor · earning");
  });

  it("an absent amount says so rather than rendering a measured-looking zero", () => {
    const lane = phonePool(snap({ flows: { status: "ok", depositorCount: 0 } }));
    expect(lane?.line).toContain("amount not reported");
    expect(lane?.line).not.toContain("0 USDC");
  });

  it("keeps 'cannot see it' and 'it reported nonsense' distinct", () => {
    const gone = phonePool({ unavailable: "no producer" } as ProductHealth["depositPool"]);
    expect(gone).toMatchObject({ tone: "awaiting", unreadable: true });
    const bad = phonePool({ fault: "shares without assets" } as ProductHealth["depositPool"]);
    expect(bad).toMatchObject({ tone: "red", unreadable: true });
  });

  it("no producer at all ⇒ no lane, never a placeholder", () => {
    expect(phonePool(undefined)).toBeNull();
  });
});

describe("phoneArrivals — did anyone come, what did they do, how far", () => {
  const arrivals = (over: Record<string, unknown> = {}) =>
    ({ schemaVersion: "averray.arrivals.v1", ...over }) as unknown as ProductHealth["arrivals"];
  const stages = (over: Partial<Record<string, number>> = {}) => ({
    reached: 0, browsed: 0, evaluated: 0, identified: 0,
    authenticated: 0, claimed: 0, submitted: 0, ...over,
  });

  it("answers in plain words — no transport names", () => {
    // Operator, 2026-08-06: "whats MCP and HTTP… I only need to know if
    // someone came, what they did and how far."
    const lane = phoneArrivals(arrivals({
      funnelExternal: stages({ reached: 9, browsed: 2 }),
      funnelHttpExternal: stages({ reached: 40, browsed: 20, claimed: 1 }),
    }));
    expect(lane?.line).toBe("OUTSIDERS — someone claimed a job");
    expect(lane?.line).not.toMatch(/MCP|HTTP/);
  });

  it("prefers the registry-backed settled history over shallower legacy call counters", () => {
    const lane = phoneArrivals(arrivals({
      funnelExternal: stages({ reached: 9 }),
      funnelHttpExternal: stages({ reached: 40 }),
      operatorView: {
        version: "averray.arrivals.operator.v1",
        generatedAtMs: Date.parse("2026-08-16T12:00:00.000Z"),
        outsiders: {
          furthestEver: {
            window: "all-time", stage: "settled", atMs: Date.parse("2026-08-11T08:00:00.000Z"),
            door: "http", agents: 1, payouts: 42, payoutWindow: "12h",
          },
          lastActivity: {
            window: "all-time", atMs: Date.parse("2026-08-11T08:00:00.000Z"), stage: "settled", door: "http",
          },
          week: { window: "7d", identified: 0, worked: 0 },
          postedWork: { window: "all-time", status: "never", count: 0, firstAtMs: null },
        },
        ours: {
          day: {
            window: "24h", agents: 0, canaryRuns: 0, acceptanceRuns: 0,
            adminConsoleAgents: 0, operatorAgents: 0,
          },
        },
        unknown: { window: "all-time", sharedClientNames: 0, preSplitCalls: 0 },
        doors: {
          mcp: { window: "all-time", sinceMs: null, rows: [] },
          http: { window: "all-time", sinceMs: null, rows: [] },
        },
      },
    }));

    expect(lane?.line).toBe("OUTSIDERS — someone settled work · last activity 5d ago");
    expect(lane?.line).not.toMatch(/MCP|HTTP/);
  });

  it("takes the FURTHEST across doors, never the sum", () => {
    // The doors cover different spans — HTTP is counted only from a cutover —
    // so adding them would be arithmetic across unlike windows. Furthest-stage
    // is well-defined however long each door has been watched.
    const lane = phoneArrivals(arrivals({
      funnelExternal: stages({ reached: 1, submitted: 1 }),
      funnelHttpExternal: stages({ reached: 5000, browsed: 4000 }),
    }));
    expect(lane?.line).toBe("OUTSIDERS — someone submitted work");
  });

  it("says nobody ONLY about doors it actually watched", () => {
    const lane = phoneArrivals(arrivals({ funnelExternal: stages() }));
    expect(lane?.line).toBe("OUTSIDERS — nobody yet on the doors we measure");
  });

  it("both doors watched and empty is a real, plainly stated observation", () => {
    const lane = phoneArrivals(arrivals({
      funnelExternal: stages(),
      funnelHttpExternal: stages(),
    }));
    expect(lane?.line).toBe("OUTSIDERS — nobody from outside yet");
  });

  it("flags an unwatched door even when somebody did arrive", () => {
    const lane = phoneArrivals(arrivals({ funnelExternal: stages({ reached: 3, browsed: 1 }) }));
    expect(lane?.line).toBe("OUTSIDERS — someone browsed jobs · one door not measured");
  });

  it("no external series at all ⇒ not measured, never 'nobody'", () => {
    const lane = phoneArrivals(arrivals({}));
    expect(lane).toMatchObject({ tone: "awaiting", unreadable: true });
    expect(lane?.line).toBe("OUTSIDERS — not measured");
  });

  it("NEVER counts the ambiguous bucket as outside demand", () => {
    const lane = phoneArrivals(arrivals({
      funnelExternal: stages(),
      funnelHttpExternal: stages(),
      funnelAmbiguous: stages({ reached: 99, submitted: 99 }),
    }));
    expect(lane?.line).toBe("OUTSIDERS — nobody from outside yet");
  });

  it("nobody arriving is never coloured as a fault", () => {
    const lane = phoneArrivals(arrivals({ funnelExternal: stages(), funnelHttpExternal: stages() }));
    expect(lane?.tone).toBe("ok");
  });

  it("an unreadable feed is fenced, not zeroed", () => {
    const lane = phoneArrivals({ unavailable: "arrivals feed unreachable" } as ProductHealth["arrivals"]);
    expect(lane).toMatchObject({ tone: "awaiting", unreadable: true });
    expect(lane?.line).toContain("unreachable");
  });
});
