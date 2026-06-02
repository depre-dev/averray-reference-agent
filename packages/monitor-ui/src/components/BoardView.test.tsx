// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { BoardView } from "./BoardView.js";
import { FIXTURE_CARDS } from "../lib/monitor/fixtures.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";
import type { BoardCard } from "../lib/monitor/card-types.js";

afterEach(cleanup);

const richBoard: MonitorBoard = { cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" };

describe("BoardView — rich-mix board (open stream)", () => {
  test("renders the full board chrome end-to-end", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    expect(view.getByRole("banner")).toBeTruthy();
    expect(container.querySelector(".hm-brand-name")?.textContent).toBe("Hermes");
    // action tone — the fixtures include action cards
    expect(container.querySelector(".hm-now--action")).toBeTruthy();
    expect(view.getByText(/your review decision/)).toBeTruthy();
    expect(view.getByText("sorted by next-action urgency")).toBeTruthy();
    expect(view.getByRole("region", { name: "Lane grid" })).toBeTruthy();
    expect(container.querySelectorAll(".hm-lane").length).toBe(8);
    expect(view.getByRole("complementary", { name: "Hermes co-pilot" })).toBeTruthy();
  });

  test("every lane that holds cards is expanded; only empty lanes stay mini-rails", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    // 7 of 8 lanes hold cards after grouping (the lone operator-review PR is an
    // action card, promoted to needs-attention) → 7 expanded, 1 empty rail.
    expect(container.querySelectorAll("section.hm-lane").length).toBe(7);
    expect(container.querySelectorAll(".hm-lane--collapsed").length).toBe(1);
    // drafts/codex-needed hold cards but aren't in the action preset — pre-fix
    // they were hidden behind rails; now their card bodies render.
    expect(within(container).getByText(/governance dispute UI/)).toBeTruthy();
  });

  test("renders the action card with one primary and Hermes verdict", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    expect(view.getByText("Allow operator override of agent claim-stake floor")).toBeTruthy();
    expect(view.getAllByRole("button", { name: "Approve merge" }).length).toBeGreaterThan(0);
    expect(view.queryByText("Send back to Codex")).toBeNull();
    expect(view.getByText("Hermes verdict")).toBeTruthy();
  });

  test("action banner CTA opens the real review card", () => {
    const onCardClick = vi.fn();
    const board: MonitorBoard = {
      at: "2026-05-28T10:30:00Z",
      cards: [reviewCard({ id: "agent #548", title: "Review relay hang fix" })],
    };
    const { getByRole } = render(<BoardView board={board} status="open" onCardClick={onCardClick} keyboard={false} />);

    fireEvent.click(getByRole("button", { name: /Jump to agent #548/ }));
    expect(onCardClick).toHaveBeenCalledWith("agent #548");

    fireEvent.click(getByRole("button", { name: "Open review checklist" }));
    expect(onCardClick).toHaveBeenCalledWith("agent #548");
  });

  test("Hermes focus banner appears only for a real scoped conversation on the pending review card", async () => {
    const board: MonitorBoard = {
      at: "2026-05-28T10:30:00Z",
      cards: [reviewCard({ id: "agent #548", title: "Review relay hang fix" })],
    };
    const { getByText } = render(
      <BoardView
        board={board}
        status="open"
        focusedCardId="agent #548"
        onCardClick={() => {}}
        keyboard={false}
        collaboration={{
          fetcher: async () => [{
            id: "msg-1",
            ts: Date.now(),
            author: "operator",
            kind: "chat",
            addressedTo: "hermes",
            text: "What is the blast radius?",
            relatedPr: { repo: "depre-dev/averray-reference-agent", number: 548 },
          }],
        }}
      />,
    );

    await waitFor(() => expect(getByText(/Hermes has the floor/)).toBeTruthy());
  });

  test("renders a spread of card types (mission, deploy, done)", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    expect(view.getByText("Verify onboarding flow on staging.averray.com")).toBeTruthy();
    expect(view.getByText(/Post-merge verify/)).toBeTruthy();
    expect(view.getAllByText("CLOSED").length).toBeGreaterThan(0);
  });

  test("renders saved suites with run history and dispatches re-runs", () => {
    const onRunSuite = vi.fn();
    const board: MonitorBoard = {
      at: "2026-06-02T08:00:00Z",
      cards: [],
      testbedSuites: [{
        schemaVersion: 1,
        kind: "testbed_suite",
        id: "testbed-suite-daily-sweep-1",
        name: "Daily app sweep",
        target: "https://app.averray.com/overview",
        mode: "surface_sweep",
        author: "operator",
        createdAt: "2026-06-02T07:00:00.000Z",
        updatedAt: "2026-06-02T07:30:00.000Z",
        history: [{ runId: "testbed-mission-1", verdict: "pass", ts: "2026-06-02T07:30:00.000Z" }],
        lastRun: { runId: "testbed-mission-1", verdict: "pass", ts: "2026-06-02T07:30:00.000Z" },
      }],
    };
    const { getByText, getByRole } = render(<BoardView board={board} status="open" onRunSuite={onRunSuite} keyboard={false} />);

    expect(getByText("Daily app sweep")).toBeTruthy();
    expect(getByText("pass")).toBeTruthy();
    expect(getByText("1 runs")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Run" }));
    expect(onRunSuite).toHaveBeenCalledWith("testbed-suite-daily-sweep-1");
  });

  test("promotes a launcher config into a named saved suite", () => {
    const onSpawnMission = vi.fn();
    const onSaveSuite = vi.fn();
    const board: MonitorBoard = { at: "2026-06-02T08:00:00Z", cards: [] };
    const { getByRole, getByLabelText } = render(
      <BoardView
        board={board}
        status="open"
        onSpawnMission={onSpawnMission}
        onSaveSuite={onSaveSuite}
        keyboard={false}
      />,
    );

    fireEvent.click(getByRole("button", { name: "Start a mission" }));
    fireEvent.change(getByLabelText("Target"), { target: { value: "https://app.averray.com/agents" } });
    fireEvent.click(getByLabelText(/Role Gating/));
    fireEvent.change(getByLabelText("Goal"), { target: { value: "verify role gates" } });
    fireEvent.click(getByLabelText(/Save this config as a suite/));
    fireEvent.change(getByLabelText("Suite name"), { target: { value: "Role gate sweep" } });
    fireEvent.click(getByRole("button", { name: "Launch mission" }));

    expect(onSpawnMission).toHaveBeenCalledWith({
      targetUrl: "https://app.averray.com/agents",
      mode: "siwe_auth",
      freshMemory: true,
      initialStatus: "ready",
      goal: "verify role gates",
    });
    expect(onSaveSuite).toHaveBeenCalledWith({
      name: "Role gate sweep",
      target: "https://app.averray.com/agents",
      mode: "siwe_auth",
      author: "operator",
      goal: "verify role gates",
    });
  });

  test("renders requested agent-authored suites with operator approval actions", () => {
    const onApproveSuite = vi.fn();
    const onDismissSuite = vi.fn();
    const board: MonitorBoard = {
      at: "2026-06-02T08:00:00Z",
      cards: [],
      testbedSuites: [{
        schemaVersion: 1,
        kind: "testbed_suite",
        id: "testbed-suite-settings-coverage-1",
        status: "requested",
        name: "Settings coverage gap",
        target: "https://app.averray.com/settings",
        mode: "surface_sweep",
        goal: "Check settings affordances.",
        author: "test-writer",
        requesterAgent: "test-writer",
        requestReason: "Changed surface has no saved regression suite.",
        requestedAt: "2026-06-02T07:30:00.000Z",
        createdAt: "2026-06-02T07:30:00.000Z",
        updatedAt: "2026-06-02T07:30:00.000Z",
        history: [],
      }],
    };
    const { getByRole, getByText, queryByRole } = render(
      <BoardView
        board={board}
        status="open"
        onApproveSuite={onApproveSuite}
        onDismissSuite={onDismissSuite}
        keyboard={false}
      />,
    );

    expect(getByText("Settings coverage gap")).toBeTruthy();
    expect(getByText(/test-writer requested/)).toBeTruthy();
    expect(getByText("requested")).toBeTruthy();
    expect(queryByRole("button", { name: "Run" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Approve" }));
    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(onApproveSuite).toHaveBeenCalledWith("testbed-suite-settings-coverage-1");
    expect(onDismissSuite).toHaveBeenCalledWith("testbed-suite-settings-coverage-1");
  });

  test("a calm board still expands lanes holding in-flight cards (regression: action==0 used to hide all but Done)", () => {
    const calm: MonitorBoard = {
      at: "2026-05-28T10:30:00Z",
      cards: FIXTURE_CARDS.filter((c) => c.type === "deploy" || c.type === "done"),
    };
    const { container } = render(<BoardView board={calm} status="open" />);
    // No needs-attention card → calm tone.
    expect(container.querySelector(".hm-now--calm")).toBeTruthy();
    // The deploying lane (in-flight automation) is expanded and shows its body…
    expect(within(container).getByText(/Post-merge verify/)).toBeTruthy();
    expect(container.querySelectorAll("section.hm-lane").length).toBe(2); // deploying + done
    // …and the six empty lanes are mini-rails — not everything-but-Done collapsed.
    expect(container.querySelectorAll(".hm-lane--collapsed").length).toBe(6);
  });

  test("calm banner CTA filters to today's done cards and mutes alerts for one hour", () => {
    const onMute = vi.fn();
    const board: MonitorBoard = {
      at: "2026-06-01T12:00:00.000Z",
      cards: [
        doneCard({ id: "done-today", title: "Merged today", closedAt: "2026-06-01T08:00:00.000Z" }),
        doneCard({ id: "done-old", title: "Merged yesterday", closedAt: "2026-05-31T08:00:00.000Z" }),
      ],
    };
    const { getByRole, queryByText } = render(<BoardView board={board} status="open" onMute={onMute} keyboard={false} />);

    fireEvent.click(getByRole("button", { name: /Review today/ }));
    expect(queryByText("Merged today")).toBeTruthy();
    expect(queryByText("Merged yesterday")).toBeNull();

    fireEvent.click(getByRole("button", { name: "Mute for 1 hour" }));
    expect(onMute).toHaveBeenCalledTimes(1);
    expect(onMute.mock.calls[0]?.[0]).toBeGreaterThan(Date.now() + 59 * 60_000);
  });

  test("Ask Hermes float gives immediate feedback and focuses the composer (collaboration on)", () => {
    const { getByRole, getByText } = render(
      <BoardView
        board={richBoard}
        status="open"
        keyboard={false}
        collaboration={{ fetcher: async () => [], poster: async () => {}, refreshIntervalMs: 0 }}
      />,
    );
    fireEvent.click(getByRole("button", { name: "Ask Hermes" }));
    // P0-4: the action is visibly acknowledged (transient status line)…
    expect(getByText(/Asking Hermes/)).toBeTruthy();
    // …and the (enabled) composer takes focus.
    expect(getByRole("textbox", { name: "Ask Hermes, propose a task, spawn a mission, or mute alerts" })).toBe(document.activeElement);
  });

  test("Ask Hermes is honestly unavailable when collaboration is off — but wired commands still work (no silent drop)", () => {
    // Wire a command handler (/mute) so the composer isn't Ask-only: the
    // input must stay usable for commands while the free-form Ask path is
    // honestly unavailable.
    const onMute = vi.fn();
    const { getByRole, getByText, container } = render(
      <BoardView board={richBoard} status="open" keyboard={false} onMute={onMute} />,
    );
    fireEvent.click(getByRole("button", { name: "Ask Hermes" }));
    expect(getByText(/Ask Hermes unavailable/)).toBeTruthy();
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(false);
    // A free-form question reports unavailable instead of silently dropping…
    fireEvent.change(input, { target: { value: "what's blocking?" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(getByRole("alert").textContent).toMatch(/Ask Hermes unavailable/);
    // …but a wired command still dispatches.
    fireEvent.change(input, { target: { value: "/mute 1h" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onMute).toHaveBeenCalledTimes(1);
  });

  test("Ask Hermes composer is fully disabled when it is Ask-only and collaboration is off", () => {
    // No command handlers wired → Ask-only → the input is honestly disabled.
    const { getByRole, container } = render(<BoardView board={richBoard} status="open" keyboard={false} />);
    fireEvent.click(getByRole("button", { name: "Ask Hermes" }));
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.getAttribute("aria-label")).toMatch(/Ask Hermes unavailable/);
  });

  test("an open stream lights the LIVE indicator with the snapshot clock", () => {
    const { getByText } = render(<BoardView board={richBoard} status="open" />);
    expect(getByText(/Live · 10:30:00/)).toBeTruthy();
  });

  test("automation health stays a header gauge, not a decision-lane card", () => {
    const board: MonitorBoard = {
      at: "2026-06-01T12:00:00.000Z",
      cards: [],
      automationHealth: { selfHealingOpen: 2, dispatchUsedToday: 4, dispatchPerDayCap: 5 },
    };
    const { container, getByLabelText, getByText, queryByRole } = render(
      <BoardView board={board} status="open" keyboard={false} />,
    );

    expect(getByText("Self-heal 2 open · dispatch 4/5")).toBeTruthy();
    expect(getByLabelText("Automation health: Self-heal 2 open · dispatch 4/5")).toBeTruthy();
    expect(queryByRole("article")).toBeNull();
    expect(container.querySelector(".hm-lane--needs-attention .hm-card")).toBeNull();
  });

  test("renders LLM usage when the monitor snapshot reports counters", () => {
    const board: MonitorBoard = {
      ...richBoard,
      llmUsage: {
        status: "recorded",
        inputTokens: 48_000,
        outputTokens: 9_000,
        cacheTokens: 2_000,
        totalTokens: 59_000,
        costUsd: null,
        costStatus: "not_recorded",
        runs: 12,
        lastActiveAt: "2026-05-31T10:28:00.000Z",
        message: "LLM usage includes only runner results that emitted whitelisted token counters.",
        byModel: [
          {
            agent: "claude",
            model: "claude-sonnet-4-5",
            inputTokens: 48_000,
            outputTokens: 9_000,
            cacheTokens: 2_000,
            totalTokens: 59_000,
            costUsd: null,
            costStatus: "not_recorded",
            runs: 12,
            lastActiveAt: "2026-05-31T10:28:00.000Z",
          },
        ],
        byDay: [
          {
            day: "2026-05-31",
            inputTokens: 48_000,
            outputTokens: 9_000,
            cacheTokens: 2_000,
            totalTokens: 59_000,
            costUsd: null,
            costStatus: "not_recorded",
            runs: 12,
            lastActiveAt: "2026-05-31T10:28:00.000Z",
            byModel: [],
          },
        ],
        sourceStatus: [
          { agent: "claude", status: "recorded" },
          { agent: "codex", status: "not_reported", reason: "Codex CLI does not report usage." },
        ],
        activeCalls: [
          {
            id: "call-1",
            agent: "claude",
            model: "claude-sonnet-4-5",
            taskId: "task-1",
            startedAt: "2026-05-31T10:29:00.000Z",
          },
        ],
      },
    };
    const { getAllByText, getByRole, getByText, queryByText, queryAllByText } = render(<BoardView board={board} status="open" />);
    expect(getByRole("region", { name: "LLM usage" })).toBeTruthy();
    // Collapsed by default: leads with the headline (total tokens + call count)…
    expect(getByText("59K tokens · 12 calls")).toBeTruthy();
    // …and the detail (per-source rows, idle line) is hidden until expanded.
    expect(queryByText("48K in · 9K out")).toBeNull();
    expect(queryByText(/source idle/)).toBeNull();
    // Expand the panel to reveal the active source detail + collapsed idle line.
    fireEvent.click(getByText("59K tokens · 12 calls"));
    expect(getAllByText("claude · claude-sonnet-4-5").length).toBeGreaterThan(0);
    expect(getByText("59K tokens")).toBeTruthy();
    expect(getByText("48K in · 9K out")).toBeTruthy();
    // Idle sources collapse into ONE muted line; the reason is hidden until expand.
    expect(getByText(/1 source idle: codex/)).toBeTruthy();
    expect(queryByText("Codex CLI does not report usage.")).toBeNull();
    // No flat per-source "not reported" row.
    expect(queryAllByText("not reported").length).toBe(0);
    // Expanding the idle line reveals the honest reason (truth-boundary preserved).
    fireEvent.click(getByText(/1 source idle: codex/));
    expect(getByText("Codex CLI does not report usage.")).toBeTruthy();
  });

  test("renders a plain-language usage explanation when no source emits counters", () => {
    const board: MonitorBoard = {
      ...richBoard,
      llmUsage: {
        status: "not_recorded",
        message: "No LLM usage counters have been recorded yet. Sources stay not reported until a real provider or runner emits whitelisted counters.",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: null,
        costStatus: "not_recorded",
        runs: 0,
        byModel: [],
        byDay: [],
        sourceStatus: [],
      },
    };

    const { getByRole, getByText, queryByText } = render(<BoardView board={board} status="open" />);
    expect(getByRole("region", { name: "LLM usage" })).toBeTruthy();
    // The one-line summary states "usage not reported" honestly without expanding.
    expect(getByText("usage not reported")).toBeTruthy();
    // The full plain-language explanation is reachable on expand (truth-boundary).
    fireEvent.click(getByText("usage not reported"));
    expect(getByText(/No LLM usage counters have been recorded yet/)).toBeTruthy();
    expect(queryByText("not_recorded")).toBeNull();
  });

  test("waiting-on-operator task card exposes one dispatch primary", () => {
    const onApproveTask = vi.fn();
    const board: MonitorBoard = {
      at: "2026-05-28T10:30:00Z",
      cards: [{
        id: "task-action-1",
        lane: "codex-needed",
        type: "task",
        agentType: "codex",
        title: "Fix the failed mission",
        summary: "Self-healing proposal awaiting a human dispatch call.",
        repo: "depre-dev/averray-reference-agent",
        freshness: 1,
        state: "fresh",
        risk: [],
        waitingOn: { actor: "operator", tone: "warn" },
        taskStatus: "proposed",
        prompt: "Fix the failed mission.",
      }],
    };
    const { getByRole, getByText, queryByText } = render(
      <BoardView board={board} status="open" onApproveTask={onApproveTask} keyboard={false} />,
    );
    expect(getByRole("button", { name: /Approve & dispatch/ })).toBeTruthy();
    expect(queryByText("Dismiss")).toBeNull();
    expect(queryByText("Snooze")).toBeNull();
    expect(queryByText("Investigate")).toBeNull();
    fireEvent.click(getByRole("button", { name: /Approve & dispatch/ }));
    fireEvent.click(getByRole("button", { name: /^Confirm$/ }));
    expect(onApproveTask).toHaveBeenCalledWith("task-action-1");

    expect(getByText("Fix the failed mission")).toBeTruthy();
  });

  test("renders backlog suggestions as a collapsed planner-only rail block", () => {
    const onCardClick = vi.fn();
    const { container, getByRole, getByText, queryByText } = render(
      <BoardView
        board={richBoard}
        status="open"
        onCardClick={onCardClick}
        backlogSuggestions={{
          generatedAt: "2026-05-31T12:00:00.000Z",
          safety: {
            readOnly: true,
            createsTasks: false,
            approvesTasks: false,
            mutatesGithub: false,
            mutatesSlack: false,
            mutatesTaskQueue: false,
          },
          source: { cardsRead: 1, source: "monitor_v2_board" },
          suggestions: [
            {
              id: "failed-mission:mission-1",
              title: "Follow up failed mission",
              reason: "A browser mission failed and needs a narrow fix plan.",
              suggestedOwner: "claude",
              riskTier: "low",
              related: { cardId: "mission browser-onboard-04" },
              suggestedPrompt: "Investigate the failed mission.",
              confidence: 0.82,
              evidence: ["missionVerdict:FAILED"],
            },
          ],
        }}
      />,
    );
    expect(getByRole("region", { name: "Suggested follow-ups" })).toBeTruthy();
    expect(container.querySelector(".hm-lanes-wrap .hm-backlog-suggestions")).toBeFalsy();
    const toggle = getByRole("button", { name: /Suggested follow-ups \(1\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(getByText("planner-only · read-only")).toBeTruthy();
    expect(getByText("no tasks created")).toBeTruthy();
    expect(queryByText("Follow up failed mission")).toBeFalsy();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("Follow up failed mission")).toBeTruthy();
    expect(getByRole("button", { name: "Copy prompt" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Open related card mission browser-onboard-04" }));
    expect(onCardClick).toHaveBeenCalledWith("mission browser-onboard-04");
  });

  test("Refresh button is wired to onRefresh", () => {
    const onRefresh = vi.fn();
    const { getByRole } = render(<BoardView board={richBoard} status="open" onRefresh={onRefresh} />);
    fireEvent.click(getByRole("button", { name: "Refresh board" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("BoardView — degraded + transient states", () => {
  test("a reconnecting stream swaps in the degraded top strip + UNTRUSTED banner", () => {
    const { container, getByText } = render(<BoardView board={richBoard} status="reconnecting" />);
    // BoardNow banner goes degraded…
    expect(container.querySelector(".hm-now--degraded")).toBeTruthy();
    // …and the top strip swaps to the §16 degraded header.
    expect(container.querySelector(".hm-top--degraded")).toBeTruthy();
    expect(getByText("Hermes — degraded mode")).toBeTruthy();
    expect(getByText("UNTRUSTED")).toBeTruthy();
  });

  test("a closed stream is degraded too", () => {
    const { container } = render(<BoardView board={richBoard} status="closed" />);
    expect(container.querySelector(".hm-now--degraded")).toBeTruthy();
  });

  test("no board yet (connecting) renders the calm empty layout, not degraded", () => {
    const { container, getByText } = render(<BoardView board={undefined} status="connecting" />);
    expect(container.querySelector(".hm-now--degraded")).toBeNull();
    expect(getByText(/Nothing needs you right now/)).toBeTruthy();
    // Still eight lanes, all empty.
    expect(container.querySelectorAll(".hm-lane").length).toBe(8);
  });

  test("zero-decision board renders a deliberate success empty state", () => {
    const board: MonitorBoard = { cards: [], at: "2026-06-01T10:00:00Z" };
    const { container, getByText } = render(<BoardView board={board} status="open" />);
    expect(container.querySelector(".hm-now--calm")).toBeTruthy();
    expect(container.querySelector(".hm-now--degraded")).toBeNull();
    expect(getByText(/Nothing needs you right now/)).toBeTruthy();
    expect(getByText(/The board is quiet on purpose/)).toBeTruthy();
    expect(
      getByText("No active decisions, dispatches, or release work. Hermes is watching; you can step away.", {
        selector: ".hm-now-sub",
      }),
    ).toBeTruthy();
  });
});

describe("BoardView — filter chips (G1)", () => {
  test("clicking a filter chip narrows the visible board to that state", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    // Baseline: the action card is visible.
    expect(view.getByText("Allow operator override of agent claim-stake floor")).toBeTruthy();

    // Click the "Done" filter chip (a real button now).
    const doneChip = Array.from(container.querySelectorAll(".hm-filter-chip"))
      .find((c) => c.textContent?.includes("Done")) as HTMLElement;
    expect(doneChip.tagName).toBe("BUTTON");
    fireEvent.click(doneChip);

    // The live action card is filtered out; done-lane (CLOSED) cards remain.
    expect(view.queryByText("Allow operator override of agent claim-stake floor")).toBeNull();
    expect(view.getAllByText("CLOSED").length).toBeGreaterThan(0);
    expect(doneChip.getAttribute("aria-pressed")).toBe("true");

    // Clicking "All" restores the full board.
    const allChip = Array.from(container.querySelectorAll(".hm-filter-chip"))
      .find((c) => c.textContent?.includes("All")) as HTMLElement;
    fireEvent.click(allChip);
    expect(view.getByText("Allow operator override of agent claim-stake floor")).toBeTruthy();
  });
});

function reviewCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "agent #548",
    lane: "operator-review",
    type: "pr",
    agentType: "codex",
    title: "Review relay hang fix",
    summary: "Hermes needs an operator review decision.",
    repo: "depre-dev/averray-reference-agent",
    freshness: 1,
    state: "fresh",
    risk: ["review-gated"],
    waitingOn: { actor: "operator", tone: "warn" },
    files: [],
    isAction: true,
    ...overrides,
  } as BoardCard;
}

function doneCard(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "done-today",
    lane: "done",
    type: "done",
    agentType: "codex",
    title: "Merged today",
    summary: "Merged",
    repo: "depre-dev/averray-reference-agent",
    freshness: 1,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "CI", tone: "neutral" },
    closedAt: "2026-06-01T08:00:00.000Z",
    mergeStatus: "MERGED",
    ...overrides,
  } as BoardCard;
}

describe("BoardView — keep watching (G4)", () => {
  test("'Keep watching' cancels the card's archive hint", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    // The archiveHint fixture (agent #542) shows the "Keep watching" affordance.
    const keep = view.getByRole("button", { name: "Keep watching" });
    fireEvent.click(keep);
    // The archive prompt is suppressed for that card.
    expect(view.queryByRole("button", { name: "Keep watching" })).toBeNull();
  });
});
