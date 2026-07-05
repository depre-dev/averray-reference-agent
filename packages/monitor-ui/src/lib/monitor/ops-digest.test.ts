import { describe, expect, test } from "vitest";
import type { ProductHealth } from "./product-health.js";
import { opsDigestSummary } from "./ops-digest.js";
import { OPS_FIXTURE_LIVE, OPS_FIXTURE_RED } from "./ops-fixtures.js";

describe("opsDigestSummary", () => {
  test("degraded board → degraded tone + the lead real-degraded probe detail", () => {
    const s = opsDigestSummary(OPS_FIXTURE_LIVE);
    expect(s.toneClass).toBe("degraded");
    expect(s.label).toBe("degraded · safe");
    expect(s.detail).toContain("chain not advancing");
  });

  test("red board → fail tone + the red probe detail, not an awaiting probe", () => {
    const s = opsDigestSummary(OPS_FIXTURE_RED);
    expect(s.toneClass).toBe("fail");
    expect(s.label).toContain("red");
    expect(s.detail).toContain("settlements not landing");
  });

  test("healthy board → pass tone, no detail line", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "healthy",
      checks: 5,
      probes: [{ name: "product_api", status: "ok", detail: "200", sparkline: [] }],
    };
    const s = opsDigestSummary(health);
    expect(s.toneClass).toBe("pass");
    expect(s.label).toBe("all healthy");
    expect(s.detail).toBe("");
  });

  test("an awaiting-only degradation does not surface an incident detail", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "degraded",
      checks: 5,
      probes: [
        { name: "product_api", status: "ok", detail: "200", sparkline: [] },
        { name: "money_path", status: "degraded", detail: "awaiting /health settlement counts", sparkline: [] },
      ],
    };
    const s = opsDigestSummary(health);
    expect(s.toneClass).toBe("degraded");
    expect(s.detail).toBe(""); // the only degraded probe is awaiting → not an incident
  });

  test("monitoring off + undefined are honest", () => {
    expect(opsDigestSummary({ enabled: false, at: null, status: "unknown", checks: 0, probes: [] }).label).toBe(
      "monitoring off",
    );
    expect(opsDigestSummary(undefined)).toEqual({ toneClass: "muted", label: "awaiting", detail: "" });
  });
});
