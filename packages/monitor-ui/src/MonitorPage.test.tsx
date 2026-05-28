// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { MonitorPage } from "./MonitorPage.js";

afterEach(cleanup);

describe("MonitorPage — calm / A5 state", () => {
  test("renders the full board chrome end-to-end", () => {
    const { container } = render(<MonitorPage />);
    const view = within(container);

    // Top strip
    expect(view.getByRole("banner")).toBeTruthy();
    expect(view.getByText("Hermes")).toBeTruthy();

    // Board Now banner — calm tone
    expect(container.querySelector(".hm-now--calm")).toBeTruthy();
    expect(view.getByText(/Nothing waits on you/)).toBeTruthy();

    // Lanes bar
    expect(view.getByText("sorted by next-action urgency")).toBeTruthy();

    // Board grid with all eight lanes
    expect(view.getByRole("region", { name: "Lane grid" })).toBeTruthy();
    expect(container.querySelectorAll(".hm-lane").length).toBe(8);

    // Hermes co-pilot rail chrome (full rail lands in M8')
    expect(view.getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy();
  });

  test("only the Done lane is expanded; the seven live lanes are mini-rails", () => {
    const { container } = render(<MonitorPage />);
    expect(within(container).getByRole("region", { name: "Done lane" })).toBeTruthy();
    expect(container.querySelectorAll(".hm-lane--collapsed").length).toBe(7);
  });

  test("KPI pills read zero for every live lane in the calm state", () => {
    const { container } = render(<MonitorPage />);
    // "Operator review" is both a KPI label and a lane name, so scope the
    // assertion to the banner (TopStrip) KPI region.
    const banner = within(container).getByRole("banner");
    expect(within(banner).getByText("Action needed")).toBeTruthy();
    expect(within(banner).getByText("Operator review")).toBeTruthy();
  });

  test("the Done lane reflects the release-history fixture count", () => {
    const { container } = render(<MonitorPage />);
    // 11 done-history fixtures → the calm banner reports them shipped.
    expect(within(container).getByText(/11 card\(s\) shipped today/)).toBeTruthy();
  });
});
