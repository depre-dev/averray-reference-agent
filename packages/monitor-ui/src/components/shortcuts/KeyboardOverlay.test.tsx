// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { KeyboardOverlay } from "./KeyboardOverlay.js";

afterEach(cleanup);

describe("KeyboardOverlay", () => {
  test("is a labelled modal dialog grouped by scope, with wired + 'soon' bindings", () => {
    const { getByRole } = render(<KeyboardOverlay onClose={() => {}} />);
    const dialog = getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const view = within(dialog);
    expect(view.getByText("Anywhere")).toBeTruthy();
    expect(view.getByText("On the board")).toBeTruthy();
    expect(view.getByText("next card")).toBeTruthy();
    // a still-deferred binding is tagged so the sheet doesn't over-promise
    expect(view.getByText(/approve · soon/)).toBeTruthy();
  });

  test("the close button calls onClose", () => {
    const onClose = vi.fn();
    const { getByRole } = render(<KeyboardOverlay onClose={onClose} />);
    fireEvent.click(getByRole("button", { name: "Close keyboard shortcuts" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
