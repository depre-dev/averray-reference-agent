import { describe, expect, test } from "vitest";
import type { ProductHealth } from "./product-health.js";
import { opsSuggestions } from "./ops-suggestions.js";
import { OPS_FIXTURE_LIVE, OPS_FIXTURE_NOMINAL, OPS_FIXTURE_RED } from "./ops-fixtures.js";

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

  test("the rendered text is EXACTLY what it was before the next-step map was shared", () => {
    // These three strings now come from @avg/schemas/ops-next-step, which the
    // pushed #Ops alerts read too — one source, two surfaces. Pinning them here
    // is what makes that refactor provable: if the shared phrase changes, the
    // board's wording changes with it, and this test says so out loud rather
    // than letting the two drift into disagreeing about the same incident.
    const health: ProductHealth = {
      enabled: true,
      at: 1,
      status: "red",
      checks: 10,
      probes: [
        { name: "signer_liquidity", status: "red", detail: "USDC 1.00 below floor 1.00", sparkline: [] },
        { name: "treasury_liquidity", status: "red", detail: "reserve 2.00 USDC", sparkline: [] },
        { name: "capabilities", status: "degraded", detail: "external posting staged", sparkline: [] },
      ],
    };
    const byId = Object.fromEntries(opsSuggestions(health).map((s) => [s.id, s]));
    expect(byId["signer-floor"].text).toBe("Reward bank below floor — top up before the next payout.");
    expect(byId["treasury-floor"].text).toBe("Treasury reserve low — reserve 2.00 USDC. Refill (operator action).");
    expect(byId["capabilities"].text).toBe("Capabilities — external posting staged. Check config.");
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
          { key: "reward_bank", label: "reward bank", unit: "USDC", current: 3, floor: 1, burnPerHour: 0.4, hoursToFloor: 5, estimable: true, status: "red" },
        ],
      },
    };
    const byId = Object.fromEntries(opsSuggestions(health).map((s) => [s.id, s]));
    expect(byId["signer-runway"]).toBeTruthy();
    expect(byId["signer-runway"].tone).toBe("act"); // red projection
    expect(byId["signer-runway"].text).toContain("reward bank ~5h to floor");
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
          { key: "reward_bank", label: "reward bank", unit: "USDC", current: 1, floor: 1, burnPerHour: 0.4, hoursToFloor: 0, estimable: true, status: "red" },
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
          { key: "reward_bank", label: "reward bank", unit: "USDC", current: 3, floor: 1, burnPerHour: 0, hoursToFloor: null, estimable: true, status: "ok" },
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

// ── THE BANK LANE, AND THE STRIP THAT FINALLY RENDERS ANY OF THIS ─────────
//
// On 2026-08-04 the desk board carried `1 OVERDUE · leg2-dispatched for 8.7h`,
// still aging, and nothing anywhere told the operator what to do about it —
// because this module, which has derived probe-cited remediations for eight
// incident types since 2026-07, was imported by NOTHING. It was wired to the
// co-pilot board the ops-only pivot replaced.
describe("bank — an overdue venue request", () => {
  const withOverdue = (over: Partial<{ overdueRequestId: string | null; text: string }> = {}) =>
    ({
      ...OPS_FIXTURE_NOMINAL,
      bank: {
        lane: {
          ...OPS_FIXTURE_NOMINAL.bank!.lane!,
          overdueRequestId: over.overdueRequestId === undefined ? "0xb609f4d8…f57ecaac" : over.overdueRequestId,
          requests: { text: over.text ?? "1 OVERDUE · 0xb609f4d8…f57ecaac leg2-dispatched for 8.7h", tone: "red" as const },
        },
      },
    }) as ProductHealth;

  test("an overdue request produces a suggestion carrying the probe's own words", () => {
    const s = opsSuggestions(withOverdue()).find((x) => x.id === "bank-overdue");
    expect(s).toBeTruthy();
    expect(s!.text).toContain("8.7h");
    // No leg assertion: the first live overdue after the original wording
    // shipped was a request that never dispatched ANY leg. The advice must not
    // presuppose where it stopped — that is what the investigation determines.
    expect(s!.text).toContain("Determine where it actually stopped");
    expect(s!.text).not.toContain("leg 2");
  });

  test("its task INVESTIGATES and is explicit about not moving funds", () => {
    // Money is operator-only. A worker traces and drafts; it never transfers.
    const s = opsSuggestions(withOverdue()).find((x) => x.id === "bank-overdue")!;
    expect(s.task?.prompt).toMatch(/do NOT move funds/i);
    expect(s.task?.prompt).toMatch(/INVESTIGATE ONLY/i);
  });

  test("no overdue request, no suggestion — a healthy lane says nothing", () => {
    const s = opsSuggestions(withOverdue({ overdueRequestId: null })).find((x) => x.id === "bank-overdue");
    expect(s).toBeUndefined();
  });
});

// ── A red the probe could not READ ──────────────────────────────────────────
//
// 2026-08-06: the monitor's container lost DNS for five minutes. The suggestion
// drafted from that red would have told a worker to tail the product's logs and
// roll back a deploy — over a fault on our own side of the wire, against a
// product that was serving 200s throughout.
describe("opsSuggestions — product_api unreachable", () => {
  const unreachable: ProductHealth = {
    enabled: true,
    at: 1,
    status: "red",
    checks: 10,
    probes: [
      {
        name: "product_api",
        status: "red",
        reading: "unknown",
        detail: "probe cannot reach https://api.averray.com/health — DNS resolution failed (ENOTFOUND) · 3 consecutive checks · unreachable from the monitor; whether the product is up is unknown from here",
        sparkline: [],
      },
    ],
  };

  test("does not claim the product is down", () => {
    const byId = Object.fromEntries(opsSuggestions(unreachable).map((s) => [s.id, s]));
    expect(byId["product-api-down"]).toBeUndefined();
    expect(byId["product-api-unreachable"]).toBeTruthy();
    expect(byId["product-api-unreachable"].text).toContain("unreachable from the monitor");
  });

  test("drafts a task that diagnoses the wire, and forbids a blind rollback", () => {
    const suggestion = opsSuggestions(unreachable).find((s) => s.id === "product-api-unreachable")!;
    expect(suggestion.task?.prompt).toContain("REACHABILITY fault");
    expect(suggestion.task?.prompt).toContain("DNS resolution and egress");
    expect(suggestion.task?.prompt).toContain("Do not roll back");
  });

  test("a product_api red that DID get a response still drafts the down task", () => {
    const answered: ProductHealth = {
      ...unreachable,
      probes: [{ name: "product_api", status: "red", detail: "https://api.averray.com/health → HTTP 503", sparkline: [] }],
    };
    const byId = Object.fromEntries(opsSuggestions(answered).map((s) => [s.id, s]));
    expect(byId["product-api-down"]).toBeTruthy();
    expect(byId["product-api-unreachable"]).toBeUndefined();
  });

  test("dependent probes with no reading raise no suggestions at all", () => {
    const blind: ProductHealth = {
      ...unreachable,
      probes: [
        { name: "money_path", status: "degraded", reading: "unknown", detail: "settlement state unknown, not stalled — product /health not readable from here — DNS resolution failed (ENOTFOUND)", sparkline: [] },
        { name: "api_latency", status: "degraded", reading: "unknown", detail: "round-trip latency unknown, not slow — product /health not readable from here — DNS resolution failed (ENOTFOUND)", sparkline: [] },
      ],
    };
    expect(opsSuggestions(blind)).toEqual([]);
  });
});
