// @vitest-environment jsdom
//
// The phone board's contract.
//
// Carried across the spec-sheet redesign rather than rewritten: every guarantee
// the previous phone board asserted is still asserted here, against the new
// markup. One of them — "a runway projection reaches the phone" — caught a real
// regression during this rewrite: the desktop redesign had dropped the
// draining-pool warning from BOTH surfaces, and only this test noticed.
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import { MobileBoard } from "./MobileBoard.js";
import type { ProductHealth, SolvencyPool } from "../../lib/monitor/product-health.js";
import { OPS_FIXTURE_NOMINAL, OPS_FIXTURE_STRESS } from "../../lib/monitor/ops-fixtures.js";

afterEach(cleanup);

const fresh = (h: ProductHealth) => (h.at ?? 0) + 2_000;
const STRESS_NOW = OPS_FIXTURE_STRESS.at! + 4 * 60_000;

describe("phone board — the check-in", () => {
  test("the verdict is the first thing, as a filled field", () => {
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const verdict = getByTestId("mobile-verdict");
    expect(verdict.getAttribute("data-tone")).toBe("ok");
    expect(within(verdict).getByRole("heading").textContent).toBe("NOMINAL");
  });

  test("trust is compressed but never cut — it matters more here, not less", () => {
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const trust = getByTestId("mobile-trust").textContent ?? "";
    expect(trust).toContain("live");
    expect(trust).toContain("865942ef");
  });

  test("an unknown monitor build says so rather than implying current", () => {
    const health: ProductHealth = { ...OPS_FIXTURE_NOMINAL, self: undefined };
    const { getByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    expect(getByTestId("mobile-trust").textContent).toContain("build unknown");
  });

  // THE SHIPPED BUG, still unrepresentable: the deliberately-empty treasury
  // reserve once drew a full green bar and read "healthy and full".
  test("a ZERO no-floor pool draws NO meter and is named on the collapsed line", () => {
    const { getByTestId, container } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    // Three floored pools → exactly three meters. Reserve/escrow/revenue get none.
    expect(container.querySelectorAll(".hm-ph-meter")).toHaveLength(3);
    const collapsed = getByTestId("mobile-unfloored").textContent ?? "";
    expect(collapsed).toContain("treasury reserve");
    expect(collapsed).toContain("no floor, no meter");
  });

  test("a pool with no floor has no scale, so it gets no meter either", () => {
    const pools: SolvencyPool[] = [
      { key: "odd", label: "Unfloored", amount: 99, unit: "USDC", status: "ok" },
    ];
    const health: ProductHealth = { ...OPS_FIXTURE_NOMINAL, solvency: { pools } };
    const { container, getByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    expect(container.querySelectorAll(".hm-ph-meter")).toHaveLength(0);
    expect(getByTestId("mobile-unfloored").textContent).toContain("99.00");
  });

  test("an unreadable balance is '—', never 0", () => {
    const pools: SolvencyPool[] = [
      { key: "bank", label: "Reward bank", amount: null, unit: "USDC", floor: 2, status: "ok" },
    ];
    const health: ProductHealth = { ...OPS_FIXTURE_NOMINAL, solvency: { pools } };
    const { getByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    const text = getByTestId("mobile-unfloored").textContent ?? "";
    expect(text).toContain("—");
    expect(text).not.toMatch(/\b0\.00\b/);
  });

  // Funnel and proof are one card on purpose: a contradiction the operator has
  // to scroll between is one they will miss.
  test("the funnel and its on-chain proof are never split apart", () => {
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const flow = getByTestId("mobile-flow");
    expect(flow.textContent).toContain("settled");
    expect(within(flow).getByTestId("mobile-evidence").textContent).toContain("CONFIRMED");
  });

  // THE REGRESSION THIS FILE CAUGHT. A pool can drain toward its floor while
  // every probe still reads green — seven probes green on mainnet while the
  // co-pilot said "signer gas ~13h to floor". The redesign dropped it; this
  // test is why it came back, in the shared verdict, for both surfaces.
  test("a draining pool stops the board saying NOMINAL", () => {
    const health: ProductHealth = {
      ...OPS_FIXTURE_NOMINAL,
      solvency: {
        pools: OPS_FIXTURE_NOMINAL.solvency!.pools,
        runway: [
          {
            key: "signer_gas",
            label: "Signer gas",
            unit: "DOT",
            current: 2.69,
            floor: 1,
            burnPerHour: 0.13,
            hoursToFloor: 13,
            estimable: true,
            status: "degraded",
          },
        ],
      },
    };
    const { getByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    const verdict = getByTestId("mobile-verdict");
    expect(verdict.textContent).toContain("13H TO FLOOR");
    // A projection is not a breach: amber, never red.
    expect(verdict.getAttribute("data-tone")).toBe("degraded");
    expect(verdict.textContent).toContain("nothing has breached yet");
  });

  test("a projection that is not estimable makes no claim at all", () => {
    const health: ProductHealth = {
      ...OPS_FIXTURE_NOMINAL,
      solvency: {
        pools: OPS_FIXTURE_NOMINAL.solvency!.pools,
        runway: [
          {
            key: "signer_gas",
            label: "Signer gas",
            unit: "DOT",
            current: 2.69,
            floor: 1,
            burnPerHour: null,
            hoursToFloor: null,
            estimable: false,
            status: "degraded",
          },
        ],
      },
    };
    const { getByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    expect(getByTestId("mobile-verdict").textContent).toContain("NOMINAL");
  });
});

describe("phone board — the alert landing", () => {
  test("leads with the breach, answering how bad / since when / still true", () => {
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_STRESS} streamDegraded streamStatus="reconnecting" nowMs={STRESS_NOW} />,
    );
    const breach = getByTestId("mobile-breach").textContent ?? "";
    expect(breach).toContain("1.42");
    expect(breach).toContain("short 0.58");
    expect(breach).toContain("SINCE");
    expect(breach).toContain("STILL TRUE?");
    expect(breach).toContain("payouts halt");
  });

  // With the stream down we cannot see the pool any more. Saying "yes, still
  // breached" asserts something we stopped being able to observe.
  test("with the stream down, STILL TRUE is honestly unknown", () => {
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_STRESS} streamDegraded streamStatus="reconnecting" nowMs={STRESS_NOW} />,
    );
    expect(getByTestId("mobile-breach").textContent).toContain("unknown");
  });

  test("the breach card replaces the pool list — it does not sit under it", () => {
    const { queryByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_STRESS} streamDegraded nowMs={STRESS_NOW} />,
    );
    expect(queryByTestId("mobile-breach")).toBeTruthy();
    expect(queryByTestId("mobile-solvency")).toBeNull();
  });

  test("the clean funnel and the shortfall proof stay in one card", () => {
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_STRESS} streamDegraded nowMs={STRESS_NOW} />,
    );
    const flow = getByTestId("mobile-flow").textContent ?? "";
    expect(flow).toContain("9 → 9 → 9");
    expect(flow).toContain("SHORTFALL −2");
  });

  // Deliberate divergence from desktop: no 72% dim, because this screen gets
  // read in sunlight. The fence is the band + re-captioned verdict instead.
  test("untrusted data is fenced, NOT dimmed", () => {
    const { getByTestId, container } = render(
      <MobileBoard health={OPS_FIXTURE_STRESS} streamDegraded streamStatus="reconnecting" nowMs={STRESS_NOW} />,
    );
    expect(getByTestId("mobile-stale").textContent).toContain("STREAM DOWN");
    expect(getByTestId("mobile-verdict").textContent).toContain("LAST KNOWN");
    expect(container.querySelector('[data-dim="yes"]')).toBeNull();
  });
});

describe("phone board — the cuts", () => {
  test("eight probes become four one-line pillars, detail only when not ok", () => {
    const { container, getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(container.querySelectorAll(".hm-ph-pillar")).toHaveLength(4);
    // CHAIN carries the acknowledged capabilities warning, so it earns a detail
    // line; AVAILABILITY is all-ok and gets one line only.
    expect(getByTestId("mobile-pillar-CHAIN").textContent).toContain("capabilities");
    expect(getByTestId("mobile-pillar-AVAILABILITY").querySelector("p")).toBeNull();
  });

  test("failing pillars sort to the top — reading order is the only hierarchy left", () => {
    const { container } = render(
      <MobileBoard health={OPS_FIXTURE_STRESS} streamDegraded nowMs={STRESS_NOW} />,
    );
    expect(container.querySelector(".hm-ph-pillar")?.textContent).toContain("SOLVENCY");
  });

  test("LLM spend is gone from this surface entirely", () => {
    const { container } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(container.textContent).not.toMatch(/LLM/i);
  });

  // Read-only on every surface. An earlier phone board offered Approve on a
  // card that could not say what it was approving; removing it was the fix.
  test("there are no controls at all", () => {
    const { container } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).toContain("READ-ONLY");
  });
});

describe("phone board — degraded transports", () => {
  test("no health payload does not crash, and a dead stream still says so", () => {
    const { getByTestId, getByText } = render(<MobileBoard streamDegraded streamStatus="closed" />);
    expect(getByTestId("mobile-loading")).toBeTruthy();
    expect(getByText("Health unknown")).toBeTruthy();
  });

  test("monitoring off reads NOT WATCHING, not a green board", () => {
    const health: ProductHealth = { enabled: false, at: null, status: "unknown", checks: 0, probes: [] };
    const { getByTestId } = render(<MobileBoard health={health} nowMs={1} />);
    expect(getByTestId("mobile-verdict").textContent).toContain("NOT WATCHING");
  });
});

describe("phone board — what you can act on, and what you would not be told", () => {
  // A breached pool that IS a wallet, with both encodings the way the backend
  // emits them.
  const breachedSigner: SolvencyPool = {
    key: "signer_gas",
    label: "Signer gas",
    amount: 0.42,
    unit: "DOT",
    floor: 1,
    status: "red",
    address: "0x5a6836c6D4d293F6E5377E6c28054F4171915813",
    addressSs58: "133YGXLeo4Rf2aWc7JXUbq7rmDnTrFp7tLj7Q9xdCt4bcYcg",
  };
  const withBreach = (pool: SolvencyPool): ProductHealth => ({
    ...OPS_FIXTURE_STRESS,
    solvency: { pools: [pool] },
  });

  test("a dry signer shows where to send funds, in BOTH encodings", () => {
    // An alert that says the signer is empty and makes you go find the address
    // somewhere else has stopped short of the point.
    const { getByTestId } = render(<MobileBoard health={withBreach(breachedSigner)} nowMs={STRESS_NOW} />);
    const topUp = getByTestId("mobile-breach-topup");
    expect(topUp.textContent).toContain("0x5a6836c6D4d293F6E5377E6c28054F4171915813");
    expect(topUp.textContent).toContain("133YGXLeo4Rf2aWc7JXUbq7rmDnTrFp7tLj7Q9xdCt4bcYcg");
  });

  test("a breached pool that is NOT a wallet offers no address", () => {
    // Reward bank is an in-contract position; a contract address beside it
    // would invite sending DOT somewhere with no way back, at the worst moment,
    // on the smallest screen.
    const { queryByTestId } = render(
      <MobileBoard
        health={withBreach({ key: "reward_bank", label: "Reward bank", amount: 0.5, unit: "USDC", floor: 2, status: "red" })}
        nowMs={STRESS_NOW}
      />,
    );
    expect(queryByTestId("mobile-breach-topup")).toBeNull();
  });

  test("a failing #ops channel is stated — you would not have been told", () => {
    // The fact that changes what the operator does next: the next alert will
    // not arrive. It belongs on the phone more than anywhere else.
    const { container } = render(
      <MobileBoard
        health={{ ...OPS_FIXTURE_NOMINAL, buzz: { status: "failing", detail: "FAILING 2m ago — auth-rejected" } }}
        nowMs={fresh(OPS_FIXTURE_NOMINAL)}
      />,
    );
    expect(container.textContent).toContain("#ops NOT DELIVERING");
  });

  test("an untested channel says so rather than staying silent", () => {
    const { container } = render(
      <MobileBoard
        health={{ ...OPS_FIXTURE_NOMINAL, buzz: { status: "armed", detail: "armed · nothing delivered yet" } }}
        nowMs={fresh(OPS_FIXTURE_NOMINAL)}
      />,
    );
    expect(container.textContent).toContain("#ops untested");
  });

  test("a HEALTHY channel does not spend the phone's trust line saying so", () => {
    // Space on this screen is the scarcest thing it has.
    const { container } = render(
      <MobileBoard
        health={{ ...OPS_FIXTURE_NOMINAL, buzz: { status: "ok", detail: "delivered 4m ago" } }}
        nowMs={fresh(OPS_FIXTURE_NOMINAL)}
      />,
    );
    expect(container.textContent).not.toContain("#ops");
  });

  test("a phone pool shows its address under the balance, stacked to stay legible", () => {
    // Same placement rule as the desktop — under the number it belongs to — but
    // stacked, because 100 monospace glyphs do not fit 390px. This board
    // scrolls, so the extra line costs nothing that matters.
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const addr = getByTestId("mobile-pool-addr-aac");
    expect(addr.textContent).toContain("0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57");
    expect(addr.textContent).toContain("151MENb3J9ZiBv147yhNkPDiY8rXF7TrWc13PqWYJeLuupBd");
  });

  test("a phone pool with no balance-read address shows none", () => {
    const { queryByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(queryByTestId("mobile-pool-addr-reward_bank")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE BANK LANE ON THE PHONE
//
// The regression these guard: on 2026-08-04 the desk board carried this lane
// red — `1 OVERDUE · leg2-dispatched for 8.7h`, still aging — while the phone
// reported the same system NOMINAL and never named it. Searching the rendered
// mobile text for "OVERDUE" returned nothing. The screen read away from the
// desk was the one omitting the only thing that was wrong.
describe("phone board — the bank lane", () => {
  const laneOf = (over: Partial<NonNullable<NonNullable<ProductHealth["bank"]>["lane"]>> = {}) => {
    const base = OPS_FIXTURE_NOMINAL.bank!.lane!;
    return { ...OPS_FIXTURE_NOMINAL, bank: { lane: { ...base, ...over } } } as ProductHealth;
  };

  test("the lane reaches the phone at all", () => {
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(getByTestId("mobile-bank")).toBeTruthy();
  });

  test("an overdue request is named on the phone, not only on the desk", () => {
    // The whole point. Doing nothing here costs money, and this is the screen
    // you are holding when you could still act.
    const health = laneOf({
      overdueRequestId: "0xb609f4d8…f57ecaac",
      requests: { text: "1 OVERDUE · 0xb609f4d8…f57ecaac leg2-dispatched for 8.7h", tone: "red" },
      tone: "red",
    });
    const { getByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    expect(getByTestId("mobile-bank").getAttribute("data-tone")).toBe("red");
    expect(getByTestId("mobile-bank-alarm").textContent).toContain("OVERDUE");
    expect(getByTestId("mobile-bank-requests").textContent).toContain("8.7h");
  });

  test("the subject warning rides ABOVE the numbers it qualifies", () => {
    // A reader who takes in the float and stops must not have read the wrong
    // wrapper generation — the defect this lane exists to detect.
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const lane = getByTestId("mobile-bank");
    const subject = getByTestId("mobile-bank-subject");
    expect(subject.textContent).toContain("cannot confirm which wrapper generation");
    const order = [...lane.querySelectorAll("[data-testid]")].map((el) => el.getAttribute("data-testid"));
    expect(order.indexOf("mobile-bank-subject")).toBeLessThan(order.indexOf("mobile-bank-requests"));
  });

  test("a healthy lane stays one quiet line — detail only when not ok", () => {
    // The rule the probe rollups already follow. Vertical space on a 500px
    // screen is spent on what is wrong.
    const health = laneOf({ tone: "ok", subject: { text: "reading v2.1", tone: "ok" } });
    const { queryByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    expect(queryByTestId("mobile-bank-rows")).toBeNull();
  });

  test("a lane that is NOT ok opens its rows", () => {
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    // The fixture lane is `degraded` — an undeclared subject.
    expect(getByTestId("mobile-bank-rows").textContent).toContain("UNVERIFIED");
  });

  test("an unverified position is warm grey, never coral", () => {
    // It means the instrument cannot vouch for itself, not that money is gone.
    // A false red here is what teaches an operator to ignore the real one.
    const { getByTestId } = render(
      <MobileBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const position = getByTestId("mobile-bank-rows").querySelector("dd");
    expect(position?.getAttribute("data-tone")).toBe("awaiting");
  });

  test("a lane nobody wired renders NOTHING — absent is not broken", () => {
    // A feed that was never configured must not occupy a phone screen to
    // announce its own absence.
    const health: ProductHealth = { ...OPS_FIXTURE_NOMINAL, bank: undefined };
    const { queryByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    expect(queryByTestId("mobile-bank")).toBeNull();
    expect(queryByTestId("mobile-bank-absent")).toBeNull();
  });

  test("a CONFIGURED feed that failed gets one line, and says why", () => {
    const health: ProductHealth = { ...OPS_FIXTURE_NOMINAL, bank: { unavailable: "hydration read timed out" } };
    const { getByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    expect(getByTestId("mobile-bank-absent").textContent).toContain("hydration read timed out");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// THE NEW LANES ON THE PHONE — DEPOSIT POOL AND ARRIVALS
//
// Same shape of regression as the bank lane above: the desk board grew two
// panels and the phone did not follow. The pool arrived as the DESKTOP tile
// rendered verbatim (its own `ops-deposit-pool-*` grid, six facts, inside a
// screen whose rule is that anything below the fold has to have earned it),
// and arrivals never reached the phone at all.
describe("phone board — deposit pool and arrivals lanes", () => {
  const withBlocks = (over: Partial<ProductHealth>): ProductHealth =>
    ({ ...OPS_FIXTURE_NOMINAL, ...over }) as ProductHealth;

  test("the pool is ONE line on the phone, not the desktop grid", () => {
    const health = withBlocks({
      depositPool: {
        snapshot: {
          schemaVersion: 1,
          available: true,
          totalAssets: { raw: "10000000", decimals: 6 },
          flows: { status: "ok", depositorCount: 0 },
          yieldStatus: "not_yet_earning",
        },
      },
    } as Partial<ProductHealth>);
    const { getByTestId, queryByTestId } = render(
      <MobileBoard health={health} nowMs={fresh(health)} />,
    );
    expect(getByTestId("mobile-pool").textContent).toBe(
      "POOL 10 USDC in · 0 depositors · not yet earning",
    );
    // The desktop tile's own fact grid must not be on this screen.
    expect(queryByTestId("ops-deposit-pool-share-price")).toBeNull();
    expect(queryByTestId("ops-deposit-pool-cap")).toBeNull();
  });

  test("arrivals reach the phone, with the two front doors kept apart", () => {
    const health = withBlocks({
      arrivals: {
        schemaVersion: "averray.arrivals.v1",
        funnelExternal: { reached: 9, browsed: 2, evaluated: 0, identified: 0, authenticated: 0, claimed: 0, submitted: 0 },
        funnelHttpExternal: { reached: 40, browsed: 20, evaluated: 8, identified: 3, authenticated: 3, claimed: 1, submitted: 1 },
      },
    } as Partial<ProductHealth>);
    const { getByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    expect(getByTestId("mobile-arrivals").textContent).toBe(
      "OUTSIDERS MCP → browsed · HTTP → submitted",
    );
  });

  test("a producer that never reported either block renders NOTHING", () => {
    // Absent is not zero, and a placeholder row would claim a measurement
    // nobody took — the same rule the bank lane follows.
    const health = withBlocks({ depositPool: undefined, arrivals: undefined });
    const { queryByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    expect(queryByTestId("mobile-pool")).toBeNull();
    expect(queryByTestId("mobile-arrivals")).toBeNull();
  });

  test("an unreadable pool is fenced grey, never the red kept for the money path", () => {
    const health = withBlocks({ depositPool: { unavailable: "no producer" } } as Partial<ProductHealth>);
    const { getByTestId } = render(<MobileBoard health={health} nowMs={fresh(health)} />);
    const lane = getByTestId("mobile-pool");
    expect(lane.getAttribute("data-tone")).toBe("awaiting");
    expect(lane.getAttribute("data-unreadable")).toBe("yes");
  });
});
