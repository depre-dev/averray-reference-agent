// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { BoardView } from "./BoardView.js";
import { FIXTURE_CARDS } from "../lib/monitor/fixtures.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";

afterEach(cleanup);

const richBoard: MonitorBoard = { cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" };

describe("BoardView — rich-mix board (open stream)", () => {
  test("renders the full board chrome end-to-end", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    expect(view.getByRole("banner")).toBeTruthy();
    expect(view.getByText("Hermes")).toBeTruthy();
    // action tone — the fixtures include action cards
    expect(container.querySelector(".hm-now--action")).toBeTruthy();
    expect(view.getByText(/your review decision/)).toBeTruthy();
    expect(view.getByText("sorted by next-action urgency")).toBeTruthy();
    expect(view.getByRole("region", { name: "Lane grid" })).toBeTruthy();
    expect(container.querySelectorAll(".hm-lane").length).toBe(8);
    expect(view.getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy();
  });

  test("action mode expands five lanes; the other three are mini-rails", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    expect(container.querySelectorAll("section.hm-lane").length).toBe(5);
    expect(container.querySelectorAll(".hm-lane--collapsed").length).toBe(3);
  });

  test("renders the action card with its CTA and Hermes verdict", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    expect(view.getByText("Allow operator override of agent claim-stake floor")).toBeTruthy();
    expect(view.getByText("Approve & merge")).toBeTruthy();
    expect(view.getByText("Hermes verdict")).toBeTruthy();
  });

  test("renders a spread of card types (mission, deploy, done)", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    expect(view.getByText("Verify onboarding flow on staging.averray.com")).toBeTruthy();
    expect(view.getByText(/Post-merge verify/)).toBeTruthy();
    expect(view.getAllByText("CLOSED").length).toBeGreaterThan(0);
  });

  test("collapsed lanes hide their card bodies (drafts is a mini-rail)", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    expect(within(container).queryByText(/governance dispute UI/)).toBeNull();
  });

  test("an open stream lights the LIVE indicator with the snapshot clock", () => {
    const { getByText } = render(<BoardView board={richBoard} status="open" />);
    expect(getByText(/Live · 10:30:00/)).toBeTruthy();
  });

  test("Refresh button is wired to onRefresh", () => {
    const onRefresh = vi.fn();
    const { getByRole } = render(<BoardView board={richBoard} status="open" onRefresh={onRefresh} />);
    fireEvent.click(getByRole("button", { name: "Refresh board" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("BoardView — degraded + transient states", () => {
  test("a reconnecting stream renders the degraded banner and a dimmed LIVE", () => {
    const { container, getByText } = render(<BoardView board={richBoard} status="reconnecting" />);
    expect(container.querySelector(".hm-now--degraded")).toBeTruthy();
    expect(getByText(/Live stream disconnected/)).toBeTruthy();
    // LIVE indicator only lights on a confirmed open stream.
    expect(getByText(/Live · —/)).toBeTruthy();
  });

  test("a closed stream is degraded too", () => {
    const { container } = render(<BoardView board={richBoard} status="closed" />);
    expect(container.querySelector(".hm-now--degraded")).toBeTruthy();
  });

  test("no board yet (connecting) renders the calm empty layout, not degraded", () => {
    const { container, getByText } = render(<BoardView board={undefined} status="connecting" />);
    expect(container.querySelector(".hm-now--degraded")).toBeNull();
    expect(getByText(/Nothing waits on you/)).toBeTruthy();
    // Still eight lanes, all empty.
    expect(container.querySelectorAll(".hm-lane").length).toBe(8);
  });
});
