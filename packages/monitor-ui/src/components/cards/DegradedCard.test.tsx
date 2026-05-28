// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { DegradedCard } from "./DegradedCard.js";
import { DEGRADED_FIXTURE_CARDS } from "../../lib/monitor/fixtures.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

const failedFetch = DEGRADED_FIXTURE_CARDS.find((c) => c.state === "failed-fetch") as BoardCard;
const sourceOffline = DEGRADED_FIXTURE_CARDS.find((c) => c.state === "source-offline") as BoardCard;

describe("DegradedCard", () => {
  test("failed-fetch → rose error treatment, ERROR pip, body + pills + action", () => {
    const { container } = render(
      <DegradedCard
        card={failedFetch}
        body="Upstream returned an error."
        pills={[
          ["hm-pill--err", "fetch failed"],
          ["hm-pill--neutral", "retry available"],
        ]}
        action="Retry now"
      />,
    );
    const view = within(container);
    expect(container.querySelector(".hm-card--err")).toBeTruthy();
    expect(view.getByText("ERROR")).toBeTruthy();
    expect(view.getByText("Upstream returned an error.")).toBeTruthy();
    expect(view.getByText("fetch failed")).toBeTruthy();
    expect(view.getByText("Retry now")).toBeTruthy();
  });

  test("source-offline → neutral treatment, OFFLINE pip", () => {
    const { container } = render(
      <DegradedCard
        card={sourceOffline}
        body="Upstream unreachable."
        pills={[["hm-pill--offline", "source · offline"]]}
        action="View last known"
      />,
    );
    const view = within(container);
    expect(container.querySelector(".hm-card--offline")).toBeTruthy();
    expect(view.getByText("OFFLINE")).toBeTruthy();
    expect(view.getByText("source · offline")).toBeTruthy();
  });

  test("action button is disabled without a handler and fires with one", () => {
    const noHandler = render(
      <DegradedCard card={failedFetch} body="x" pills={[]} action="Retry now" />,
    );
    expect((noHandler.getByRole("button", { name: "Retry now" }) as HTMLButtonElement).disabled).toBe(true);

    const onAction = vi.fn();
    const withHandler = render(
      <DegradedCard card={failedFetch} body="x" pills={[]} action="Retry now" onAction={onAction} />,
    );
    const btn = within(withHandler.container).getByRole("button", { name: "Retry now" });
    fireEvent.click(btn);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  test("the action click does not bubble to the card onClick", () => {
    const onClick = vi.fn();
    const onAction = vi.fn();
    const { container } = render(
      <DegradedCard
        card={failedFetch}
        body="x"
        pills={[]}
        action="Retry now"
        onClick={onClick}
        onAction={onAction}
      />,
    );
    fireEvent.click(within(container).getByRole("button", { name: "Retry now" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });
});
