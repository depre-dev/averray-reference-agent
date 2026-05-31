// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { BoardView } from "./BoardView.js";
import { FIXTURE_CARDS } from "../lib/monitor/fixtures.js";
import type { MonitorBoard } from "../lib/monitor/board-cache.js";

afterEach(cleanup);

const richBoard: MonitorBoard = { cards: FIXTURE_CARDS, at: "2026-05-28T10:30:00Z" };

describe("BoardView — rich-mix board (open stream)", () => {
  test("renders the full board chrome end-to-end", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    expect(view.getByRole("banner")).toBeTruthy();
    expect(view.getByText("Hermes")).toBeTruthy();
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

  test("renders the action card with its CTA and Hermes verdict", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    expect(view.getByText("Allow operator override of agent claim-stake floor")).toBeTruthy();
    expect(view.getByText("Approve & merge")).toBeTruthy();
    expect(view.getByText("Hermes verdict")).toBeTruthy();
  });

  test("renders a spread of card types (mission, deploy, done)", () => {
    const { container } = render(<BoardView board={richBoard} status="open" />);
    const view = within(container);
    expect(view.getByText("Verify onboarding flow on staging.averray.com")).toBeTruthy();
    expect(view.getByText(/Post-merge verify/)).toBeTruthy();
    expect(view.getAllByText("CLOSED").length).toBeGreaterThan(0);
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

  test("an open stream lights the LIVE indicator with the snapshot clock", () => {
    const { getByText } = render(<BoardView board={richBoard} status="open" />);
    expect(getByText(/Live · 10:30:00/)).toBeTruthy();
  });

  test("renders LLM usage when the monitor snapshot reports counters", () => {
    const board: MonitorBoard = {
      ...richBoard,
      llmUsage: {
        status: "recorded",
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        costUsd: null,
        costStatus: "not_recorded",
        runs: 1,
        byModel: [],
        byDay: [
          {
            day: "2026-05-31",
            inputTokens: 100,
            outputTokens: 40,
            totalTokens: 140,
            costUsd: null,
            costStatus: "not_recorded",
            runs: 1,
            byModel: [
              {
                agent: "codex",
                model: "gpt-5-codex",
                inputTokens: 100,
                outputTokens: 40,
                totalTokens: 140,
                costUsd: null,
                costStatus: "not_recorded",
                runs: 1,
              },
            ],
          },
        ],
      },
    };
    const { getByRole, getByText } = render(<BoardView board={board} status="open" />);
    expect(getByRole("region", { name: "LLM usage" })).toBeTruthy();
    expect(getByText("2026-05-31")).toBeTruthy();
    expect(getByText("140 tokens")).toBeTruthy();
    expect(getByText("gpt-5-codex")).toBeTruthy();
    expect(getByText("not_recorded")).toBeTruthy();
  });

  test("renders backlog suggestions as planner-only read-only prompts", () => {
    const { getByRole, getByText } = render(
      <BoardView
        board={richBoard}
        status="open"
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
              related: { cardId: "mission-1" },
              suggestedPrompt: "Investigate the failed mission.",
              confidence: 0.82,
              evidence: ["missionVerdict:FAILED"],
            },
          ],
        }}
      />,
    );
    expect(getByRole("region", { name: "Suggested follow-ups" })).toBeTruthy();
    expect(getByText("planner-only · read-only")).toBeTruthy();
    expect(getByText("no tasks created")).toBeTruthy();
    expect(getByText("Follow up failed mission")).toBeTruthy();
    expect(getByRole("button", { name: "Copy prompt" })).toBeTruthy();
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
    expect(getByText(/Nothing waits on you/)).toBeTruthy();
    // Still eight lanes, all empty.
    expect(container.querySelectorAll(".hm-lane").length).toBe(8);
  });
});
