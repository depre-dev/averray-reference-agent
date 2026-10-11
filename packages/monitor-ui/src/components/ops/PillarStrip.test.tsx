// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import type { ProductHealthProbe } from "../../lib/monitor/product-health.js";
import { PillarStrip } from "./PillarStrip.js";

afterEach(cleanup);

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const RAW_ID = "quanta#179:0x08e1abcd1234567890abcdefb77E";
const DETAIL = `overdueReview 2 (session ids ${RAW_ID}) · backlog 16`;

const probes: ProductHealthProbe[] = [
  {
    name: "money_path",
    status: "degraded",
    detail: DETAIL,
    sparkline: ["degraded"],
  },
];

function closed(id: string, probe: string, severity: "degraded" | "red" = "degraded", peak?: "red") {
  return {
    id,
    probe,
    severity,
    ...(peak ? { peakSeverity: peak } : {}),
    startedAt: NOW - 60 * 60_000,
    endedAt: NOW - 30 * 60_000,
  };
}

describe("PillarStrip incidents and probe ids", () => {
  test("the money_path detail shortens the session id and keeps the raw value on the title", () => {
    const { getByText } = render(<PillarStrip probes={probes} history={{ incidents: [] }} nowMs={NOW} />);
    const detail = getByText(/overdueReview 2/);
    expect(detail.textContent).toContain("quanta#179 · 0x08e1…b77E");
    expect(detail.textContent).not.toContain(RAW_ID);
    expect(detail.textContent).toContain("backlog 16");
    expect(detail.getAttribute("title")).toBe(DETAIL);
  });

  test("renders every group and every closed episode, ongoing first, with the true count", () => {
    const probesClosed = ["p0", "p1", "p2", "p3", "p4", "p5", "money_path"];
    const incidents = [
      { id: "open-cap", probe: "capabilities", severity: "degraded" as const, startedAt: NOW - 10 * 60_000, endedAt: null },
      ...probesClosed.map((probe, index) => closed(`g-${probe}`, probe, index === 0 ? "red" : "degraded")),
      ...Array.from({ length: 94 }, (_, index) => closed(`extra-${index}`, "api_latency")),
      closed("eased", "receipt_signature", "degraded", "red"),
    ];
    const closedRows = incidents.filter((row) => row.endedAt != null);
    const closedCount = closedRows.length;
    const groupCount = new Set(closedRows.map((row) => row.probe)).size;
    const { getByTestId } = render(
      <PillarStrip probes={probes} history={{ incidents }} nowMs={NOW} />,
    );
    const column = getByTestId("ops-incidents");
    const primary = column.querySelector(".ops-incident-rows")!;
    const order = [...primary.querySelectorAll(":scope > .ops-incident")].map((row) => row.getAttribute("data-ongoing"));
    expect(order[0]).toBe("yes");
    expect(order.filter((flag) => flag === "no").length).toBe(groupCount);
    expect(getByTestId("ops-incident-group-p0").getAttribute("data-tone")).toBe("red");
    expect(getByTestId("ops-incident-group-receipt_signature").textContent).toContain("peaked red");
    expect(getByTestId("ops-incidents-more").textContent).toBe(`${incidents.length} episodes in the window`);
    const disclosure = getByTestId("ops-incidents-all");
    expect(disclosure.querySelector("summary")?.textContent).toBe(`all ${closedCount} closed episodes`);
    expect(disclosure.querySelectorAll(".ops-incident")).toHaveLength(closedCount);
    expect(getByTestId("ops-incident-eased").textContent).toContain("peaked red");
  });
});
