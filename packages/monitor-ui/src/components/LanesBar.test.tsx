// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LanesBar } from "./LanesBar.js";
import type { KPICounts } from "../lib/monitor/board-state.js";

afterEach(cleanup);

const counts: KPICounts = {
  action: 1,
  codex: 0,
  review: 2,
  checking: 3,
  queue: 1,
  deploying: 1,
  blocked: 0,
  done: 9,
  total: 8,
};

describe("LanesBar", () => {
  test("read-only search input (no handler) with the / hint", () => {
    const { container, getByText } = render(<LanesBar counts={counts} mode="calm" />);
    const input = container.querySelector(".hm-search input") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.readOnly).toBe(true); // no onSearchChange → read-only
    expect(getByText("/")).toBeTruthy();
  });

  test("an interactive search input reports changes", () => {
    const onSearchChange = vi.fn();
    const { container } = render(
      <LanesBar counts={counts} mode="calm" searchValue="" onSearchChange={onSearchChange} />,
    );
    const input = container.querySelector(".hm-search input") as HTMLInputElement;
    expect(input.readOnly).toBe(false);
    fireEvent.change(input, { target: { value: "xcm" } });
    expect(onSearchChange).toHaveBeenCalledWith("xcm");
  });

  test("tip text follows board mode", () => {
    const calm = render(<LanesBar counts={counts} mode="calm" />);
    expect(calm.getByText(/everything quiet · history below/)).toBeTruthy();

    const action = render(<LanesBar counts={counts} mode="action" />);
    expect(action.getByText(/focus on the lane that needs you/)).toBeTruthy();

    const degraded = render(<LanesBar counts={counts} mode="degraded" />);
    expect(degraded.getByText(/auto-reconnecting/)).toBeTruthy();
  });

  test("renders all six filter chips with the All chip active", () => {
    const { container } = render(<LanesBar counts={counts} mode="calm" />);
    const chips = container.querySelectorAll(".hm-filter-chip");
    expect(chips.length).toBe(6);
    expect((chips[0] as HTMLElement).className).toContain("is-active");
    expect(chips[0].textContent).toContain("All");
    // Filter chips carry their counts.
    expect(chips[0].querySelector(".ct")?.textContent).toBe("8"); // All = total
    expect(chips[5].textContent).toContain("Done");
    expect(chips[5].querySelector(".ct")?.textContent).toBe("9");
  });

  test("read-only fallback (no onFilterChange): chips are count-only, aria-disabled", () => {
    const { container } = render(<LanesBar counts={counts} mode="calm" />);
    const chip = container.querySelector(".hm-filter-chip") as HTMLElement;
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.tagName).toBe("SPAN");
  });

  test("interactive chips: clicking a chip calls onFilterChange with its filter key", () => {
    const onFilterChange = vi.fn();
    const { container } = render(
      <LanesBar counts={counts} mode="calm" activeFilter="all" onFilterChange={onFilterChange} />,
    );
    const chips = container.querySelectorAll(".hm-filter-chip");
    // Each chip is a real button (not aria-disabled) and reports its filter key.
    expect((chips[0] as HTMLElement).tagName).toBe("BUTTON");
    expect((chips[0] as HTMLElement).getAttribute("aria-disabled")).toBeNull();
    const keys = ["all", "blocked", "review", "ready", "running", "done"] as const;
    keys.forEach((key, i) => {
      fireEvent.click(chips[i] as HTMLElement);
      expect(onFilterChange).toHaveBeenLastCalledWith(key);
    });
  });

  test("interactive chips: the active chip reflects activeFilter (aria-pressed)", () => {
    const { container } = render(
      <LanesBar counts={counts} mode="calm" activeFilter="review" onFilterChange={vi.fn()} />,
    );
    const chips = Array.from(container.querySelectorAll(".hm-filter-chip")) as HTMLElement[];
    const review = chips.find((c) => c.textContent?.includes("Review"))!;
    expect(review.className).toContain("is-active");
    expect(review.getAttribute("aria-pressed")).toBe("true");
    // The All chip is no longer active.
    expect(chips[0].className).not.toContain("is-active");
  });

  test("shows the urgency-sort label", () => {
    const { getByText } = render(<LanesBar counts={counts} mode="calm" />);
    expect(getByText("sorted by next-action urgency")).toBeTruthy();
  });
});
