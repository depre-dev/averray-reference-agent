// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BoardView } from "./BoardView.js";
import { FIXTURE_CARDS } from "../lib/monitor/fixtures.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";

afterEach(cleanup);

const board: MonitorBoard = { cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" };
const emptyBoard: MonitorBoard = { cards: [], at: "2026-05-28T10:30:00Z" };

describe("BoardView — degraded top strip", () => {
  test("open stream → normal top strip (no degraded header)", () => {
    const { container } = render(<BoardView board={board} status="open" keyboard={false} />);
    expect(container.querySelector(".hm-top--degraded")).toBeNull();
    expect(container.querySelector(".hm-top")).toBeTruthy();
  });

  test("reconnecting / closed → degraded header replaces the normal strip", () => {
    const reconnecting = render(<BoardView board={board} status="reconnecting" keyboard={false} />);
    expect(reconnecting.container.querySelector(".hm-top--degraded")).toBeTruthy();
    expect(reconnecting.getByText("UNTRUSTED")).toBeTruthy();

    const closed = render(<BoardView board={board} status="closed" keyboard={false} />);
    expect(closed.container.querySelector(".hm-top--degraded")).toBeTruthy();
  });
});

describe("BoardView — action announcement (§14)", () => {
  test("announces the action 0→>0 edge in an assertive live region", () => {
    const { container, rerender } = render(<BoardView board={emptyBoard} status="open" keyboard={false} />);
    const live = container.querySelector(".hm-sr-only") as HTMLElement;
    expect(live.getAttribute("aria-live")).toBe("assertive");
    expect(live.textContent).toBe(""); // baseline — no announcement on first paint

    // Live data arrives with two action cards (#548, #542 → needs-attention).
    rerender(<BoardView board={board} status="open" keyboard={false} />);
    expect(container.querySelector(".hm-sr-only")?.textContent).toMatch(/need your review/);
  });
});
