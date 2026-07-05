import { describe, expect, test } from "vitest";
import type { ProductHealthProbe, SolvencyPool } from "./product-health.js";
import {
  groupProbesByPillar,
  isAwaitingProbe,
  probeOpsTone,
  funnelSteps,
  hasFlowData,
  solvencyRows,
  incidentRows,
  formatAmount,
  formatDuration,
} from "./ops-model.js";
import { OPS_FIXTURE_POPULATED, FIXTURE_NOW } from "./ops-fixtures.js";

const probe = (name: string, status: ProductHealthProbe["status"], detail = ""): ProductHealthProbe => ({
  name,
  status,
  detail,
  sparkline: [],
});

describe("groupProbesByPillar", () => {
  test("buckets the 7 probes into the four pillars in canonical order", () => {
    const groups = groupProbesByPillar(OPS_FIXTURE_POPULATED.probes);
    expect(groups.map((g) => g.pillar)).toEqual(["availability", "chain", "solvency", "flow"]);
    expect(groups[0].probes.map((p) => p.name)).toEqual(["product_api", "api_latency"]);
    expect(groups[1].probes.map((p) => p.name)).toEqual(["chain_height", "capabilities"]);
    expect(groups[2].probes.map((p) => p.name)).toEqual(["signer_liquidity", "treasury_liquidity"]);
    expect(groups[3].probes.map((p) => p.name)).toEqual(["money_path"]);
  });

  test("omits pillars with no probes", () => {
    const groups = groupProbesByPillar([probe("product_api", "ok")]);
    expect(groups.map((g) => g.pillar)).toEqual(["availability"]);
  });
});

describe("awaiting vs degraded tone", () => {
  test("a degraded probe whose detail says 'awaiting' reads as awaiting, not amber", () => {
    const p = probe("money_path", "degraded", "awaiting /health settlement counts");
    expect(isAwaitingProbe(p)).toBe(true);
    expect(probeOpsTone(p)).toBe("awaiting");
  });

  test("catches the live product's forward-compat wordings, not just 'awaiting'", () => {
    // Live money_path phrases it "does not expose … yet"; treasury "not exposed
    // by /health yet" — both must read as awaiting (grey), never amber degraded.
    expect(isAwaitingProbe(probe("money_path", "degraded", "product /health does not expose settlement counts yet"))).toBe(true);
    expect(isAwaitingProbe(probe("treasury_liquidity", "degraded", "treasury addresses not exposed by /health yet"))).toBe(true);
    expect(isAwaitingProbe(probe("x", "degraded", "not wired yet"))).toBe(true);
  });

  test("a genuine degradation stays degraded", () => {
    const p = probe("chain_height", "degraded", "chain not advancing — last block 3d 20h old");
    expect(isAwaitingProbe(p)).toBe(false);
    expect(probeOpsTone(p)).toBe("degraded");
  });

  test("red always wins, even if the detail mentions awaiting", () => {
    const p = probe("money_path", "red", "no data landing — awaiting recovery");
    expect(isAwaitingProbe(p)).toBe(false);
    expect(probeOpsTone(p)).toBe("red");
  });

  test("ok is ok", () => {
    expect(probeOpsTone(probe("product_api", "ok", "200"))).toBe("ok");
  });
});

describe("funnelSteps", () => {
  test("tones settled ok, stuck>0 amber, failed>0 coral", () => {
    const steps = funnelSteps({ claimed: 41, submitted: 39, settled24h: 37, stuck: 1, failed24h: 2 });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.settled.value).toBe(37);
    expect(byKey.settled.tone).toBe("ok");
    expect(byKey.stuck.tone).toBe("degraded");
    expect(byKey.failed.tone).toBe("red");
  });

  test("zero stuck / failed stay neutral, not amber/coral", () => {
    const steps = funnelSteps({ stuck: 0, failed24h: 0 });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.stuck.tone).toBe("neutral");
    expect(byKey.failed.tone).toBe("neutral");
  });

  test("missing counts render as null, never fabricated zeros", () => {
    const steps = funnelSteps(undefined);
    expect(steps.every((s) => s.value === null)).toBe(true);
  });
});

describe("hasFlowData", () => {
  test("true once any count is present", () => {
    expect(hasFlowData({ settled24h: 3 })).toBe(true);
  });
  test("false for undefined or all-null", () => {
    expect(hasFlowData(undefined)).toBe(false);
    expect(hasFlowData({ stuck: null, failed24h: null })).toBe(false);
  });
});

describe("solvencyRows", () => {
  const pools: SolvencyPool[] = [
    { key: "usdc", label: "USDC", amount: 2, unit: "USDC", floor: 1, status: "degraded" },
    { key: "await", label: "Reward", amount: null, unit: "USDC", floor: 25, status: "degraded" },
    { key: "escrow", label: "Escrow", amount: 96, unit: "USDC", status: "ok", informational: true },
  ];

  test("floored pool gets a bounded meter fill and a labelled amount", () => {
    const rows = solvencyRows(pools);
    expect(rows[0].fill).toBeGreaterThan(0);
    expect(rows[0].fill).toBeLessThanOrEqual(1);
    expect(rows[0].amountLabel).toBe("2.00 USDC");
    expect(rows[0].floorLabel).toBe("floor 1.00");
  });

  test("awaiting pool has no meter + an awaiting label", () => {
    const rows = solvencyRows(pools);
    expect(rows[1].fill).toBeNull();
    expect(rows[1].amountLabel).toBe("awaiting data");
  });

  test("unfloored informational pool has no meter and no floor label", () => {
    const rows = solvencyRows(pools);
    expect(rows[2].fill).toBeNull();
    expect(rows[2].floorLabel).toBeNull();
  });
});

describe("incidentRows", () => {
  test("sorts newest-first and marks ongoing with a live duration", () => {
    const rows = incidentRows(
      {
        incidents: [
          { id: "old", probe: "api_latency", severity: "degraded", startedAt: FIXTURE_NOW - 10_000, endedAt: FIXTURE_NOW - 5_000 },
          { id: "new", probe: "chain_height", severity: "degraded", startedAt: FIXTURE_NOW - 2_000, endedAt: null },
        ],
      },
      FIXTURE_NOW,
    );
    expect(rows.map((r) => r.id)).toEqual(["new", "old"]);
    expect(rows[0].ongoing).toBe(true);
    expect(rows[0].durationMs).toBe(2_000);
    expect(rows[1].ongoing).toBe(false);
    expect(rows[1].durationMs).toBe(5_000);
  });

  test("undefined history yields no rows", () => {
    expect(incidentRows(undefined, FIXTURE_NOW)).toEqual([]);
  });
});

describe("formatters", () => {
  test("formatAmount", () => {
    expect(formatAmount(2)).toBe("2.00");
    expect(formatAmount(184.5)).toBe("184.50");
    expect(formatAmount(4999.99)).toBe("4999.99");
    expect(formatAmount(12_345)).toBe("12.3k");
    expect(formatAmount(1_500_000)).toBe("1.50M");
  });

  test("formatDuration", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(7 * 60_000)).toBe("7m");
    expect(formatDuration(4 * 3_600_000 + 12 * 60_000)).toBe("4h 12m");
    expect(formatDuration(3 * 86_400_000 + 20 * 3_600_000)).toBe("3d 20h");
  });
});
