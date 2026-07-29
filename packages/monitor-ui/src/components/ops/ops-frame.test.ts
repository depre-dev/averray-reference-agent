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

  // ── runway (leading indicator) ─────────────────────────────────────────────
  // Probes green + a pool draining toward its floor. Live on mainnet 2026-07-28:
  // the banner said "All product health nominal · 7 probes green" while the
  // co-pilot said "Signer gas ~13h to floor — top up before settlement halts".
  const greenProbes: ProductHealth["probes"] = [
    { name: "product_api", status: "ok", detail: "200", sparkline: [] },
    { name: "signer_liquidity", status: "ok", detail: "gas 3.9585 DOT, reward bank 17.20 USDC", sparkline: [] },
  ];
  const draining = (over: Partial<ProductHealth> = {}, runwayOver: Record<string, unknown> = {}): ProductHealth => ({
    enabled: true,
    at: FIXTURE_NOW,
    status: "healthy",
    checks: 60,
    network: "mainnet",
    probes: greenProbes,
    solvency: {
      pools: [],
      runway: [
        {
          key: "signer_gas", label: "Signer gas", unit: "DOT",
          current: 3.9584888, floor: 1,
          burnPerHour: 0.22895793250420018, hoursToFloor: 12.921538763221175,
          estimable: true, status: "degraded",
          ...runwayOver,
        },
      ],
    },
    ...over,
  });

  test("a draining pool stops the banner claiming 'all nominal' while probes are green", () => {
    const b = opsBannerData(draining(), FIXTURE_NOW);
    expect(b.headline).not.toBe("All product health nominal");
    expect(b.headline).toBe("Signer gas ~13h to floor");
    // A projection is not a breach — amber, never the rose/page tone.
    expect(b.tone).toBe("action");
    expect(b.sub).toContain("0.23 DOT/h"); // the evidence behind the projection
    expect(b.sub).toContain("top up before settlement halts");
    expect(b.sub).toContain("Nothing has breached yet");
    expect((b.mostUrgentReasons ?? []).map((r) => r.label)).toEqual(["projected", "mainnet"]);
  });

  test("a REAL breach still outranks a projection", () => {
    const b = opsBannerData(
      draining({ probes: [{ name: "money_path", status: "red", detail: "13 jobs stuck", sparkline: [] }] }),
      FIXTURE_NOW,
    );
    expect(b.tone).toBe("degraded"); // rose — the actual red wins
    expect(b.headline).toContain("Money path red");
  });

  test("no false urgency: a non-estimable or flat trend stays calm", () => {
    // The same pool a day later — the burst left the estimator window and it
    // resolved to "stable — no depletion trend" (burn ≈ 0, hoursToFloor null).
    const stable = opsBannerData(draining({}, { burnPerHour: 1.9e-26, hoursToFloor: null, status: "ok" }), FIXTURE_NOW);
    expect(stable.headline).toBe("All product health nominal");
    expect(stable.tone).toBe("calm");
    // And a too-short sample the backend refuses to estimate is never urgency.
    const notEstimable = opsBannerData(draining({}, { estimable: false }), FIXTURE_NOW);
    expect(notEstimable.headline).toBe("All product health nominal");
  });

  test("nearest pool leads, others get a +N suffix; at-floor and sub-hour read honestly", () => {
    const two = draining();
    two.solvency!.runway!.push({
      key: "reward_bank", label: "Reward bank", unit: "USDC",
      current: 17.2, floor: 2, burnPerHour: 0.297, hoursToFloor: 51.1,
      estimable: true, status: "degraded",
    });
    expect(opsBannerData(two, FIXTURE_NOW).headline).toBe("Signer gas ~13h to floor +1");
    expect(opsBannerData(draining({}, { hoursToFloor: 0 }), FIXTURE_NOW).headline).toBe("Signer gas at its floor");
    expect(opsBannerData(draining({}, { hoursToFloor: 0.4 }), FIXTURE_NOW).headline).toBe("Signer gas <1h to floor");
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
