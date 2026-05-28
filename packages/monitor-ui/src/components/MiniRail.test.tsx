// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { MiniRail, type LaneDescriptor } from "./MiniRail.js";

afterEach(cleanup);

const lane: LaneDescriptor = { id: "release-queue", name: "Release queue", action: "Branch protection" };
const actionLane: LaneDescriptor = { id: "needs-attention", name: "Needs attention", isAction: true };

describe("MiniRail", () => {
  test("renders the count and lane name as a collapsed rail", () => {
    const { container, getByText } = render(<MiniRail lane={lane} count={3} />);
    const root = container.querySelector(".hm-lane--collapsed");
    expect(root).toBeTruthy();
    expect(getByText("3")).toBeTruthy();
    expect(getByText("Release queue")).toBeTruthy();
  });

  test("zero count wears ct--zero, non-zero wears ct--has", () => {
    const zero = render(<MiniRail lane={lane} count={0} />);
    expect((zero.container.querySelector(".ct") as HTMLElement).className).toContain("ct--zero");

    const some = render(<MiniRail lane={lane} count={5} />);
    expect((some.container.querySelector(".ct") as HTMLElement).className).toContain("ct--has");
  });

  test("action lane wears the amber action modifier", () => {
    const { container } = render(<MiniRail lane={actionLane} count={1} />);
    expect((container.querySelector(".hm-lane") as HTMLElement).className).toContain("hm-lane--action");
  });

  test("clicking the rail expands the lane via onToggle", () => {
    const onToggle = vi.fn();
    const { getByRole } = render(<MiniRail lane={lane} count={2} onToggle={onToggle} />);
    fireEvent.click(getByRole("button"));
    expect(onToggle).toHaveBeenCalledWith("release-queue");
  });

  test("aria-label pluralizes the card count", () => {
    const one = render(<MiniRail lane={lane} count={1} />);
    expect(within(one.container).getByRole("button").getAttribute("aria-label")).toContain("(1 card)");

    const many = render(<MiniRail lane={lane} count={4} />);
    expect(within(many.container).getByRole("button").getAttribute("aria-label")).toContain("(4 cards)");
  });
});
