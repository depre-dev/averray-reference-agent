// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { Board, CALM_EXPANDED, DEFAULT_EXPANDED, LANE_DESCRIPTORS } from "./Board.js";
import { groupByLane } from "../lib/monitor/lane-rules.js";
import { FIXTURE_CARDS } from "../lib/monitor/fixtures.js";

afterEach(cleanup);

const doneOnly = groupByLane(FIXTURE_CARDS.filter((c) => c.lane === "done"));
const richMix = groupByLane(FIXTURE_CARDS);

describe("Board", () => {
  test("renders all eight lanes", () => {
    const { container } = render(<Board grouped={doneOnly} initialExpanded={CALM_EXPANDED} />);
    expect(container.querySelectorAll(".hm-lane").length).toBe(LANE_DESCRIPTORS.length);
    expect(LANE_DESCRIPTORS.length).toBe(8);
  });

  test("CALM_EXPANDED expands only Done; live lanes are mini-rails", () => {
    const { container, getByRole } = render(<Board grouped={doneOnly} initialExpanded={CALM_EXPANDED} />);
    // Done is an expanded <section>.
    expect(getByRole("region", { name: "Done lane" })).toBeTruthy();
    // The other seven lanes are collapsed buttons (mini-rails).
    const collapsed = container.querySelectorAll(".hm-lane--collapsed");
    expect(collapsed.length).toBe(7);
  });

  test("Done mini-rail count reflects the grouped cards", () => {
    const { getByRole } = render(<Board grouped={doneOnly} initialExpanded={new Set()} />);
    // With nothing expanded, Done collapses to a rail labelled with its count.
    const doneRail = getByRole("button", { name: /^Done \(/ });
    expect(doneRail.getAttribute("aria-label")).toContain(`(${doneOnly.done.length} cards)`);
  });

  test("DEFAULT_EXPANDED expands five lanes", () => {
    const { container } = render(<Board grouped={richMix} initialExpanded={DEFAULT_EXPANDED} />);
    const expandedSections = container.querySelectorAll("section.hm-lane");
    expect(expandedSections.length).toBe(DEFAULT_EXPANDED.size);
  });

  test("clicking a collapsed lane expands it", () => {
    const { getByRole, queryByRole } = render(<Board grouped={richMix} initialExpanded={CALM_EXPANDED} />);
    // Operator review starts collapsed (a button), no region yet.
    expect(queryByRole("region", { name: "Operator review lane" })).toBeNull();
    fireEvent.click(getByRole("button", { name: /Operator review/ }));
    // Now it is an expanded region.
    expect(getByRole("region", { name: "Operator review lane" })).toBeTruthy();
  });

  test("the lane grid is a labelled region", () => {
    const { getByRole } = render(<Board grouped={doneOnly} initialExpanded={CALM_EXPANDED} />);
    expect(getByRole("region", { name: "Lane grid" })).toBeTruthy();
  });
});
