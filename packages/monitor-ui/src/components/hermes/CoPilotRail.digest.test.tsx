// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CoPilotRail } from "./CoPilotRail.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";
import { OPS_FIXTURE_LIVE, OPS_FIXTURE_RED } from "../../lib/monitor/ops-fixtures.js";

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

  test("surfaces a compact ops line when product health is provided", () => {
    const { container } = render(
      <CoPilotRail boardCards={[]} collaboration={{ enabled: false }} productHealth={OPS_FIXTURE_LIVE} />,
      { wrapper },
    );
    const ops = container.querySelector(".hm-rail-ops") as HTMLElement;
    expect(ops).toBeTruthy();
    expect(ops.className).toContain("hm-rail-ops--degraded");
    expect(ops.textContent).toContain("Ops · degraded · safe");
    expect(ops.textContent).toContain("chain not advancing");
  });

  test("no ops line when product health is absent (rail stays delivery-only)", () => {
    const { container } = render(<CoPilotRail boardCards={[]} collaboration={{ enabled: false }} />, { wrapper });
    expect(container.querySelector(".hm-rail-ops")).toBeNull();
  });

  test("ops suggestions box: informational rows + a human-gated Propose task button", () => {
    const onCreateTask = vi.fn();
    const { container } = render(
      <CoPilotRail boardCards={[]} collaboration={{ enabled: false }} productHealth={OPS_FIXTURE_RED} onCreateTask={onCreateTask} />,
      { wrapper },
    );
    const box = container.querySelector(".hm-rail-ops-sugg") as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.textContent).toContain("Signer USDC below floor");
    const propose = within(box).getByText("Propose task");
    fireEvent.click(propose);
    expect(onCreateTask).toHaveBeenCalledTimes(1);
    expect(onCreateTask.mock.calls[0][0].repo).toContain("averray-reference-agent");
  });
});
