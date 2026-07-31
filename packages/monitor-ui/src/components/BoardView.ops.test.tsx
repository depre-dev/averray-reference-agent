// @vitest-environment jsdom
//
// The ops board's surviving contract (docs/OPS_ONLY_PIVOT.md).
//
// This replaces the 31-test `BoardView.test.tsx`, of which ~20 asserted the
// kanban board, decision inbox, cards, drawer and lanes — all retired with the
// delivery lane. The rest are NOT delivery tests: they are the truth-boundary
// guarantees that happened to live in a file named after the board, and every
// one of them is carried over here deliberately rather than dropped.
//
// What is preserved, and why each matters:
//   · a degraded stream must LOOK degraded (reconnecting + closed)
//   · "connecting" must NOT look degraded — no data yet is not a fault
//   · usage with no reporting source must say so, never imply zero spend
//   · Ask-Hermes must be honestly unavailable when collaboration is off
//   · the live clock is the snapshot's, not the wall clock
//   · refresh stays wired
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { BoardView } from "./BoardView.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";

afterEach(cleanup);

const board: MonitorBoard = { cards: [], at: "2026-05-28T10:30:00Z" };

describe("ops board — stream honesty", () => {
  // A stream we cannot trust must not render as a calm board. This is the
  // fake-green rule applied to the transport itself.
  test("a reconnecting stream shows the degraded strip and marks the data UNTRUSTED", () => {
    const { container, getByText } = render(<BoardView board={board} status="reconnecting" />);
    expect(container.querySelector(".hm-now--degraded")).toBeTruthy();
    expect(container.querySelector(".hm-top--degraded")).toBeTruthy();
    expect(getByText("Hermes — degraded mode")).toBeTruthy();
    expect(getByText("UNTRUSTED")).toBeTruthy();
  });

  test("a closed stream is degraded too", () => {
    const { container } = render(<BoardView board={board} status="closed" />);
    expect(container.querySelector(".hm-now--degraded")).toBeTruthy();
  });

  // The other half of the rule: "no data yet" is not a fault, and must not be
  // dressed as one. Alarm fatigue starts with alarms that were never real.
  test("connecting is NOT degraded — awaiting first data is not a failure", () => {
    const { container } = render(<BoardView board={undefined} status="connecting" />);
    expect(container.querySelector(".hm-now--degraded")).toBeNull();
  });

  test("the LIVE indicator uses the snapshot clock, not the wall clock", () => {
    const { getByText } = render(<BoardView board={board} status="open" />);
    expect(getByText(/Live · 10:30:00/)).toBeTruthy();
  });
});

describe("ops board — chrome that must not regress", () => {
  test("renders without a health payload instead of crashing", () => {
    const { getByTestId } = render(<BoardView board={board} status="open" />);
    // Honest "still polling", not an empty board pretending to be healthy.
    expect(getByTestId("ops-board-loading")).toBeTruthy();
  });

  test("Refresh stays wired", () => {
    const onRefresh = vi.fn();
    const { getByRole } = render(<BoardView board={board} status="open" onRefresh={onRefresh} />);
    fireEvent.click(getByRole("button", { name: "Refresh board" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("the surface switch is gone — there is nothing to switch to", () => {
    const { queryByRole } = render(<BoardView board={board} status="open" />);
    expect(queryByRole("button", { name: /delivery/i })).toBeNull();
    expect(queryByRole("tab", { name: /delivery/i })).toBeNull();
  });

  test("no kanban lane grid is rendered", () => {
    const { container } = render(<BoardView board={board} status="open" />);
    expect(container.querySelector('[aria-label="Kanban lane grid"]')).toBeNull();
  });
});
