// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { OpsBoard } from "./OpsBoard.js";
import { BoardSurfaceSwitch } from "./BoardSurfaceSwitch.js";
import {
  OPS_FIXTURE_LIVE,
  OPS_FIXTURE_POPULATED,
  OPS_FIXTURE_RED,
  FIXTURE_NOW,
} from "../../lib/monitor/ops-fixtures.js";

afterEach(cleanup);

describe("OpsBoard — empty states", () => {
  test("monitoring off", () => {
    const { getByText, queryByTestId } = render(
      <OpsBoard health={{ enabled: false, at: null, status: "unknown", checks: 0, probes: [] }} nowMs={FIXTURE_NOW} />,
    );
    expect(getByText("Monitoring is off")).toBeTruthy();
    expect(queryByTestId("ops-probe-grid")).toBeNull();
  });

  test("awaiting first check", () => {
    const { getByText } = render(
      <OpsBoard health={{ enabled: true, at: null, status: "unknown", checks: 0, probes: [] }} nowMs={FIXTURE_NOW} />,
    );
    expect(getByText("Awaiting first check")).toBeTruthy();
  });
});

describe("OpsBoard — live (today) fixture", () => {
  test("renders the grouped probe grid", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_LIVE} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-probe-grid")).toBeTruthy();
    expect(getByTestId("ops-probe-product_api")).toBeTruthy();
    expect(getByTestId("ops-probe-money_path")).toBeTruthy();
  });

  test("money zones show honest awaiting-data, never fabricated numbers", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_LIVE} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-solvency-awaiting")).toBeTruthy();
    expect(getByTestId("ops-trends-awaiting")).toBeTruthy();
    const funnel = getByTestId("ops-funnel");
    expect(funnel.className).toContain("is-awaiting");
    expect(within(getByTestId("ops-fstep-claimed")).getByText("—")).toBeTruthy();
    expect(within(getByTestId("ops-fstep-submitted")).getByText("—")).toBeTruthy();
    expect(within(getByTestId("ops-fstep-settled")).getByText("—")).toBeTruthy();
    expect(within(getByTestId("ops-flow-gauge-claimedNotSubmitted")).getByText("—")).toBeTruthy();
    expect(within(getByTestId("ops-flow-gauge-submittedNotSettled")).getByText("—")).toBeTruthy();
  });

  test("awaiting probes read as awaiting tone, not amber degraded", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_LIVE} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-probe-treasury_liquidity").className).toContain("ops-probe--awaiting");
    expect(getByTestId("ops-probe-chain_height").className).toContain("ops-probe--degraded");
  });
});

describe("OpsBoard — populated fixture", () => {
  test("solvency, funnel, trends, incidents, and deploy all render real data", () => {
    const { getByTestId, getByText } = render(<OpsBoard health={OPS_FIXTURE_POPULATED} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-pool-reward_bank")).toBeTruthy();
    expect(getByTestId("ops-runway")).toBeTruthy();
    expect(within(getByTestId("ops-fstep-claimed")).getByText("41")).toBeTruthy();
    expect(within(getByTestId("ops-fstep-submitted")).getByText("39")).toBeTruthy();
    expect(within(getByTestId("ops-fstep-settled")).getByText("37")).toBeTruthy();
    expect(within(getByTestId("ops-flow-gauge-claimedNotSubmitted")).getByText("2")).toBeTruthy();
    expect(within(getByTestId("ops-flow-gauge-submittedNotSettled")).getByText("1")).toBeTruthy();
    expect(getByTestId("ops-zone-trends")).toBeTruthy();
    expect(getByTestId("ops-incidents")).toBeTruthy();
    expect(getByText("structured blocks live")).toBeTruthy();
  });

  test("the ongoing chain incident shows an ongoing duration", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_POPULATED} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-incidents").textContent).toContain("ongoing");
  });

  test("shows the declared reason for an intentionally unfunded reserve", () => {
    const health = {
      ...OPS_FIXTURE_POPULATED,
      solvency: {
        ...OPS_FIXTURE_POPULATED.solvency!,
        pools: OPS_FIXTURE_POPULATED.solvency!.pools.map((pool) =>
          pool.key === "reserve"
            ? {
                ...pool,
                amount: 0,
                floor: null,
                note: "Intentionally unfunded: pre-revenue reserve",
              }
            : pool,
        ),
      },
    };
    const { getByTestId } = render(<OpsBoard health={health} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-pool-reserve").textContent).toContain(
      "Intentionally unfunded: pre-revenue reserve",
    );
  });
});

describe("OpsBoard — mainnet fixture", () => {
  test("renders native signer gas as DOT", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_RED} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-pool-signer_gas").textContent).toContain("DOT");
    expect(getByTestId("ops-pool-signer_gas").textContent).not.toContain("PAS");
  });
});

describe("BoardSurfaceSwitch", () => {
  test("renders both tabs and reports the selection", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <BoardSurfaceSwitch surface="delivery" onChange={onChange} health={OPS_FIXTURE_LIVE} />,
    );
    const opsTab = getByRole("tab", { name: /Ops/ });
    expect(opsTab.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(opsTab);
    expect(onChange).toHaveBeenCalledWith("ops");
  });
});
