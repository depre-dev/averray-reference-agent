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

describe("phoneArrivals — how far strangers got", () => {
  const arrivals = (over: Record<string, unknown> = {}) =>
    ({ schemaVersion: "averray.arrivals.v1", ...over }) as unknown as ProductHealth["arrivals"];

  it("keeps the two front doors APART — a merge would hide one door doing nothing", () => {
    const lane = phoneArrivals(arrivals({
      funnelExternal: { reached: 12, browsed: 3, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0 },
      funnelHttpExternal: { reached: 90, browsed: 40, evaluated: 20, identified: 5, authenticated: 5, claimed: 2, submitted: 1 },
    }));
    expect(lane?.line).toBe("OUTSIDERS MCP → browsed · HTTP → submitted");
  });

  it("an unmeasured door is NOT MEASURED, never zero", () => {
    // funnelHttpExternal is absent on producers that predate the HTTP split.
    const lane = phoneArrivals(arrivals({
      funnelExternal: { reached: 5, browsed: 0, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0 },
    }));
    expect(lane?.line).toContain("HTTP not measured");
  });

  it("a measured door nobody came through says 'none yet' — a real observation", () => {
    const lane = phoneArrivals(arrivals({
      funnelExternal: { reached: 0, browsed: 0, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0 },
      funnelHttpExternal: { reached: 0, browsed: 0, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0 },
    }));
    expect(lane?.line).toBe("OUTSIDERS MCP none yet · HTTP none yet");
  });

  it("NEVER counts the ambiguous bucket as outside demand", () => {
    // Traffic under a client name we also use: claiming it as demand
    // manufactures it, claiming it as ours erases a possible stranger.
    const lane = phoneArrivals(arrivals({
      funnelExternal: { reached: 0, browsed: 0, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0 },
      funnelAmbiguous: { reached: 99, browsed: 99, evaluated: 99, identified: 99, authenticated: 99, claimed: 99, submitted: 99 },
      funnelHttpExternal: { reached: 0, browsed: 0, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0 },
    }));
    expect(lane?.line).toBe("OUTSIDERS MCP none yet · HTTP none yet");
  });

  it("nobody arriving is never coloured as a fault", () => {
    // Demand is a business outcome; painting it red would put it in the same
    // visual language as a broken money path.
    const lane = phoneArrivals(arrivals({
      funnelExternal: { reached: 0, browsed: 0, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0 },
    }));
    expect(lane?.tone).toBe("ok");
  });

  it("an unreadable feed is fenced, not zeroed", () => {
    const lane = phoneArrivals({ unavailable: "arrivals feed unreachable" } as ProductHealth["arrivals"]);
    expect(lane).toMatchObject({ tone: "awaiting", unreadable: true });
    expect(lane?.line).toContain("unreachable");
  });
});
