// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { TopStripDegraded } from "./TopStripDegraded.js";

afterEach(cleanup);

describe("TopStripDegraded (§16)", () => {
  test("shows `?` KPIs — never a stale cached number — plus the last-known time", () => {
    const { container, getByText } = render(
      <TopStripDegraded lastKnownAt="14:32:08" reason="Live SSE reconnecting · auto-reconnecting" />,
    );
    expect(container.querySelector(".hm-top--degraded")).toBeTruthy();
    expect(getByText("Hermes — degraded mode")).toBeTruthy();
    // Both KPI pips read "?" and none read "0".
    const pips = Array.from(container.querySelectorAll(".hm-kpi .n")).map((n) => n.textContent);
    expect(pips.length).toBeGreaterThan(0);
    expect(pips.every((p) => p === "?")).toBe(true);
    expect(getByText(/last known · 14:32:08/)).toBeTruthy();
  });

  test("spells out the reason in an alert banner", () => {
    const { getByText, getByRole } = render(
      <TopStripDegraded reason="Live SSE closed · last good read 14:32:08 · auto-reconnecting" />,
    );
    expect(getByText("UNTRUSTED")).toBeTruthy();
    const alert = getByRole("alert");
    expect(within(alert).getByText(/last good read 14:32:08/)).toBeTruthy();
  });

  test("the reconnect controls fire onReconnect", () => {
    const onReconnect = vi.fn();
    const { getByRole, getByText } = render(<TopStripDegraded reason="x" onReconnect={onReconnect} />);
    fireEvent.click(getByRole("button", { name: "Reconnect" }));
    fireEvent.click(getByText("Reconnect now"));
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  test("without a handler the reconnect button is disabled", () => {
    const { getByRole } = render(<TopStripDegraded reason="x" />);
    expect((getByRole("button", { name: "Reconnect" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
