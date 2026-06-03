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
  test("PR action card: title, FRESH pip, risk pills, checks, verdict, one working primary", () => {
    const { container } = render(<Card card={fixture("agent #548")} onApproveMerge={vi.fn()} />);
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
    expect(view.getByRole("button", { name: "Approve merge" })).toBeTruthy();
    expect(view.queryByText("Send back to Codex")).toBeNull();
  });

  test("cards classified into needs-attention get the action treatment even if isAction is missing", () => {
    const card = {
      ...fixture("agent #547"),
      lane: "needs-attention",
      isAction: false,
      waitingOn: { actor: "operator", tone: "warn" },
    } as BoardCard;
    const { container } = render(<Card card={card} />);
    expect(container.querySelector(".hm-card--action")).toBeTruthy();
  });

  test("mission card renders its summary and checks bar", () => {
    const { container } = render(<Card card={fixture("mission browser-onboard-04")} />);
    const view = within(container);
    expect(view.getByText("Verify onboarding flow on staging.averray.com")).toBeTruthy();
    expect(view.getByText("testbed")).toBeTruthy();
    expect(container.querySelector(".hm-checks-bar")).toBeTruthy();
    const run = container.querySelector(".hm-mission-run");
    expect(run).toBeTruthy();
    expect(within(run as HTMLElement).getByText("Tester run")).toBeTruthy();
    expect(within(run as HTMLElement).getByText("PARTIAL 81%")).toBeTruthy();
    expect(within(run as HTMLElement).getByText("staging.averray.com/onboarding")).toBeTruthy();
    expect(within(run as HTMLElement).getByText("2 screenshots")).toBeTruthy();
    expect(within(run as HTMLElement).getByText("trace")).toBeTruthy();
    expect(within(run as HTMLElement).getByText("console")).toBeTruthy();
    expect(within(run as HTMLElement).getByText(/Read-only mission/)).toBeTruthy();
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

  test("card shows real scoped Hermes/agent discussion inline", () => {
    const card: BoardCard = {
      ...fixture("agent #547"),
      discussion: [
        {
          id: "hermes-1",
          ts: Date.parse("2026-06-01T10:01:00.000Z"),
          author: "hermes",
          kind: "status",
          text: "Contract test X is red.",
          addressedTo: "codex",
          hermesMode: "live",
        },
        {
          id: "codex-1",
          ts: Date.parse("2026-06-01T10:02:00.000Z"),
          author: "codex",
          kind: "chat",
          text: "Fixing via Y.",
          addressedTo: "hermes",
        },
      ],
    };

    const { container } = render(<Card card={card} />);
    const discussion = container.querySelector(".hm-agent-discussion");
    expect(discussion).toBeTruthy();
    expect(within(discussion as HTMLElement).getByText("Agent discussion")).toBeTruthy();
    expect(within(discussion as HTMLElement).getByText("Hermes (live)")).toBeTruthy();
    expect(within(discussion as HTMLElement).getByText("Contract test X is red.")).toBeTruthy();
    expect(within(discussion as HTMLElement).getByText("Codex")).toBeTruthy();
    expect(within(discussion as HTMLElement).getByText("Fixing via Y.")).toBeTruthy();
  });

  test("card without discussion stays clean", () => {
    const { container } = render(<Card card={fixture("agent #547")} />);
    expect(container.querySelector(".hm-agent-discussion")).toBeNull();
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

  test("in-flight cards render the live worker separately from branch attribution", () => {
    const running: PRCard = {
      id: "agent #561",
      lane: "hermes-checking",
      type: "pr",
      agentType: "claude",
      title: "Claude-authored PR under Codex repair",
      summary: "runner active",
      repo: "depre-dev/agent",
      freshness: 2,
      state: "running",
      risk: [],
      waitingOn: { actor: "agent", tone: "info" },
      files: [],
      workingNow: {
        agent: "codex",
        label: "Codex fixing",
        source: "runner",
        runnerId: "codex-task-runner",
        taskId: "task-pr-561",
      },
    };

    const { container } = render(<Card card={running} />);
    const view = within(container);
    expect(view.getByText("claude")).toBeTruthy();
    expect(view.getByText(/working now/i)).toBeTruthy();
    expect(view.getByText("Codex fixing")).toBeTruthy();
    expect(container.querySelector(".hm-working-now")).toBeTruthy();
    expect(container.querySelector(".hm-working-now")?.getAttribute("title")).toContain("runner: codex-task-runner");
  });

  test("focused prop adds is-focused", () => {
    const { container } = render(<Card card={fixture("agent #547")} focused />);
    expect(container.querySelector(".hm-card.is-focused")).toBeTruthy();
  });
});

describe("Card — interactivity", () => {
  test("with onClick: role button, fires on click, CTA buttons don't bubble", () => {
    const onClick = vi.fn();
    const onApproveMerge = vi.fn();
    const { container } = render(<Card card={fixture("agent #548")} onClick={onClick} onApproveMerge={onApproveMerge} />);
    const root = container.querySelector(".hm-card") as HTMLElement;
    expect(root.getAttribute("role")).toBe("button");
    fireEvent.click(root);
    expect(onClick).toHaveBeenCalledTimes(1);

    // Clicking the primary CTA must not also trigger the card's onClick.
    fireEvent.click(within(container).getByText("Approve merge"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onApproveMerge).not.toHaveBeenCalled(); // first click only arms confirm
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

  test("a waiting-on-operator task exposes exactly one dispatch primary", () => {
    const onApprove = vi.fn();
    const onDismiss = vi.fn();
    const onSnooze = vi.fn();
    const onInvestigate = vi.fn();
    const { getByRole, queryByRole } = render(
      <Card
        card={proposed}
        onApprove={onApprove}
      />,
    );
    expect(getByRole("button", { name: /Approve & dispatch/ })).toBeTruthy();
    expect(queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(queryByRole("button", { name: "Snooze" })).toBeNull();
    expect(queryByRole("button", { name: "Investigate" })).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();
    expect(onSnooze).not.toHaveBeenCalled();
    expect(onInvestigate).not.toHaveBeenCalled();
  });

  test("humanizes guardrail enum codes while preserving raw codes on hover", () => {
    const card = {
      ...proposed,
      summary: "dispatch_budget_exhausted then duplicate_signal",
    } as unknown as BoardCard;
    const { getByText, getByTitle, queryByText } = render(<Card card={card} onApprove={vi.fn()} />);
    expect(getByText("Dispatch budget used up — paused until reset")).toBeTruthy();
    expect(getByText("Skipped — duplicate of an existing fix")).toBeTruthy();
    expect(getByTitle("raw code: dispatch_budget_exhausted")).toBeTruthy();
    expect(getByTitle("raw code: duplicate_signal")).toBeTruthy();
    expect(queryByText(/dispatch_budget_exhausted/)).toBeNull();
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
    expect(getByText(/First click only arms this action/)).toBeTruthy();
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

  test("watch-only in-flight cards show no action buttons even with handlers wired", () => {
    const running = {
      ...proposed,
      waitingOn: { actor: "agent", tone: "info" },
      taskStatus: "running",
      state: "running",
    } as unknown as BoardCard;
    const { container } = render(
      <Card
        card={running}
        onApprove={vi.fn()}
        onApproveMerge={vi.fn()}
        onRerunMission={vi.fn()}
      />,
    );
    expect(within(container).queryAllByRole("button")).toHaveLength(0);
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
    const { getByRole, getByText } = render(
      <Card card={requestedMission} onApproveMission={vi.fn()} onDismissMission={vi.fn()} />,
    );
    expect(getByText("Tester run requested")).toBeTruthy();
    expect(getByText("not started")).toBeTruthy();
    expect(getByRole("button", { name: /Approve & dispatch/ })).toBeTruthy();
    expect(getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  test("approving a tester mission requires confirm before dispatching to the runner queue", () => {
    const onApproveMission = vi.fn();
    const { getByRole, getByText } = render(<Card card={requestedMission} onApproveMission={onApproveMission} />);
    fireEvent.click(getByRole("button", { name: /Approve & dispatch/ }));
    expect(onApproveMission).not.toHaveBeenCalled();
    expect(getByText(/Dispatch tester runner\?/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /^Confirm$/ }));
    expect(onApproveMission).toHaveBeenCalledTimes(1);
    expect(onApproveMission.mock.calls[0]?.[0]?.id).toBe("testbed-mission-requested-1");
  });

  test("dismissing a tester mission requires confirm before clearing the request", () => {
    const onDismissMission = vi.fn();
    const { getByRole, getByText } = render(<Card card={requestedMission} onDismissMission={onDismissMission} />);
    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(onDismissMission).not.toHaveBeenCalled();
    expect(getByText(/Dismiss this requested tester mission\?/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /^Confirm$/ }));
    expect(onDismissMission).toHaveBeenCalledTimes(1);
    expect(onDismissMission.mock.calls[0]?.[0]?.id).toBe("testbed-mission-requested-1");
  });

  test("failed mission triage exposes operator Re-run, Accept failure, and Open issue actions", () => {
    const failedMission = {
      ...requestedMission,
      id: "testbed-mission-failed-1",
      lane: "needs-attention",
      missionStatus: "failed",
      isAction: true,
      mission: {
        verdict: "FAILED",
        verdictTone: "fail",
        confidence: 0.8,
        target: "https://staging.example.test",
        seed: "fresh",
        path: [],
        blockers: [],
        evidence: [],
        mutationBoundary: "No mutation crossed.",
        recommendations: [],
      },
    } as unknown as BoardCard;
    const onRerunMission = vi.fn();
    const onAcceptMissionFailure = vi.fn();
    const onOpenMissionIssue = vi.fn();
    const { getByRole, getByText, queryByRole } = render(
      <Card
        card={failedMission}
        onRerunMission={onRerunMission}
        onAcceptMissionFailure={onAcceptMissionFailure}
        onOpenMissionIssue={onOpenMissionIssue}
      />,
    );
    expect(getByRole("button", { name: "Re-run" })).toBeTruthy();
    expect(getByRole("button", { name: "Accept failure" })).toBeTruthy();
    expect(getByRole("button", { name: "Open issue" })).toBeTruthy();
    expect(queryByRole("button", { name: /Approve & dispatch/ })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Re-run" }));
    expect(getByText(/Re-run as a fresh mission\?/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: /^Confirm$/ }));
    expect(onRerunMission).toHaveBeenCalledWith(failedMission, "fresh");
    expect(onAcceptMissionFailure).not.toHaveBeenCalled();
    expect(onOpenMissionIssue).not.toHaveBeenCalled();
  });
});

describe("Card — archive hint 'Keep watching' (G4)", () => {
  test("calls onKeepWatching when wired; renders an honest disabled label otherwise", () => {
    const card = fixture("agent #542"); // archiveHint: true
    const onKeepWatching = vi.fn();
    const { getByRole, rerender, getByText } = render(<Card card={card} onKeepWatching={onKeepWatching} />);
    fireEvent.click(getByRole("button", { name: "Keep watching" }));
    expect(onKeepWatching).toHaveBeenCalledWith(card);

    // No handler ⇒ informational label, not a fake link.
    rerender(<Card card={card} />);
    expect(getByText("Keep watching").tagName).toBe("SPAN");
  });
});

describe("Card — decision hoist (P1-2)", () => {
  test("needs-attention card surfaces the decision summary + top reason in the body", () => {
    const card = fixture("agent #542"); // needs-attention, has a decisionRecord
    const { container } = render(<Card card={card} />);
    const block = container.querySelector(".hm-card-decision");
    expect(block).toBeTruthy();
    const view = within(block as HTMLElement);
    expect(view.getByText("Hermes decided")).toBeTruthy();
    expect(view.getByText(/Escalated for triage/)).toBeTruthy();
    // Top reason only — the full reason list stays in the drawer.
    expect(view.getByText(/no reviewer assigned/)).toBeTruthy();
    expect(view.queryByText(/no activity for 48h/)).toBeNull();
  });

  test("codex-needed card surfaces the decision in the body", () => {
    const card = fixture("task starter-coding-014"); // codex-needed, has a decisionRecord
    const { container } = render(<Card card={card} />);
    const block = container.querySelector(".hm-card-decision");
    expect(block).toBeTruthy();
    expect(within(block as HTMLElement).getByText(/Proposed a bounded Codex task/)).toBeTruthy();
  });

  test("a card without a decision record shows no hoist (no fabricated rationale)", () => {
    const card = fixture("agent #549"); // hermes-checking, no decisionRecord
    const { container } = render(<Card card={card} />);
    expect(container.querySelector(".hm-card-decision")).toBeNull();
  });

  test("the hoist is gated on the operator-decision lanes, not merely on having a record", () => {
    const base = fixture("agent #547"); // release-queue
    const withRecord = {
      ...base,
      decisionRecord: {
        schemaVersion: 1 as const,
        recordType: "hermes_decision_record" as const,
        id: "dr-test",
        kind: "routing" as const,
        subject: { type: "pr" as const, id: base.id, repo: base.repo },
        decision: "queue",
        reasons: ["all checks green"],
        inputs: {},
        outcome: { summary: "Merge-ready; queued behind branch protection." },
        safety: { readOnly: true, mutates: false },
        generatedAt: "2026-05-29T10:00:00Z",
      },
    } as unknown as BoardCard;
    const { container } = render(<Card card={withRecord} />);
    expect(container.querySelector(".hm-card-decision")).toBeNull();
  });
});

describe("Card — failed mission readable summary", () => {
  test("renders a clean one-liner, never raw stderr / box-drawing / pipes", () => {
    const card = fixture("mission browser-checkout-12"); // failed mission, raw dump in summary + blocker
    const { container } = render(<Card card={card} />);
    const meta = container.querySelector(".hm-card-meta");
    expect(meta).toBeTruthy();
    const text = meta?.textContent ?? "";
    // Clean, mapped one-liner.
    expect(text).toContain("Mission failed — browser binary not installed");
    // Zero raw noise on the card.
    expect(text).not.toContain("\n");
    expect(text).not.toContain("|");
    expect(text).not.toMatch(/[─-▟]/);
    expect(text).not.toContain("ms-playwright");
  });

  test("renders failed tester runs as a compact report, without raw runner output", () => {
    const card = fixture("mission browser-checkout-12");
    const { container } = render(<Card card={card} />);
    const run = container.querySelector(".hm-mission-run");
    expect(run).toBeTruthy();
    const text = run?.textContent ?? "";
    expect(within(run as HTMLElement).getByText("Tester run")).toBeTruthy();
    expect(within(run as HTMLElement).getByText("FAILED 0%")).toBeTruthy();
    expect(within(run as HTMLElement).getByText("staging.averray.com/checkout")).toBeTruthy();
    expect(text).toContain("browser binary not installed");
    expect(text).toContain("no artifacts captured");
    expect(text).toContain("No mutation");
    expect(text).not.toContain("ms-playwright");
    expect(text).not.toContain("npx playwright install");
    expect(text).not.toContain("|");
  });
});
