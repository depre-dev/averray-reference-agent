import { describe, expect, test } from "vitest";
import type { ProductHealth } from "./product-health.js";
import { opsSuggestions } from "./ops-suggestions.js";
import { OPS_FIXTURE_LIVE, OPS_FIXTURE_RED } from "./ops-fixtures.js";

describe("opsSuggestions", () => {
  test("red board → signer-below-floor (informational) + money-path (proposed task)", () => {
    const byId = Object.fromEntries(opsSuggestions(OPS_FIXTURE_RED).map((s) => [s.id, s]));
    expect(byId["signer-floor"]).toBeTruthy();
    expect(byId["signer-floor"].task).toBeUndefined(); // funds = operator-only, never a task
    expect(byId["money-stuck"]).toBeTruthy();
    expect(byId["money-stuck"].tone).toBe("act");
    expect(byId["money-stuck"].task?.prompt).toContain("money path");
    expect(byId["money-stuck"].task?.repo).toContain("averray-reference-agent");
  });

  test("live board → chain-frozen (informational); awaiting probes produce nothing", () => {
    const suggestions = opsSuggestions(OPS_FIXTURE_LIVE);
    const ids = suggestions.map((s) => s.id);
    expect(ids).toContain("chain-frozen");
    expect(ids).not.toContain("money-stuck"); // money_path is awaiting-data → skipped
    expect(ids).not.toContain("signer-floor"); // signer healthy in the live fixture
    expect(suggestions.find((s) => s.id === "chain-frozen")?.task).toBeUndefined();
  });

  test("healthy / off / empty → no suggestions", () => {
    expect(
      opsSuggestions({
        enabled: true,
        at: 1,
        status: "healthy",
        checks: 5,
        probes: [{ name: "product_api", status: "ok", detail: "200", sparkline: [] }],
      }),
    ).toEqual([]);
    expect(opsSuggestions({ enabled: false, at: null, status: "unknown", checks: 0, probes: [] })).toEqual([]);
    expect(opsSuggestions(undefined)).toEqual([]);
  });

  test("mainnet degraded chain does not get the testnet 'wait it out' suggestion", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "degraded",
      checks: 5,
      network: "mainnet",
      probes: [{ name: "chain_height", status: "degraded", detail: "not advancing", sparkline: [] }],
    };
    expect(opsSuggestions(health).find((s) => s.id === "chain-frozen")).toBeUndefined();
  });
});
