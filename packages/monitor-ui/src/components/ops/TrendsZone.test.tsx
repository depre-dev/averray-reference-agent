// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { TrendsZone } from "./TrendsZone.js";
import type { HealthHistory } from "../../lib/monitor/product-health.js";

afterEach(cleanup);

const base = (over: Partial<HealthHistory>): HealthHistory => ({
  uptimePct24h: 100,
  uptimeSeries: ["ok", "ok", "ok"],
  latencySeriesMs: [75, 75, 75],
  balanceSeries: [10, 10, 10],
  incidents: [],
  ...over,
});

describe("TrendsZone anomaly flags", () => {
  test("renders a leading-indicator flag when latency spikes off its baseline", () => {
    const history = base({ latencySeriesMs: [...Array(10).fill(75), 320] });
    const { getByTestId } = render(<TrendsZone history={history} />);
    const chip = getByTestId("ops-anomaly-latency");
    expect(chip.textContent).toMatch(/▲ \d+% vs baseline/);
    expect(chip.className).toContain("ops-anomaly--warn");
  });

  test("no flag on a steady series", () => {
    const history = base({ latencySeriesMs: [75, 76, 75, 74, 75, 76, 75, 74, 75, 76] });
    const { queryByTestId } = render(<TrendsZone history={history} />);
    expect(queryByTestId("ops-anomaly-latency")).toBeNull();
    expect(queryByTestId("ops-anomaly-balance")).toBeNull();
  });

  test("still renders the awaiting state (no crash) when there's no history", () => {
    const { getByTestId } = render(<TrendsZone history={undefined} />);
    expect(getByTestId("ops-trends-awaiting")).toBeTruthy();
  });
});
