// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Lane, type LaneDescriptor } from "./Lane.js";

afterEach(cleanup);

const lane: LaneDescriptor = { id: "operator-review", name: "Operator review", action: "Risk decision" };

describe("Lane", () => {
  test("collapsed lane delegates to MiniRail (a button)", () => {
    const { container, getByRole } = render(<Lane lane={lane} expanded={false} count={2} />);
    expect(container.querySelector("section")).toBeNull();
    expect(getByRole("button", { name: /Operator review/ })).toBeTruthy();
    expect(container.querySelector(".hm-lane--collapsed")).toBeTruthy();
  });

  test("expanded empty lane shows the empty placeholder", () => {
    const { container, getByText } = render(<Lane lane={lane} expanded count={0} />);
    expect(container.querySelector("section.hm-lane")).toBeTruthy();
    expect(getByText("No operator review right now.")).toBeTruthy();
    // Empty lane is not the --expanded variant.
    expect((container.querySelector(".hm-lane") as HTMLElement).className).not.toContain("hm-lane--expanded");
  });

  test("expanded populated lane renders children and the --expanded variant", () => {
    const { container, getByText, queryByText } = render(
      <Lane lane={lane} expanded count={2}>
        <div>card-one</div>
        <div>card-two</div>
      </Lane>,
    );
    expect((container.querySelector(".hm-lane") as HTMLElement).className).toContain("hm-lane--expanded");
    expect(getByText("card-one")).toBeTruthy();
    expect(getByText("card-two")).toBeTruthy();
    expect(queryByText(/right now\./)).toBeNull();
  });

  test("expanded header shows title, count, and action eyebrow", () => {
    const { getByText } = render(<Lane lane={lane} expanded count={2} />);
    expect(getByText("Operator review")).toBeTruthy();
    expect(getByText("2")).toBeTruthy();
    expect(getByText("Risk decision")).toBeTruthy();
  });

  test("collapse button fires onToggle in expanded mode", () => {
    const onToggle = vi.fn();
    const { getByRole } = render(<Lane lane={lane} expanded count={1} onToggle={onToggle} />);
    fireEvent.click(getByRole("button", { name: /Collapse Operator review lane/ }));
    expect(onToggle).toHaveBeenCalledWith("operator-review");
  });

  test("omits the collapse button when no onToggle is given", () => {
    const { queryByRole } = render(<Lane lane={lane} expanded count={1} />);
    expect(queryByRole("button", { name: /Collapse/ })).toBeNull();
  });
});
