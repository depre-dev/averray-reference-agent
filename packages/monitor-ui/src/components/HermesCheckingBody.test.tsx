// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { HermesCheckingBody } from "./HermesCheckingBody.js";
import type { BoardCard } from "../lib/monitor/card-types.js";

afterEach(cleanup);

function card(over: Record<string, unknown>): BoardCard {
  return {
    id: "card-x",
    lane: "hermes-checking",
    type: "pr",
    agentType: "codex",
    title: "Pre-checking the change",
    summary: "summary",
    repo: "depre-dev/agent",
    freshness: 5,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "agent", tone: "info" },
    files: [],
    ...over,
  } as BoardCard;
}

// A minimal renderer standing in for CardRouter — emits the card id as text.
const renderCard = (c: BoardCard) => <div key={c.id} data-testid="card">{c.id}</div>;

describe("HermesCheckingBody (P1-1)", () => {
  test("every legit in-flight card shows a human status label + its title", () => {
    const mission = card({ id: "m1", type: "mission", title: "Verify onboarding" });
    const prCheck = card({ id: "pr1", waitingOn: { actor: "agent", tone: "info" } });
    const ci = card({ id: "ci1", waitingOn: { actor: "CI", tone: "info" } });
    const { getByText } = render(<HermesCheckingBody cards={[mission, prCheck, ci]} renderCard={renderCard} />);
    expect(getByText("Mission running")).toBeTruthy();
    expect(getByText("Pre-check")).toBeTruthy();
    expect(getByText("CI watching")).toBeTruthy();
    // The cards themselves still render.
    expect(getByText("m1")).toBeTruthy();
    expect(getByText("pr1")).toBeTruthy();
  });

  test("unrouted cards collapse into ONE quiet summary with a count, closed by default", () => {
    const routed = card({ id: "routed-1", lane: "hermes-checking" });
    const u1 = card({ id: "u1", lane: undefined as unknown as BoardCard["lane"] });
    const u2 = card({ id: "u2", lane: undefined as unknown as BoardCard["lane"] });
    const u3 = card({ id: "u3", lane: undefined as unknown as BoardCard["lane"] });
    const { getByText, container } = render(
      <HermesCheckingBody cards={[routed, u1, u2, u3]} renderCard={renderCard} />,
    );
    // A single de-emphasized summary with the count — not three loose cards.
    expect(getByText("3 unrouted — source may be offline")).toBeTruthy();
    const details = container.querySelector("details.hm-unrouted") as HTMLDetailsElement;
    expect(details).toBeTruthy();
    // Collapsed by default (no `open` attribute).
    expect(details.open).toBe(false);
    // The routed card is NOT inside the collapsed group.
    expect(container.querySelector(".hm-unrouted")!.contains(getByText("routed-1"))).toBe(false);
  });

  test("no unrouted cards → no summary at all (a clean lane stays clean)", () => {
    const { queryByText, container } = render(
      <HermesCheckingBody cards={[card({ id: "ok-1" })]} renderCard={renderCard} />,
    );
    expect(container.querySelector("details.hm-unrouted")).toBeNull();
    expect(queryByText(/unrouted/)).toBeNull();
  });
});
