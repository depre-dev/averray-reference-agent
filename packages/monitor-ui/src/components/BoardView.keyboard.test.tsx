// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { BoardView } from "./BoardView.js";
import { FIXTURE_CARDS } from "../lib/monitor/fixtures.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";

afterEach(cleanup);

const board: MonitorBoard = { cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" };

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("BoardView — keyboard (§12)", () => {
  test("? toggles the keyboard overlay", () => {
    const { queryByRole } = render(<BoardView board={board} status="open" />);
    expect(queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    press("?");
    expect(queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    press("?");
    expect(queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  test("j focuses a card; Enter opens its drawer", () => {
    const onCardClick = vi.fn();
    const { container } = render(<BoardView board={board} status="open" onCardClick={onCardClick} />);
    expect(container.querySelector(".hm-card.is-focused")).toBeNull();
    press("j");
    expect(container.querySelector(".hm-card.is-focused")).toBeTruthy();
    press("Enter");
    expect(onCardClick).toHaveBeenCalledTimes(1);
  });

  test("/ focuses the search input", () => {
    const { container } = render(<BoardView board={board} status="open" />);
    press("/");
    expect(document.activeElement).toBe(container.querySelector(".hm-search input"));
  });

  test("typing in search filters the board", () => {
    const { container } = render(<BoardView board={board} status="open" />);
    const view = within(container);
    const input = container.querySelector(".hm-search input") as HTMLInputElement;
    expect(view.getByText("Verify onboarding flow on staging.averray.com")).toBeTruthy();

    fireEvent.change(input, { target: { value: "onboarding" } });
    expect(view.getByText("Verify onboarding flow on staging.averray.com")).toBeTruthy();
    expect(view.queryByText("Docs: add receipt drawer screenshots + glossary for cosigner")).toBeNull();
  });

  test("o opens the focused card's PR on GitHub", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      render(<BoardView board={board} status="open" />);
      press("j"); // focus the first card (a needs-attention PR)
      press("o");
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(String(openSpy.mock.calls[0]?.[0])).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+$/);
    } finally {
      openSpy.mockRestore();
    }
  });
});
