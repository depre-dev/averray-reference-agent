// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { OpsBoard } from "./OpsBoard.js";
import { BankMovesList } from "./BankMovesList.js";
import {
  BANK_MOVE_EXAMPLE_LINE,
  BANK_MOVES_VISIBLE_LIMIT,
  type BankMoveLine,
} from "../../lib/monitor/bank-moves.js";
import { OPS_FIXTURE_NOMINAL, OPS_FIXTURE_UNVERIFIED, FIXTURE_NOW } from "../../lib/monitor/ops-fixtures.js";

afterEach(cleanup);

const EXAMPLE_MOVE: BankMoveLine = {
  id: "reserve",
  at: "2026-10-13T14:00:00.000Z",
  line: BANK_MOVE_EXAMPLE_LINE,
};

describe("recent bank moves quote the backend line", () => {
  test("the example line is pinned verbatim, newest first", () => {
    const older: BankMoveLine = {
      id: "older",
      at: "2026-10-13T13:00:00.000Z",
      line: "-1.50 settled · job not reported · 0x062d…8a self · not reported · not reported",
    };
    const { getAllByTestId } = render(
      <BankMovesList
        reading={{
          state: "live",
          incomplete: false,
          moves: [older, EXAMPLE_MOVE],
        }}
      />,
    );
    const lines = getAllByTestId("ops-bank-move").map((node) => node.textContent);
    expect(lines[0]).toBe(BANK_MOVE_EXAMPLE_LINE);
    expect(lines[0]).toMatchInlineSnapshot(
      `"+1.00 reserved · job pr-quanta-js-quanta-212 (git-patch-tests-v1) · 0x2e3c…91 regular (5 jobs, 3 settled, 1 rejected, 1 open, since Sep 28) · MCP, client "claude-code", stage claimed · claim expires 14:20Z, payout on merge"`,
    );
    expect(lines[1]).toBe(older.line);
  });

  test("a missing or failed read says not reported and never looks like zero", () => {
    const missing = render(<BankMovesList reading={undefined} />);
    expect(missing.getByTestId("ops-bank-moves-status").textContent).toBe("not reported");
    expect(missing.queryByTestId("ops-bank-move")).toBeNull();
    expect(missing.getByTestId("ops-bank-moves").textContent).not.toMatch(/\b0\b/);
    missing.unmount();

    const failed = render(<BankMovesList reading={{ state: "unavailable", text: "not reported" }} />);
    expect(failed.getByTestId("ops-bank-moves-status").textContent).toBe("not reported");
    expect(failed.getByTestId("ops-bank-moves").textContent).not.toMatch(/0 moves|empty/i);
  });

  test("a measured empty window is not a zero and not the failure sentinel", () => {
    const { getByTestId, queryByTestId } = render(
      <BankMovesList reading={{ state: "live", incomplete: false, moves: [] }} />,
    );
    expect(getByTestId("ops-bank-moves-status").textContent).toBe("none in window");
    expect(queryByTestId("ops-bank-move")).toBeNull();
    expect(getByTestId("ops-bank-moves").textContent).not.toMatch(/\b0\b/);
  });

  test("the list is bounded", () => {
    const moves = Array.from({ length: BANK_MOVES_VISIBLE_LIMIT + 2 }, (_, index) => ({
      id: `m-${index}`,
      at: `2026-10-13T14:${String(index).padStart(2, "0")}:00.000Z`,
      line: `+1.00 reserved · job ${index}`,
    }));
    const { getAllByTestId, getByTestId } = render(
      <BankMovesList reading={{ state: "live", incomplete: false, moves }} />,
    );
    const rendered = getAllByTestId("ops-bank-move");
    expect(rendered).toHaveLength(BANK_MOVES_VISIBLE_LIMIT);
    expect(rendered[0]?.textContent).toContain(`job ${BANK_MOVES_VISIBLE_LIMIT + 1}`);
    expect(getByTestId("ops-bank-moves-withheld").textContent).toBe("2 older moves withheld");
  });
});

describe("the venue lane keeps its rows when moves are unreadable", () => {
  test("position, float, and the move sentinel are all on the board", () => {
    const { getByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_UNVERIFIED} nowMs={(OPS_FIXTURE_UNVERIFIED.at ?? FIXTURE_NOW) + 2_000} />,
    );
    expect(getByTestId("ops-bank-position").textContent).toContain("UNVERIFIED");
    expect(getByTestId("ops-bank-float").textContent).toContain("USDC");
    expect(getByTestId("ops-bank-moves-status").textContent).toBe("not reported");
    expect(getByTestId("ops-bank-position").compareDocumentPosition(getByTestId("ops-bank-moves"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test("a live line does not replace the venue rows", () => {
    const { getByTestId, getAllByTestId } = render(
      <OpsBoard health={OPS_FIXTURE_NOMINAL} nowMs={(OPS_FIXTURE_NOMINAL.at ?? FIXTURE_NOW) + 2_000} />,
    );
    expect(getByTestId("ops-bank-requests").textContent).toContain("no requests in flight");
    expect(getAllByTestId("ops-bank-move").map((node) => node.textContent)).toContain(BANK_MOVE_EXAMPLE_LINE);
  });
});
