// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { TopStrip } from "./TopStrip.js";
import type { KPICounts } from "../lib/monitor/board-state.js";

afterEach(cleanup);

const calmCounts: KPICounts = {
  action: 0,
  codex: 0,
  review: 0,
  checking: 0,
  queue: 0,
  deploying: 0,
  blocked: 0,
  done: 11,
  total: 0,
};

const busyCounts: KPICounts = {
  action: 2,
  codex: 2,
  review: 1,
  checking: 3,
  queue: 1,
  deploying: 1,
  blocked: 0,
  done: 4,
  total: 8,
};

// Delivery-era chrome removed: per-lane KPI counts, the deploy-health pill
// and the automation gauge. What remains is ops chrome — brand, live clock,
// refresh, chain ticker — plus the ops pillars that replaced the counts.
describe("TopStrip", () => {
  test("renders the brand mark and banner role", () => {
    const { getByText, getByRole } = render(<TopStrip counts={calmCounts} />);
    expect(getByText("Hermes")).toBeTruthy();
    expect(getByText("Handoff monitor · Averray")).toBeTruthy();
    expect(getByRole("banner")).toBeTruthy();
  });

        test("shows the live timestamp when provided, dash otherwise", () => {
    const withTime = render(<TopStrip counts={calmCounts} liveAt="14:32:08" />);
    expect(withTime.getByText(/Live · 14:32:08/)).toBeTruthy();

    const noTime = render(<TopStrip counts={calmCounts} />);
    expect(noTime.getByText(/Live · —/)).toBeTruthy();
  });

  test("refresh button is disabled without a handler", () => {
    const { getByRole } = render(<TopStrip counts={calmCounts} />);
    const disabledBtn = getByRole("button", { name: "Refresh board" }) as HTMLButtonElement;
    expect(disabledBtn.disabled).toBe(true);
  });

  test("refresh button is enabled and fires when given a handler", () => {
    const onRefresh = vi.fn();
    const { getByRole } = render(<TopStrip counts={calmCounts} onRefresh={onRefresh} />);
    const btn = getByRole("button", { name: "Refresh board" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

            test("renders the chain ticker beside the Live pill when chainTick is provided", () => {
    const t0 = 1_700_000_000_000;
    const { container } = render(
      <TopStrip
        counts={calmCounts}
        liveAt="14:32:08"
        chainTick={{
          chain: { height: 18_812_345, observedAtMs: t0, blockAgeSec: 3, lastAdvanceAtMs: t0, freshSeconds: 600 },
          probe: { name: "chain_height", status: "ok", detail: "block #18,812,345 · 3s old", sparkline: ["ok"] },
          now: () => t0,
        }}
      />,
    );
    const pill = container.querySelector(".hm-chain-pill");
    expect(pill?.textContent).toContain("#18,812,345");
    // Sits in the top-right cluster, beside the Live clock.
    expect(pill?.closest(".hm-top-right")?.textContent).toContain("Live · 14:32:08");
  });

  test("shows no chain chip at all when chainTick is absent (monitoring off)", () => {
    const { container } = render(<TopStrip counts={calmCounts} />);
    expect(container.querySelector(".hm-chain-pill")).toBeNull();
  });
});
