// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CoPilotRail } from "./CoPilotRail.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function workingCard(): BoardCard {
  return {
    id: "agent #561",
    type: "pr",
    lane: "hermes-checking",
    agentType: "claude",
    title: "in flight",
    summary: "",
    repo: "averray-agent/agent",
    freshness: 1,
    state: "running",
    risk: [],
    waitingOn: { actor: "CI", tone: "info" },
    workingNow: { agent: "codex", label: "Codex fixing", source: "runner" },
  } as unknown as BoardCard;
}

function openAgentRoom(container: HTMLElement) {
  fireEvent.click(within(container).getByRole("tab", { name: /Agent room/ }));
}

describe("PR-D3c — room presence strip", () => {
  test("renders an active peer (from workingNow) with the active dot + count", () => {
    const { container } = render(
      <CoPilotRail boardCards={[workingCard()]} collaboration={{ enabled: false }} />,
      { wrapper },
    );
    openAgentRoom(container);
    const presence = container.querySelector(".hm-room-presence");
    expect(presence).toBeTruthy();
    expect(within(presence as HTMLElement).getByText("codex")).toBeTruthy();
    expect(container.querySelector(".hm-room-peer-dot.is-active")).toBeTruthy();
    expect(presence?.textContent).toMatch(/1 active/);
  });

  test("reads honestly as 'quiet' when no agent has a live signal", () => {
    const { container } = render(<CoPilotRail boardCards={[]} collaboration={{ enabled: false }} />, { wrapper });
    openAgentRoom(container);
    const presence = container.querySelector(".hm-room-presence--quiet");
    expect(presence?.textContent).toMatch(/quiet/i);
    expect(container.querySelector(".hm-room-peer")).toBeNull();
  });
});
