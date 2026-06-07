// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CoPilotRail } from "./CoPilotRail.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function card(over: Record<string, unknown>): BoardCard {
  return {
    id: "c", type: "pr", lane: "hermes-checking", agentType: "claude", title: "t", summary: "",
    repo: "r", freshness: 1, state: "fresh", risk: [], waitingOn: { actor: "agent", tone: "neutral" }, ...over,
  } as unknown as BoardCard;
}

describe("PR-D3d — rail Hermes digest", () => {
  test("shows real needs-you / running counts and an honest awaiting-data since-marker", () => {
    const cards = [
      card({ id: "operator-waiting", lane: "operator-review", waitingOn: { actor: "operator", tone: "warn" } }),
      card({ id: "action-card", isAction: true, waitingOn: { actor: "operator", tone: "warn" } }),
      card({ id: "running-card", state: "running" }),
    ];
    const { container } = render(<CoPilotRail boardCards={cards} collaboration={{ enabled: false }} />, { wrapper });
    const digest = container.querySelector(".hm-rail-digest") as HTMLElement;
    expect(digest).toBeTruthy();
    const view = within(digest);
    // needs-you = 2 (operator + isAction), running = 1
    expect(view.getByText("NEEDS YOU").parentElement?.querySelector(".hm-rail-digest-value")?.textContent).toBe("2");
    expect(view.getByText("RUNNING NOW").parentElement?.querySelector(".hm-rail-digest-value")?.textContent).toBe("1");
    // No fabricated session deltas — the since-marker is honest awaiting-data.
    expect(view.getByText(/session deltas · honest until wired/i)).toBeTruthy();
    expect(view.getByText("ADVANCED (SESSION)").parentElement?.querySelector(".hm-rail-digest-value")?.textContent).toBe("—");
    expect(view.getByText("PROD CHANGES").parentElement?.querySelector(".hm-rail-digest-value")?.textContent).toBe("—");
  });
});
