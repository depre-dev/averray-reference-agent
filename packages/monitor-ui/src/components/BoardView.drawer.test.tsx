// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { BoardView } from "./BoardView.js";
import { FIXTURE_CARDS } from "../lib/monitor/fixtures.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";

afterEach(cleanup);

const board: MonitorBoard = { cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" };

describe("BoardView — drawer wiring", () => {
  test("clicking a card calls onCardClick with its id", () => {
    const onCardClick = vi.fn();
    const { getByRole } = render(<BoardView board={board} status="open" onCardClick={onCardClick} />);
    // The action PR #548 lives in the (expanded) needs-attention lane and
    // is a role=button because an onCardClick handler was supplied.
    fireEvent.click(getByRole("button", { name: /Allow operator override/ }));
    expect(onCardClick).toHaveBeenCalledWith("agent #548");
  });

  test("a focusedCardId opens the drawer for that card", () => {
    const { getByRole } = render(<BoardView board={board} status="open" focusedCardId="agent #548" />);
    const dialog = getByRole("dialog");
    expect(dialog.getAttribute("aria-label")).toContain("Allow operator override of agent claim-stake floor");
  });

  test("no drawer when focusedCardId is unset", () => {
    const { queryByRole } = render(<BoardView board={board} status="open" />);
    expect(queryByRole("dialog")).toBeNull();
  });

  test("an unknown focusedCardId renders no drawer (stale/deleted card)", () => {
    const { queryByRole } = render(<BoardView board={board} status="open" focusedCardId="agent #99999" />);
    expect(queryByRole("dialog")).toBeNull();
  });

  test("cards are inert (role=article) when no onCardClick is supplied", () => {
    const { container } = render(<BoardView board={board} status="open" />);
    const card = container.querySelector(".hm-card");
    expect(card?.getAttribute("role")).toBe("article");
  });

  test("the drawer's j/k traversal navigates across the visible board order", () => {
    const onCardNavigate = vi.fn();
    const { getByRole } = render(
      <BoardView board={board} status="open" focusedCardId="agent #548" onCardNavigate={onCardNavigate} />,
    );
    // Sanity: drawer is open for #548.
    expect(getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "j" });
    expect(onCardNavigate).toHaveBeenCalledTimes(1);
    // Navigates to some other card id (lane-ordered neighbour).
    expect(onCardNavigate.mock.calls[0]?.[0]).not.toBe("agent #548");
  });
});
