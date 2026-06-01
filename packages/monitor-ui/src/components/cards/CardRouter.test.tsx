// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { CardRouter } from "./CardRouter.js";
import { FIXTURE_CARDS, DEGRADED_FIXTURE_CARDS } from "../../lib/monitor/fixtures.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

const fresh = FIXTURE_CARDS.find((c) => c.id === "agent #548") as BoardCard;
const failedFetch = DEGRADED_FIXTURE_CARDS.find((c) => c.state === "failed-fetch") as BoardCard;
const sourceOffline = DEGRADED_FIXTURE_CARDS.find((c) => c.state === "source-offline") as BoardCard;

describe("CardRouter — dispatch", () => {
  test("a fresh card renders the unified <Card> (not degraded)", () => {
    const { container } = render(<CardRouter card={fresh} />);
    expect(container.querySelector(".hm-card--err")).toBeNull();
    expect(container.querySelector(".hm-card--offline")).toBeNull();
    expect(within(container).getByText("Allow operator override of agent claim-stake floor")).toBeTruthy();
  });

  test("failed-fetch routes to <DegradedCard> with the default error content", () => {
    const { container } = render(<CardRouter card={failedFetch} />);
    const view = within(container);
    expect(container.querySelector(".hm-card--err")).toBeTruthy();
    expect(view.getByText(/Upstream returned an error/)).toBeTruthy();
    expect(view.getByText("source · fetch failed")).toBeTruthy();
    expect(view.getByText("Retry now")).toBeTruthy();
  });

  test("source-offline routes to <DegradedCard> with the default offline content", () => {
    const { container } = render(<CardRouter card={sourceOffline} />);
    const view = within(container);
    expect(container.querySelector(".hm-card--offline")).toBeTruthy();
    expect(view.getByText(/Upstream unreachable/)).toBeTruthy();
    expect(view.getByText("source · offline")).toBeTruthy();
    expect(view.getByText("View last known")).toBeTruthy();
  });

  test("onDegradedAction is wired to the degraded card's action button", () => {
    const onDegradedAction = vi.fn();
    const { container } = render(<CardRouter card={failedFetch} onDegradedAction={onDegradedAction} />);
    fireEvent.click(within(container).getByRole("button", { name: "Retry now" }));
    expect(onDegradedAction).toHaveBeenCalledWith(failedFetch);
  });
});
