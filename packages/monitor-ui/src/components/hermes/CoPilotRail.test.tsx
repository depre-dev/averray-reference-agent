// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CoPilotRail } from "./CoPilotRail.js";
import { FIXTURE_CARDS } from "../../lib/monitor/fixtures.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";
import type { CollaborationMessage } from "../../lib/monitor/collaboration.js";
import type { BoardNowBanner } from "../../lib/monitor/board-state.js";

afterEach(cleanup);

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function msg(
  id: string,
  author: CollaborationMessage["author"],
  text: string,
  overrides: Partial<CollaborationMessage> = {},
): CollaborationMessage {
  return {
    id,
    ts: Date.parse("2026-05-28T10:00:00Z"),
    author,
    kind: "chat",
    text,
    addressedTo: "everyone",
    ...overrides,
  };
}

const card548 = FIXTURE_CARDS.find((c) => c.id === "agent #548") as BoardCard;
const banner: BoardNowBanner = {
  tone: "action",
  eyebrow: "Board now",
  headline: "1 card needs your review decision; automation has gone as far as it safely can.",
  sub: "Most urgent: agent #548.",
  primaryActionId: "agent #548",
};

describe("CoPilotRail", () => {
  test("renders the collaboration feed as turns", async () => {
    const fetcher = vi.fn(async () => [msg("1", "hermes", "Pre-check passed on #548.")]);
    const { container } = render(<CoPilotRail collaboration={{ fetcher, refreshIntervalMs: 0 }} />, { wrapper });
    await waitFor(() => expect(within(container).getByText(/Pre-check passed on #548/)).toBeTruthy());
    expect(within(container).getAllByText("Hermes").length).toBeGreaterThan(0);
    expect(within(container).getAllByText(/reply/).length).toBeGreaterThan(0);
    expect(container.querySelector(".hm-turn-time")).toBeTruthy();
  });

  test("shows one template-mode banner and labels offline Hermes replies", async () => {
    const fetcher = vi.fn(async () => [
      msg("1", "hermes", "Template answer from the board.", { hermesMode: "templated" }),
      msg("2", "hermes", "Another template answer.", { hermesMode: "templated" }),
    ]);
    const { container } = render(<CoPilotRail collaboration={{ fetcher, refreshIntervalMs: 0 }} />, { wrapper });
    await waitFor(() => expect(within(container).getByText(/Template answer from the board/)).toBeTruthy());
    expect(within(container).getAllByText("Hermes (offline — templated)").length).toBeGreaterThan(0);
    expect(within(container).getAllByText(/replies are templated/)).toHaveLength(1);
  });

  test("is inert (no fetch, empty-state copy) when collaboration is omitted", () => {
    const { getByText } = render(<CoPilotRail />, { wrapper });
    expect(getByText(/No real Hermes activity has been logged yet/)).toBeTruthy();
  });

  test("the scope chip reflects the focused card", async () => {
    const { getByText } = render(
      <CoPilotRail focusedCard={card548} collaboration={{ fetcher: async () => [], refreshIntervalMs: 0 }} />,
      { wrapper },
    );
    expect(getByText("scope · agent #548")).toBeTruthy();
  });

  test("asking a question scoped to the focused card posts relatedPr and renders the reply", async () => {
    let turns: CollaborationMessage[] = [];
    const fetcher = vi.fn(async () => turns);
    const poster = vi.fn(async () => {
      turns = [msg("q", "operator", "what's blocking?"), msg("a", "hermes", "CI is still running — 1 check left.")];
    });

    const { container } = render(
      <CoPilotRail focusedCard={card548} collaboration={{ fetcher, poster, refreshIntervalMs: 0 }} />,
      { wrapper },
    );
    await waitFor(() => expect(within(container).getByText(/No real Hermes activity has been logged yet/)).toBeTruthy());

    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "what's blocking?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(poster).toHaveBeenCalledWith({
      text: "what's blocking?",
      relatedPr: { repo: "depre-dev/agent", number: 548 },
    });
    // Hermes's reply lands on the revalidate triggered by ask().
    await waitFor(() =>
      expect(within(container).getByText(/CI is still running/)).toBeTruthy(),
    );
  });

  test("/mission spawn still flows through the composer", () => {
    const onSpawnMission = vi.fn();
    const { container } = render(
      <CoPilotRail onSpawnMission={onSpawnMission} collaboration={{ fetcher: async () => [], refreshIntervalMs: 0 }} />,
      { wrapper },
    );
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/mission https://staging.averray.com/x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSpawnMission).toHaveBeenCalledWith("https://staging.averray.com/x");
  });

  test("shows proactive board activity and links it back to a card", () => {
    const onCardClick = vi.fn();
    const taskCard: BoardCard = {
      ...card548,
      id: "task-activity-1",
      type: "task",
      agentType: "codex",
      title: "Repair failed mission",
      summary: "Hermes self-healing proposal for a failed testbed mission.",
      lane: "codex-needed",
      prompt: "Repair the failed mission.",
      taskStatus: "proposed",
      riskTier: "low",
    };
    const { container, getAllByText, getByText, getByRole } = render(
      <CoPilotRail
        boardCards={[taskCard]}
        boardBanner={banner}
        onCardClick={onCardClick}
        collaboration={{ fetcher: async () => [], refreshIntervalMs: 0 }}
      />,
      { wrapper },
    );
    expect(getByText(/Proposed Codex work for Repair failed mission/)).toBeTruthy();
    expect(getAllByText(/narration/).length).toBeGreaterThan(0);
    fireEvent.click(getByRole("button", { name: "Open referenced card task-activity-1" }));
    expect(onCardClick).toHaveBeenCalledWith("task-activity-1");
    fireEvent.click(getByRole("button", { name: "Why this route?" }));
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    expect(input.value).toBe("Why this route?");
  });

  test("card-scoped collaboration messages render with a real card pin", async () => {
    const onCardClick = vi.fn();
    const fetcher = vi.fn(async () => [
      msg("operator-question", "operator", "What is still blocking this?", {
        relatedPr: { repo: "depre-dev/agent", number: 548 },
      }),
    ]);
    const { container, getByRole } = render(
      <CoPilotRail
        boardCards={[card548]}
        onCardClick={onCardClick}
        collaboration={{ fetcher, refreshIntervalMs: 0 }}
      />,
      { wrapper },
    );
    await waitFor(() => expect(within(container).getByText(/What is still blocking this/)).toBeTruthy());
    expect(within(container).getByText("Pascal")).toBeTruthy();
    expect(within(container).getByText(/question/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Open referenced card agent #548" }));
    expect(onCardClick).toHaveBeenCalledWith("agent #548");
  });
});

describe("CoPilotRail — G3 suggestion → composer", () => {
  test("'Use in composer' fills the Ask-Hermes input with the suggested prompt", () => {
    const backlogSuggestions = {
      generatedAt: "2026-06-01T00:00:00Z",
      suggestions: [
        {
          id: "sug-1",
          title: "Add a regression test for the claim flow",
          reason: "the last mission flagged it",
          suggestedOwner: "test-writer" as const,
          riskTier: "low" as const,
          related: { cardId: "agent #548" },
          suggestedPrompt: "Write a vitest covering the claim-stake floor override",
          confidence: 0.7,
        },
      ],
    };
    const { container, getByText } = render(
      <CoPilotRail backlogSuggestions={backlogSuggestions} boardCards={[card548]} />,
      { wrapper },
    );
    // Open the suggestions block, then click "Use in composer".
    fireEvent.click(getByText(/Suggested follow-ups/));
    fireEvent.click(getByText("Use in composer"));
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    expect(input.value).toBe("Write a vitest covering the claim-stake floor override");
  });
});
