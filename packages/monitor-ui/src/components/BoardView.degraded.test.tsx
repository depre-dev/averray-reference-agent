// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BoardView } from "./BoardView.js";
import { FIXTURE_CARDS } from "../lib/monitor/fixtures.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";

afterEach(cleanup);

const board: MonitorBoard = { cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" };
const emptyBoard: MonitorBoard = { cards: [], at: "2026-05-28T10:30:00Z" };

// The two surviving tests are the stream-honesty guarantee, not delivery:
// a degraded stream must replace the normal strip. The action-count live
// region went with the cards it counted (docs/OPS_ONLY_PIVOT.md).
describe("BoardView — degraded top strip", () => {
  test("open stream → normal top strip (no degraded header)", () => {
    const { container } = render(<BoardView board={board} status="open" />);
    expect(container.querySelector(".hm-top--degraded")).toBeNull();
    expect(container.querySelector(".hm-top")).toBeTruthy();
  });

  test("reconnecting / closed → degraded header replaces the normal strip", () => {
    const reconnecting = render(<BoardView board={board} status="reconnecting" />);
    expect(reconnecting.container.querySelector(".hm-top--degraded")).toBeTruthy();
    expect(reconnecting.getByText("UNTRUSTED")).toBeTruthy();

    const closed = render(<BoardView board={board} status="closed" />);
    expect(closed.container.querySelector(".hm-top--degraded")).toBeTruthy();
  });
});
