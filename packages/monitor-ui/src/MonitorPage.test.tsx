// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { MonitorPage } from "./MonitorPage.js";

afterEach(cleanup);

describe("MonitorPage — rich-mix / A1 state", () => {
  test("renders the full board chrome end-to-end", () => {
    const { container } = render(<MonitorPage />);
    const view = within(container);

    // Top strip
    expect(view.getByRole("banner")).toBeTruthy();
    expect(view.getByText("Hermes")).toBeTruthy();

    // Board Now banner — action tone (the fixtures include action cards)
    expect(container.querySelector(".hm-now--action")).toBeTruthy();
    expect(view.getByText(/your review decision/)).toBeTruthy();

    // Lanes bar
    expect(view.getByText("sorted by next-action urgency")).toBeTruthy();

    // Board grid with all eight lanes
    expect(view.getByRole("region", { name: "Lane grid" })).toBeTruthy();
    expect(container.querySelectorAll(".hm-lane").length).toBe(8);

    // Hermes co-pilot rail chrome (full rail lands in M8')
    expect(view.getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy();
  });

  test("the rich-mix preset expands five lanes; the other three are mini-rails", () => {
    const { container } = render(<MonitorPage />);
    expect(container.querySelectorAll("section.hm-lane").length).toBe(5);
    expect(container.querySelectorAll(".hm-lane--collapsed").length).toBe(3);
  });

  test("renders the action card with its CTA and Hermes verdict", () => {
    const { container } = render(<MonitorPage />);
    const view = within(container);
    // PR #548 is an isAction card, so laneFor() promotes it into the
    // (expanded) needs-attention lane.
    expect(view.getByText("Allow operator override of agent claim-stake floor")).toBeTruthy();
    expect(view.getByText("Approve & merge")).toBeTruthy();
    expect(view.getByText("Hermes verdict")).toBeTruthy();
  });

  test("renders a spread of card types (mission, deploy, done)", () => {
    const { container } = render(<MonitorPage />);
    const view = within(container);
    // Mission card (hermes-checking lane, expanded)
    expect(view.getByText("Verify onboarding flow on staging.averray.com")).toBeTruthy();
    // Deploy card (deploying lane, expanded)
    expect(view.getByText(/Post-merge verify/)).toBeTruthy();
    // Done history cards render with CLOSED freshness pips
    expect(view.getAllByText("CLOSED").length).toBeGreaterThan(0);
  });

  test("collapsed lanes hide their card bodies (drafts is a mini-rail)", () => {
    const { container } = render(<MonitorPage />);
    // The draft PR #550 lives in the collapsed drafts lane, so its title
    // is not in the DOM until the lane is expanded.
    expect(within(container).queryByText(/governance dispute UI/)).toBeNull();
  });
});
