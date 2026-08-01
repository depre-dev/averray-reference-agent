// @vitest-environment jsdom
//
// The ops board's surviving contract (docs/OPS_ONLY_PIVOT.md).
//
// These are the truth-boundary guarantees, not layout tests. The board has now
// been redesigned twice — kanban → zone grid → spec sheet — and every one of
// these assertions has been carried across each time on purpose. They are the
// reason the redesign was safe to do at all.
//
// What is preserved, and why each matters:
//   · a degraded stream must LOOK degraded, and must override a calm verdict
//   · a degraded stream with NO health data must still say so
//   · "connecting" must NOT look degraded — no data yet is not a fault
//   · the live clock is the snapshot's, not the wall clock
//   · refresh stays wired, and stays the only control
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { BoardView } from "./BoardView.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";
import { OPS_FIXTURE_NOMINAL } from "../lib/monitor/ops-fixtures.js";

afterEach(cleanup);

const board: MonitorBoard = { cards: [], at: "2026-05-28T10:30:00Z" };
// A genuinely healthy mainnet read, checked just now — so any alarm raised
// below is caused by the STREAM, not by the numbers.
const healthy = { ...OPS_FIXTURE_NOMINAL, at: Date.now() - 2_000 };

describe("ops board — stream honesty", () => {
  // A stream we cannot trust must not render as a calm board. This is the
  // fake-green rule applied to the transport itself.
  test("a reconnecting stream raises the stale banner over otherwise-healthy data", () => {
    const { getByTestId } = render(
      <BoardView board={board} status="reconnecting" health={healthy} />,
    );
    expect(getByTestId("ops-stale-banner").textContent).toContain("STREAM DISCONNECTED");
    expect(getByTestId("ops-board").getAttribute("data-untrusted")).toBe("yes");
  });

  test("a closed stream is degraded too", () => {
    const { getByTestId } = render(<BoardView board={board} status="closed" health={healthy} />);
    expect(getByTestId("ops-stale-banner")).toBeTruthy();
  });

  // The values themselves must LOOK untrusted, not merely carry a banner above
  // them. A reader whose eye skips the banner still has to see stale as stale.
  test("stale data is visibly dimmed, not just labelled", () => {
    const { container } = render(<BoardView board={board} status="closed" health={healthy} />);
    expect(container.querySelector('.ops-content[data-dim="yes"]')).toBeTruthy();
  });

  test("the verdict re-labels itself LAST KNOWN STATE instead of staying calm", () => {
    const { container } = render(
      <BoardView board={board} status="reconnecting" health={healthy} />,
    );
    expect(container.querySelector(".ops-verdict-kicker")?.textContent).toContain(
      "LAST KNOWN STATE",
    );
  });

  // The other half of the rule: "no data yet" is not a fault, and must not be
  // dressed as one. Alarm fatigue starts with alarms that were never real.
  test("connecting is NOT degraded — awaiting first data is not a failure", () => {
    const { queryByTestId } = render(<BoardView board={undefined} status="connecting" />);
    expect(queryByTestId("ops-stale-banner")).toBeNull();
  });

  test("an open stream shows no stale banner and no dimming", () => {
    const { queryByTestId, container } = render(
      <BoardView board={board} status="open" health={healthy} />,
    );
    expect(queryByTestId("ops-stale-banner")).toBeNull();
    expect(container.querySelector('.ops-content[data-dim="yes"]')).toBeNull();
  });

  test("the STREAM row uses the snapshot clock, not the wall clock", () => {
    const { getByTestId } = render(<BoardView board={board} status="open" health={healthy} />);
    expect(getByTestId("ops-trust").textContent).toContain("last event 10:30:00");
  });
});

describe("ops board — chrome that must not regress", () => {
  test("renders without a health payload instead of crashing", () => {
    const { getByTestId } = render(<BoardView board={board} status="open" />);
    // Honest "still polling", not an empty board pretending to be healthy.
    expect(getByTestId("ops-board-loading")).toBeTruthy();
  });

  // The loading state is the one place a dead stream could hide behind a
  // reassuring word. It must not.
  test("a dead stream with NO health data still announces itself", () => {
    const { getByTestId, getByText } = render(<BoardView board={board} status="closed" />);
    expect(getByTestId("ops-stale-banner").textContent).toContain("STREAM DISCONNECTED");
    expect(getByText("Health unknown")).toBeTruthy();
  });

  test("Refresh stays wired", () => {
    const onRefresh = vi.fn();
    const { getByRole } = render(
      <BoardView board={board} status="open" health={healthy} onRefresh={onRefresh} />,
    );
    fireEvent.click(getByRole("button", { name: "refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("the surface switch is gone — there is nothing to switch to", () => {
    const { queryByRole } = render(<BoardView board={board} status="open" health={healthy} />);
    expect(queryByRole("button", { name: /delivery/i })).toBeNull();
    expect(queryByRole("tab", { name: /delivery/i })).toBeNull();
  });

  test("no kanban lane grid is rendered", () => {
    const { container } = render(<BoardView board={board} status="open" health={healthy} />);
    expect(container.querySelector('[aria-label="Kanban lane grid"]')).toBeNull();
  });

  // The board is read-only by design; commands live in Buzz. Refresh is the
  // only control, and a stray button here would be a promise it can't keep.
  test("refresh is the only control on the board", () => {
    const { container } = render(
      <BoardView board={board} status="open" health={healthy} onRefresh={() => {}} />,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["refresh"]);
  });
});
