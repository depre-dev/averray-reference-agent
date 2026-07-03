// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

import { MonitoringSurface } from "./MonitoringSurface.js";
import { MonitoringLaneToggle } from "./MonitoringLaneToggle.js";
import { ProbeSparkline } from "./ProbeSparkline.js";
import type { ProductHealth } from "../../lib/monitor/product-health.js";

afterEach(cleanup);

const health = (over: Partial<ProductHealth> = {}): ProductHealth => ({
  enabled: true,
  at: 1,
  status: "red",
  checks: 30,
  probes: [
    { name: "product_api", status: "ok", detail: "api → 200", sparkline: ["ok", "ok"] },
    { name: "chain_height", status: "degraded", detail: "RPC not set", sparkline: ["degraded"] },
    { name: "signer_liquidity", status: "red", detail: "gas 0.04 < 0.1", sparkline: ["ok", "red"] },
  ],
  ...over,
});

describe("MonitoringSurface", () => {
  it("renders a card per probe, the detail, and the overall headline", () => {
    render(<MonitoringSurface health={health()} />);
    expect(screen.getByText("Product API")).toBeTruthy();
    expect(screen.getByText("gas 0.04 < 0.1")).toBeTruthy();
    expect(screen.getByText("1 probe red")).toBeTruthy();
    expect(screen.getByTestId("probe-signer_liquidity").className).toContain("hm-probe--fail");
  });

  it("shows the honest 'monitoring off' state, not a green", () => {
    render(<MonitoringSurface health={health({ enabled: false })} />);
    expect(screen.getByTestId("product-health-off")).toBeTruthy();
    expect(screen.queryByTestId("probe-product_api")).toBeNull();
  });

  it("shows 'awaiting first check' when enabled but no data yet", () => {
    render(<MonitoringSurface health={health({ enabled: true, checks: 0 })} />);
    expect(screen.getByTestId("product-health-idle")).toBeTruthy();
  });
});

describe("MonitoringLaneToggle", () => {
  it("fires onChange when a tab is clicked", () => {
    const onChange = vi.fn();
    render(<MonitoringLaneToggle mode="delivery" onChange={onChange} health={health()} />);
    fireEvent.click(screen.getByText("Monitoring"));
    expect(onChange).toHaveBeenCalledWith("monitoring");
  });
});

describe("ProbeSparkline", () => {
  it("pads to a fixed cell count and colours each cell by status", () => {
    const { container } = render(<ProbeSparkline series={["ok", "red"]} bins={5} />);
    expect(container.querySelectorAll(".hm-spark-cell").length).toBe(5);
    expect(container.querySelectorAll(".hm-spark-cell--empty").length).toBe(3);
    expect(container.querySelectorAll(".hm-spark-cell--fail").length).toBe(1);
    expect(container.querySelectorAll(".hm-spark-cell--pass").length).toBe(1);
  });
});
