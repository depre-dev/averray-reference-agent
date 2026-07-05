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

  test("runway projection → proactive pre-floor suggestion carrying a PREPARE task", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "degraded",
      checks: 10,
      probes: [{ name: "signer_liquidity", status: "ok", detail: "gas 4999.99, USDC 3.00", sparkline: [] }],
      solvency: {
        pools: [],
        runway: [
          { key: "signer_gas", label: "signer gas", unit: "PAS", current: 4999, floor: 1, burnPerHour: null, hoursToFloor: null, estimable: true, status: "ok" },
          { key: "signer_usdc", label: "signer USDC", unit: "USDC", current: 3, floor: 1, burnPerHour: 0.4, hoursToFloor: 5, estimable: true, status: "red" },
        ],
      },
    };
    const byId = Object.fromEntries(opsSuggestions(health).map((s) => [s.id, s]));
    expect(byId["signer-runway"]).toBeTruthy();
    expect(byId["signer-runway"].tone).toBe("act"); // red projection
    expect(byId["signer-runway"].text).toContain("signer USDC ~5h to floor");
    expect(byId["signer-runway"].task?.prompt).toContain("PREPARE ONLY");
    expect(byId["signer-runway"].task?.prompt).toContain("do NOT move funds");
    expect(byId["signer-runway"].task?.repo).toContain("averray-reference-agent");
    expect(byId["signer-floor"]).toBeUndefined(); // signer probe is healthy → no at-floor item
  });

  test("runway at floor (0h) does not double up — signer-floor owns the at-floor case", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "red",
      checks: 10,
      probes: [{ name: "signer_liquidity", status: "red", detail: "USDC 1.00 below floor 1.00", sparkline: [] }],
      solvency: {
        pools: [],
        runway: [
          { key: "signer_usdc", label: "signer USDC", unit: "USDC", current: 1, floor: 1, burnPerHour: 0.4, hoursToFloor: 0, estimable: true, status: "red" },
        ],
      },
    };
    const byId = Object.fromEntries(opsSuggestions(health).map((s) => [s.id, s]));
    expect(byId["signer-floor"]).toBeTruthy(); // probe below floor
    expect(byId["signer-runway"]).toBeUndefined(); // hoursToFloor 0 excluded from the proactive one
  });

  test("stable / awaiting runway → no proactive suggestion", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "healthy",
      checks: 10,
      probes: [{ name: "signer_liquidity", status: "ok", detail: "USDC 3.00", sparkline: [] }],
      solvency: {
        pools: [],
        runway: [
          { key: "signer_usdc", label: "signer USDC", unit: "USDC", current: 3, floor: 1, burnPerHour: 0, hoursToFloor: null, estimable: true, status: "ok" },
        ],
      },
    };
    expect(opsSuggestions(health).find((s) => s.id === "signer-runway")).toBeUndefined();
  });
});
