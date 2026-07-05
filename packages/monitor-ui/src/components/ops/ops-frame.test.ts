import { describe, expect, test } from "vitest";
import type { ProductHealth } from "../../lib/monitor/product-health.js";
import { opsBannerData, pillarStatuses } from "./ops-frame.js";
import {
  OPS_FIXTURE_LIVE,
  OPS_FIXTURE_POPULATED,
  OPS_FIXTURE_RED,
  FIXTURE_NOW,
} from "../../lib/monitor/ops-fixtures.js";

describe("opsBannerData", () => {
  test("a real degradation (testnet chain) → amber action tone, not-paging sub", () => {
    const b = opsBannerData(OPS_FIXTURE_LIVE, FIXTURE_NOW);
    expect(b.tone).toBe("action");
    expect(b.headline).toContain("Chain height");
    expect(b.headline).toContain("degraded");
    expect(b.sub).toContain("not paging");
    expect(b.eyebrow).toContain("testnet");
    expect((b.mostUrgentReasons ?? []).map((r) => r.label)).toEqual(["degraded", "testnet"]);
  });

  test("a page-worthy red (mainnet money path) → rose degraded tone, paged sub", () => {
    const b = opsBannerData(OPS_FIXTURE_RED, FIXTURE_NOW);
    expect(b.tone).toBe("degraded");
    expect(b.headline).toContain("Money path");
    expect(b.headline).toContain("red");
    expect(b.sub).toContain("paged");
    expect((b.mostUrgentReasons ?? []).map((r) => r.label)).toEqual(["page-worthy", "mainnet"]);
  });

  test("multiple real degradations get a +N suffix on the lead probe", () => {
    // populated: chain_height AND money_path are degraded (both real, not awaiting)
    const b = opsBannerData(OPS_FIXTURE_POPULATED, FIXTURE_NOW);
    expect(b.tone).toBe("action");
    expect(b.headline).toContain("Chain height degraded +1");
  });

  test("awaiting-only degradation is NOT an incident — stays calm", () => {
    const health: ProductHealth = {
      enabled: true,
      at: FIXTURE_NOW,
      status: "degraded",
      checks: 10,
      probes: [
        { name: "product_api", status: "ok", detail: "200", sparkline: [] },
        { name: "money_path", status: "degraded", detail: "awaiting /health settlement counts", sparkline: [] },
      ],
    };
    const b = opsBannerData(health, FIXTURE_NOW);
    expect(b.tone).toBe("calm");
    expect(b.headline).toBe("All product health nominal");
    expect(b.sub).toContain("1 probes green");
    expect(b.sub).toContain("1 awaiting");
  });

  test("off + idle states", () => {
    expect(opsBannerData({ enabled: false, at: null, status: "unknown", checks: 0, probes: [] }, FIXTURE_NOW).headline).toBe(
      "Monitoring is off",
    );
    expect(opsBannerData({ enabled: true, at: null, status: "unknown", checks: 0, probes: [] }, FIXTURE_NOW).headline).toBe(
      "Awaiting first check",
    );
  });
});

describe("pillarStatuses", () => {
  test("live fixture → each pillar toned by its worst probe", () => {
    const pillars = pillarStatuses(OPS_FIXTURE_LIVE.probes);
    expect(pillars).toEqual([
      { label: "Availability", tone: "ok" },
      { label: "Chain", tone: "degraded" },
      { label: "Solvency", tone: "awaiting" },
      { label: "Flow", tone: "awaiting" },
    ]);
  });

  test("red fixture → flow reads red, solvency degraded", () => {
    const byLabel = Object.fromEntries(pillarStatuses(OPS_FIXTURE_RED.probes).map((p) => [p.label, p.tone]));
    expect(byLabel.Flow).toBe("red");
    expect(byLabel.Solvency).toBe("degraded");
    expect(byLabel.Chain).toBe("ok");
    expect(byLabel.Availability).toBe("ok");
  });
});
