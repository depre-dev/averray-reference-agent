// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { Card } from "./Card.js";
import { FIXTURE_CARDS } from "../../lib/monitor/fixtures.js";
import type { BoardCard, PRCard } from "../../lib/monitor/card-types.js";

afterEach(cleanup);

function fixture(id: string): BoardCard {
  const card = FIXTURE_CARDS.find((c) => c.id === id);
  if (!card) throw new Error(`fixture not found: ${id}`);
  return card;
}

describe("Card — type coverage", () => {
  test("PR action card: title, FRESH pip, risk pills, checks, verdict, CTA", () => {
    const { container } = render(<Card card={fixture("agent #548")} />);
    const view = within(container);
    expect(view.getByText("Allow operator override of agent claim-stake floor")).toBeTruthy();
    expect(container.querySelector(".hm-card--action")).toBeTruthy();
    expect(view.getByText(/FRESH/)).toBeTruthy();
    // risk pills
    expect(view.getByText("workflow")).toBeTruthy();
    expect(view.getByText("review-gated")).toBeTruthy();
    // checks bar + label
    expect(container.querySelector(".hm-checks-bar")).toBeTruthy();
    // Hermes verdict + CTA
    expect(view.getByText("Hermes verdict")).toBeTruthy();
    expect(view.getByText("Approve & merge")).toBeTruthy();
    expect(view.getByText("Send back to Codex")).toBeTruthy();
  });

  test("mission card renders its summary and checks bar", () => {
    const { container } = render(<Card card={fixture("mission browser-onboard-04")} />);
    const view = within(container);
    expect(view.getByText("Verify onboarding flow on staging.averray.com")).toBeTruthy();
    expect(view.getByText("testbed")).toBeTruthy();
    expect(container.querySelector(".hm-checks-bar")).toBeTruthy();
  });

  test("deploy card renders its verification summary", () => {
    const { container } = render(<Card card={fixture("deploy #246")} />);
    const view = within(container);
    expect(view.getByText(/Post-merge verify/)).toBeTruthy();
    expect(view.getByText("xcm")).toBeTruthy();
  });

  test("codex task card renders without checks (no CI yet)", () => {
    const { container } = render(<Card card={fixture("task starter-coding-014")} />);
    const view = within(container);
    expect(view.getByText("Reduce audit-log noise when policy auto-applies")).toBeTruthy();
    expect(container.querySelector(".hm-checks-bar")).toBeNull();
  });

  test("card shows a small cross-agent review request indicator", () => {
    const card: BoardCard = {
      ...fixture("agent #547"),
      reviewRequests: [{
        id: "review-1",
        requestedBy: "hermes",
        reviewer: "claude",
        reason: "Second-agent review before this moves forward.",
        status: "requested",
        createdAt: "2026-05-31T12:00:00.000Z",
        updatedAt: "2026-05-31T12:00:00.000Z",
      }],
    };
    const { container } = render(<Card card={card} />);
    expect(within(container).getByText("Review requested")).toBeTruthy();
    expect(within(container).getByText("Claude")).toBeTruthy();
    expect(container.querySelector(".hm-review-request")).toBeTruthy();
  });

  test("card shows high-risk reviewer panels as a panel, not a single reviewer", () => {
    const card: BoardCard = {
      ...fixture("agent #547"),
      reviewRequests: ["hermes", "codex", "claude"].map((reviewer) => ({
        id: `review-${reviewer}`,
        requestedBy: "hermes",
        reviewer: reviewer as "hermes" | "codex" | "claude",
        reason: "High-risk panel before operator decision.",
        status: "requested",
        reviewMode: "panel",
        panelId: "panel-1",
        panelSize: 3,
        createdAt: "2026-05-31T12:00:00.000Z",
        updatedAt: "2026-05-31T12:00:00.000Z",
      })),
    };

    const { container } = render(<Card card={card} />);
    expect(within(container).getByText("Panel review")).toBeTruthy();
    expect(within(container).getByText("Hermes, Codex, Claude")).toBeTruthy();
  });

  test("draft PR shows the draft pill", () => {
    const { container } = render(<Card card={fixture("agent #550")} />);
    expect(within(container).getByText("draft")).toBeTruthy();
  });

  test("done/closed card: CLOSED pip, no risk pills, no checks bar, no waiting-on", () => {
    const done = FIXTURE_CARDS.find((c) => c.type === "done");
    if (!done) throw new Error("no done fixture");
    const { container } = render(<Card card={done} />);
    expect(within(container).getByText("CLOSED")).toBeTruthy();
    expect(container.querySelector(".hm-pillrow")).toBeNull();
    expect(container.querySelector(".hm-checks-bar")).toBeNull();
    // Closed cards never render a waiting-on line (compressed layout).
    expect(container.querySelector(".hm-waiting")).toBeNull();
  });

  test("done card with a live waitingOn still suppresses the waiting-on line", () => {
    // Live backend data carries a waitingOn on done cards; the card must
    // not leak it into the compressed historical layout.
    const done: BoardCard = {
      id: "agent #588",
      lane: "done",
      type: "done",
      agentType: "ext",
      title: "Refresh mainnet audit package",
      summary: "",
      repo: "depre-dev/agent",
      freshness: 0,
      state: "fresh",
      risk: [],
      waitingOn: { actor: "operator", tone: "neutral" },
      closedAt: "2026-05-28T22:15:52Z",
      mergeStatus: "MERGED",
      verdictText: "merged",
    };
    const { container } = render(<Card card={done} />);
    const view = within(container);
    expect(view.getByText("CLOSED")).toBeTruthy();
    expect(view.getByText("merged")).toBeTruthy();
    expect(container.querySelector(".hm-waiting")).toBeNull();
    expect(view.queryByText(/waiting on/i)).toBeNull();
  });
});

describe("Card — state coverage", () => {
  test("stale card wears is-stale, a STALE pip, and the archive hint", () => {
    const { container } = render(<Card card={fixture("agent #542")} />);
    const view = within(container);
    expect(container.querySelector(".hm-card.is-stale")).toBeTruthy();
    expect(view.getByText(/STALE/)).toBeTruthy();
    expect(view.getByText(/archive in 4h\?/)).toBeTruthy();
  });

  test("running state renders a fresh-styled, non-stale card", () => {
    const running: PRCard = {
      id: "agent #560",
      lane: "hermes-checking",
      type: "pr",
      agentType: "claude",
      title: "Running CI card",
      summary: "checks in flight",
      repo: "depre-dev/agent",
      freshness: 3,
      state: "running",
      risk: [],
      checks: { pass: 2, running: 4, fail: 0, pending: 0, total: 6 },
      waitingOn: { actor: "CI", tone: "info" },
      files: [],
    };
    const { container } = render(<Card card={running} />);
    expect(container.querySelector(".hm-card.is-stale")).toBeNull();
    expect(within(container).getByText(/FRESH/)).toBeTruthy();
    expect(container.querySelector(".running")).toBeTruthy();
  });

  test("focused prop adds is-focused", () => {
    const { container } = render(<Card card={fixture("agent #547")} focused />);
    expect(container.querySelector(".hm-card.is-focused")).toBeTruthy();
  });
});

describe("Card — interactivity", () => {
  test("with onClick: role button, fires on click, CTA buttons don't bubble", () => {
    const onClick = vi.fn();
    const { container } = render(<Card card={fixture("agent #548")} onClick={onClick} />);
    const root = container.querySelector(".hm-card") as HTMLElement;
    expect(root.getAttribute("role")).toBe("button");
    fireEvent.click(root);
    expect(onClick).toHaveBeenCalledTimes(1);

    // Clicking the primary CTA must not also trigger the card's onClick.
    fireEvent.click(within(container).getByText("Approve & merge"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("without onClick: role article", () => {
    const { container } = render(<Card card={fixture("agent #547")} />);
    expect((container.querySelector(".hm-card") as HTMLElement).getAttribute("role")).toBe("article");
  });
});

describe("Card — task approve (O3 dispatch)", () => {
  const proposed = {
    id: "claude-task-x1",
    lane: "codex-needed",
    type: "task",
    agentType: "claude",
    title: "Add a HEALTHCHECK.md",
    summary: "operator delegated",
    repo: "averray-agent/agent",
    freshness: 1,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "warn" },
    taskStatus: "proposed",
    prompt: "Add a top-level HEALTHCHECK.md.",
  } as unknown as BoardCard;

  test("a proposed task card shows the agent badge and an Approve & dispatch CTA", () => {
    const { getByText, getByRole } = render(<Card card={proposed} onApprove={vi.fn()} />);
    expect(getByText("claude")).toBeTruthy(); // agent badge
    expect(getByRole("button", { name: /Approve & dispatch/ })).toBeTruthy();
  });

  test("a proposed test-writer card shows specialist attribution", () => {
    const card = { ...proposed, id: "test-writer-task-x1", agentType: "test-writer" } as unknown as BoardCard;
    const { getByText, getByRole } = render(<Card card={card} onApprove={vi.fn()} />);
    expect(getByText("test-writer")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /Approve & dispatch/ }));
    expect(getByText(/Dispatch to test-writer\?/)).toBeTruthy();
  });

  test("approving requires a confirm step before onApprove fires (no single-click dispatch)", () => {
    const onApprove = vi.fn();
    const { getByRole, getByText } = render(<Card card={proposed} onApprove={onApprove} />);
    fireEvent.click(getByRole("button", { name: /Approve & dispatch/ }));
    expect(onApprove).not.toHaveBeenCalled(); // first click only arms the confirm
    expect(getByText(/Dispatch to claude\?/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /^Confirm$/ }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove.mock.calls[0]?.[0]?.id).toBe("claude-task-x1");
  });

  test("Cancel aborts the confirm without dispatching", () => {
    const onApprove = vi.fn();
    const { getByRole } = render(<Card card={proposed} onApprove={onApprove} />);
    fireEvent.click(getByRole("button", { name: /Approve & dispatch/ }));
    fireEvent.click(getByRole("button", { name: /Cancel/ }));
    expect(onApprove).not.toHaveBeenCalled();
    expect(getByRole("button", { name: /Approve & dispatch/ })).toBeTruthy();
  });

  test("a non-proposed task card shows no approve CTA", () => {
    const running = { ...proposed, taskStatus: "running" } as unknown as BoardCard;
    const { queryByRole } = render(<Card card={running} onApprove={vi.fn()} />);
    expect(queryByRole("button", { name: /Approve & dispatch/ })).toBeNull();
  });
});

describe("Card — requested tester mission approve (T6)", () => {
  const requestedMission = {
    id: "testbed-mission-requested-1",
    lane: "operator-review",
    type: "mission",
    agentType: "hermes",
    title: "Tester run requested",
    summary: "Tester run requested by codex; it has not started and remains board-gated until the operator approves it.",
    repo: "testbed/mission",
    freshness: 1,
    state: "fresh",
    risk: ["testbed"],
    waitingOn: { actor: "operator", tone: "neutral" },
    missionStatus: "requested",
  } as unknown as BoardCard;

  test("shows that the mission has not started and requires approval", () => {
    const { getByRole, getByText } = render(<Card card={requestedMission} onApproveMission={vi.fn()} />);
    expect(getByText("Tester run requested")).toBeTruthy();
    expect(getByText("not started")).toBeTruthy();
    expect(getByRole("button", { name: /Approve tester run/ })).toBeTruthy();
  });

  test("approving a tester mission requires confirm before dispatching to the runner queue", () => {
    const onApproveMission = vi.fn();
    const { getByRole, getByText } = render(<Card card={requestedMission} onApproveMission={onApproveMission} />);
    fireEvent.click(getByRole("button", { name: /Approve tester run/ }));
    expect(onApproveMission).not.toHaveBeenCalled();
    expect(getByText(/Queue runner now\?/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /^Confirm$/ }));
    expect(onApproveMission).toHaveBeenCalledTimes(1);
    expect(onApproveMission.mock.calls[0]?.[0]?.id).toBe("testbed-mission-requested-1");
  });
});
