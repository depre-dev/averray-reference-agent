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
  test("renders the grouped probe grid and the testnet badge", () => {
    const { getByTestId, getByText } = render(<OpsBoard health={OPS_FIXTURE_LIVE} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-probe-grid")).toBeTruthy();
    expect(getByTestId("ops-probe-product_api")).toBeTruthy();
    expect(getByTestId("ops-probe-money_path")).toBeTruthy();
    expect(getByText("testnet")).toBeTruthy();
  });

  test("money zones show honest awaiting-data, never fabricated numbers", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_LIVE} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-solvency-awaiting")).toBeTruthy();
    expect(getByTestId("ops-trends-awaiting")).toBeTruthy();
    // funnel exists but is veiled + shows dashes
    const funnel = getByTestId("ops-funnel");
    expect(funnel.className).toContain("is-awaiting");
    expect(within(getByTestId("ops-fstep-settled")).getByText("—")).toBeTruthy();
  });

  test("awaiting probes read as awaiting tone, not amber degraded", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_LIVE} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-probe-treasury_liquidity").className).toContain("ops-probe--awaiting");
    expect(getByTestId("ops-probe-chain_height").className).toContain("ops-probe--degraded");
  });

  test("soft banner raises the real degradation (chain), not the awaiting probes", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_LIVE} nowMs={FIXTURE_NOW} />);
    const banner = getByTestId("ops-banner");
    expect(banner.className).toContain("ops-banner--degraded");
    expect(banner.textContent).toContain("Chain height");
    expect(banner.textContent).toContain("not paging");
  });

  test("banner is dismissible", () => {
    const { getByTestId, queryByTestId } = render(<OpsBoard health={OPS_FIXTURE_LIVE} nowMs={FIXTURE_NOW} />);
    fireEvent.click(within(getByTestId("ops-banner")).getByLabelText("Dismiss banner"));
    expect(queryByTestId("ops-banner")).toBeNull();
  });
});

describe("OpsBoard — populated fixture", () => {
  test("solvency, funnel, trends, incidents, and deploy all render real data", () => {
    const { getByTestId, getByText } = render(<OpsBoard health={OPS_FIXTURE_POPULATED} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-pool-signer_usdc")).toBeTruthy();
    expect(getByTestId("ops-runway")).toBeTruthy();
    expect(within(getByTestId("ops-fstep-settled")).getByText("37")).toBeTruthy();
    expect(getByTestId("ops-zone-trends")).toBeTruthy();
    expect(getByTestId("ops-incidents")).toBeTruthy();
    // deploy reflects that structured blocks are now live
    expect(getByText("structured blocks live")).toBeTruthy();
  });

  test("the ongoing chain incident shows an ongoing duration", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_POPULATED} nowMs={FIXTURE_NOW} />);
    expect(getByTestId("ops-incidents").textContent).toContain("ongoing");
  });
});

describe("OpsBoard — mainnet red fixture", () => {
  test("coral banner pages on mainnet and names the red probe", () => {
    const { getByTestId } = render(<OpsBoard health={OPS_FIXTURE_RED} nowMs={FIXTURE_NOW} />);
    const banner = getByTestId("ops-banner");
    expect(banner.className).toContain("ops-banner--red");
    expect(banner.textContent).toContain("Money path");
    expect(banner.textContent).toContain("paged");
  });

  test("shows the mainnet badge", () => {
    const { getByText } = render(<OpsBoard health={OPS_FIXTURE_RED} nowMs={FIXTURE_NOW} />);
    expect(getByText("mainnet")).toBeTruthy();
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
