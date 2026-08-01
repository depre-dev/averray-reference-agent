// @vitest-environment jsdom
//
// What the ops board must render, and what it must refuse to render.
//
// The pure decisions are covered in ops-spec.test.ts; these assert that the
// decisions actually reach the screen — that a "no meter" decision produces no
// bar element, that a shortfall and an unverified read do not look alike, and
// that a clean funnel next to contradicting proof shows BOTH numbers.
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, within } from "@testing-library/react";

import { OpsBoard } from "./OpsBoard.js";
import {
  OPS_FIXTURE_LIVE,
  OPS_FIXTURE_NOMINAL,
  OPS_FIXTURE_STRESS,
  OPS_FIXTURE_UNVERIFIED,
  FIXTURE_NOW,
} from "../../lib/monitor/ops-fixtures.js";

afterEach(cleanup);

/** Render at the fixture's own check time so nothing reads as stale. */
const fresh = (health: typeof OPS_FIXTURE_NOMINAL) => (health.at ?? FIXTURE_NOW) + 2_000;

describe("OpsBoard — the honest empty states", () => {
  test("monitoring off says so instead of showing a green board", () => {
    const { getByTestId } = render(
      <OpsBoard
        health={{ enabled: false, at: null, status: "unknown", checks: 0, probes: [] }}
        nowMs={FIXTURE_NOW}
      />,
    );
    expect(getByTestId("ops-verdict").textContent).toBe("NOT WATCHING");
  });

  test("awaiting the first check is NO DATA YET, not nominal", () => {
    const { getByTestId } = render(
      <OpsBoard
        health={{ enabled: true, at: null, status: "unknown", checks: 0, probes: [] }}
        nowMs={FIXTURE_NOW}
      />,
    );
    expect(getByTestId("ops-verdict").textContent).toBe("NO DATA YET");
  });

  test("without structured blocks the money panels await data, never fabricate it", () => {
    const { getByTestId, container } = render(
      <OpsBoard health={OPS_FIXTURE_LIVE} nowMs={fresh(OPS_FIXTURE_LIVE)} />,
    );
    expect(getByTestId("ops-solvency-awaiting")).toBeTruthy();
    // No pools at all → no meters at all.
    expect(container.querySelectorAll(".ops-meter")).toHaveLength(0);
    // Funnel counts read "—", not "0".
    const flow = getByTestId("ops-flow");
    expect(within(flow).getAllByText("—").length).toBeGreaterThan(0);
    expect(within(flow).queryByText("0")).toBeNull();
  });
});

describe("OpsBoard — solvency meters", () => {
  test("only floored pools draw a bar", () => {
    const { container } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    // 3 floored pools (gas, reward bank, AAC) → exactly 3 meters, and the
    // reserve / escrow / revenue rows get none.
    expect(container.querySelectorAll(".ops-meter")).toHaveLength(3);
  });

  // THE SHIPPED BUG, pinned: the treasury reserve is intentionally at 0.00 with
  // no floor. It once rendered as a FULL bar and read "healthy and full".
  test("the intentionally-empty reserve gets no meter and keeps its reason", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const reserve = getByTestId("ops-pool-reserve");
    expect(reserve.querySelector(".ops-meter")).toBeNull();
    expect(reserve.textContent).toContain("intentionally unfunded");
  });

  test("a breached floor is coral and states the absolute shortfall", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_STRESS} nowMs={FIXTURE_NOW} />);
    const bank = getByTestId("ops-pool-reward_bank");
    expect(bank.getAttribute("data-tone")).toBe("red");
    expect(bank.textContent).toContain("BELOW FLOOR · short 0.58");
  });
});

describe("OpsBoard — payout evidence", () => {
  test("confirmed shows both sources so the operator can check the match", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const evidence = getByTestId("ops-evidence");
    expect(getByTestId("ops-evidence-status").textContent).toBe("CONFIRMED");
    expect(evidence.textContent).toContain("14 payouts confirmed on-chain");
    expect(evidence.textContent).toContain("14 marked settled");
    expect(evidence.getAttribute("data-emphasis")).toBe("off");
  });

  // THE POINT OF THE ROW: the funnel still reads a clean 9 → 9 → 9 while the
  // chain can only account for 12 of 14. The board must show the contradiction,
  // not average it away.
  test("a clean funnel beside a shortfall shows BOTH numbers and names the gap", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_STRESS} nowMs={FIXTURE_NOW} />);
    const flow = getByTestId("ops-flow");
    expect(within(flow).getAllByText("9").length).toBe(3); // claimed / submitted / settled
    expect(getByTestId("ops-evidence-status").textContent).toBe("SHORTFALL −2");
    expect(getByTestId("ops-evidence").textContent).toContain(
      "2 settled jobs have no on-chain proof",
    );
    expect(flow.textContent).toContain("evidence below disagrees");
  });

  // "We cannot see" must never look like "we can see, and money is missing".
  test("unverified does NOT look like shortfall", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_UNVERIFIED} nowMs={fresh(OPS_FIXTURE_UNVERIFIED)} />,
    );
    const status = getByTestId("ops-evidence-status");
    expect(status.textContent).toBe("UNVERIFIED");
    expect(status.getAttribute("data-tone")).toBe("awaiting");
    expect(getByTestId("ops-evidence").getAttribute("data-emphasis")).toBe("off");
    expect(getByTestId("ops-evidence").textContent).not.toMatch(/money did not move/i);
  });

  test("the confirmed / shortfall / unverified key is permanently on screen", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const evidence = getByTestId("ops-evidence").textContent ?? "";
    expect(evidence).toContain("instrument broken, not money");
    expect(evidence).toContain("proof missing: money broken");
  });
});

describe("OpsBoard — pillars and footer", () => {
  test("every probe reaches the pillar strip with its detail", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const pillars = getByTestId("ops-pillars").textContent ?? "";
    for (const probe of OPS_FIXTURE_NOMINAL.probes) {
      expect(pillars).toContain(probe.name);
      expect(pillars).toContain(probe.detail);
    }
  });

  test("an awaiting probe is counted as awaiting, not folded into degraded", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_LIVE} nowMs={fresh(OPS_FIXTURE_LIVE)} />,
    );
    expect(getByTestId("ops-pillars").textContent).toContain("awaiting");
  });

  // A line through two points is a fabricated trend.
  test("the latency trend refuses to draw without enough history", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_LIVE} nowMs={fresh(OPS_FIXTURE_LIVE)} />,
    );
    expect(getByTestId("ops-trend-awaiting").textContent).toContain("awaiting history");
  });

  test("an empty incident log says 'none recorded', not 'all clear'", () => {
    const { container } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    expect(container.querySelector(".ops-foot")?.textContent).toContain("none recorded");
  });

  // Demoted from the tallest column on the board to one footer line.
  test("LLM spend is a single footer line, and admits what it excludes", () => {
    const { container } = render(
      <OpsBoard
        health={OPS_FIXTURE_NOMINAL}
        nowMs={fresh(OPS_FIXTURE_NOMINAL)}
        board={{
          cards: [],
          at: "2026-07-31T09:41:05Z",
          llmUsage: {
            status: "recorded",
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 20,
            costStatus: "recorded",
            runs: 3,
            byModel: [],
            byDay: [],
            billing: {
              metered: { models: [], monthCostUsd: 20, costStatus: "recorded" },
              subscriptions: [
                { provider: "ollama", label: "shared A", plan: "flat", planLabel: "Flat", monthlyUsd: null, configured: true, active: true, dedicated: false, unit: "tokens", models: [], windows: {} },
                { provider: "codex", label: "shared B", plan: "flat", planLabel: "Flat", monthlyUsd: null, configured: true, active: true, dedicated: false, unit: "runs", models: [], windows: {} },
              ],
              monthlyTotalUsd: 20,
              monthlyTotalComplete: false,
            },
          },
        } as never}
      />,
    );
    const foot = container.querySelector(".ops-foot")?.textContent ?? "";
    expect(foot).toContain("LLM SPEND ≈ $20.00 this month");
    expect(foot).toContain("2 shared plans excluded from total");
  });

  test("no usage data says so instead of showing $0.00", () => {
    const { container } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={fresh(OPS_FIXTURE_NOMINAL)} />,
    );
    const foot = container.querySelector(".ops-foot")?.textContent ?? "";
    expect(foot).toContain("LLM SPEND — not recorded");
    expect(foot).not.toContain("$0.00");
  });
});
