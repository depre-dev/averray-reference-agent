import { describe, expect, test } from "vitest";
import type { ProductHealth } from "./product-health.js";
import { opsSuggestions } from "./ops-suggestions.js";
import { OPS_FIXTURE_LIVE, OPS_FIXTURE_RED } from "./ops-fixtures.js";

describe("opsSuggestions", () => {
  test("red board → signer-below-floor (PREPARE task) + money-path (investigate task)", () => {
    const byId = Object.fromEntries(opsSuggestions(OPS_FIXTURE_RED).map((s) => [s.id, s]));
    expect(byId["signer-floor"]).toBeTruthy();
    // funds → PREPARE-only task (compute + draft), never a transfer
    expect(byId["signer-floor"].task?.prompt).toContain("PREPARE ONLY");
    expect(byId["signer-floor"].task?.prompt).toContain("do NOT move funds");
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

  test("product API down → investigate task, ordered most-actionable first", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "red",
      checks: 5,
      probes: [
        { name: "product_api", status: "red", detail: "503 from /health", sparkline: [] },
        { name: "api_latency", status: "degraded", detail: "p95 1400ms", sparkline: [] },
      ],
    };
    const s = opsSuggestions(health);
    expect(s[0].id).toBe("product-api-down"); // most-actionable first
    expect(s[0].tone).toBe("act");
    expect(s[0].task?.prompt).toContain("503 from /health");
    expect(s[0].task?.repo).toContain("averray-reference-agent");
  });

  test("elevated API latency → investigate task citing the detail", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "degraded",
      checks: 5,
      probes: [{ name: "api_latency", status: "degraded", detail: "p95 1400ms", sparkline: [] }],
    };
    const byId = Object.fromEntries(opsSuggestions(health).map((s) => [s.id, s]));
    expect(byId["api-latency"].tone).toBe("warn");
    expect(byId["api-latency"].task?.prompt).toContain("1400ms");
  });

  test("treasury reserve low → PREPARE-only task (never a transfer)", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "red",
      checks: 5,
      probes: [{ name: "treasury_liquidity", status: "red", detail: "reserve 40 below floor 100", sparkline: [] }],
    };
    const byId = Object.fromEntries(opsSuggestions(health).map((s) => [s.id, s]));
    expect(byId["treasury-floor"].tone).toBe("act");
    expect(byId["treasury-floor"].task?.prompt).toContain("PREPARE ONLY");
    expect(byId["treasury-floor"].task?.prompt).toContain("do NOT move funds");
  });

  test("degraded capability now carries an investigate task naming the detail", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "degraded",
      checks: 5,
      probes: [{ name: "capabilities", status: "degraded", detail: "treasuryMutations down", sparkline: [] }],
    };
    const byId = Object.fromEntries(opsSuggestions(health).map((s) => [s.id, s]));
    expect(byId["capabilities"].task?.prompt).toContain("treasuryMutations down");
  });

  test("mainnet chain halt → escalate task, not the testnet 'wait it out'", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "red",
      checks: 5,
      network: "mainnet",
      probes: [{ name: "chain_height", status: "red", detail: "not advancing — 12m stall", sparkline: [] }],
    };
    const byId = Object.fromEntries(opsSuggestions(health).map((s) => [s.id, s]));
    expect(byId["chain-halt"]).toBeTruthy();
    expect(byId["chain-halt"].tone).toBe("act");
    expect(byId["chain-halt"].task?.prompt).toContain("MAINNET");
    expect(byId["chain-frozen"]).toBeUndefined();
  });

  test("awaiting-data probes produce nothing across the full catalog (truth-boundary)", () => {
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "degraded",
      checks: 5,
      probes: [
        { name: "money_path", status: "degraded", detail: "product /health does not expose settlement counts yet", sparkline: [] },
        { name: "treasury_liquidity", status: "degraded", detail: "treasury addresses not exposed by /health yet", sparkline: [] },
      ],
    };
    expect(opsSuggestions(health)).toEqual([]);
  });
});
