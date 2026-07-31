// @vitest-environment jsdom
//
// OPS-ONLY (docs/OPS_ONLY_PIVOT.md): the card-traversal shortcuts (j/k focus,
// Enter-to-open, / to filter the card search) went with the kanban board. What
// survives is the shortcut surface itself — the overlay that tells the operator
// what they can press. It is not a delivery affordance.
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { BoardView } from "./BoardView.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";

afterEach(cleanup);

const board: MonitorBoard = { cards: [], at: "2026-05-28T10:30:00Z" };

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("BoardView — keyboard", () => {
  test("? toggles the keyboard overlay", () => {
    const { queryByRole } = render(<BoardView board={board} status="open" />);
    expect(queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    press("?");
    expect(queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    press("?");
    expect(queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });
});
