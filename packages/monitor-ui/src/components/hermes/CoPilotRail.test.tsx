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
    expect(within(container).getByText("Hermes → everyone")).toBeTruthy();
    expect(within(container).getAllByText(/chat/).length).toBeGreaterThan(0);
    expect(container.querySelector(".hm-turn-time")).toBeTruthy();
  });

  test("shows one template-mode banner and labels offline Hermes replies", async () => {
    const fetcher = vi.fn(async () => [
      msg("1", "hermes", "Template answer from the board.", { hermesMode: "templated" }),
      msg("2", "hermes", "Another template answer.", { hermesMode: "templated" }),
    ]);
    const { container } = render(<CoPilotRail collaboration={{ fetcher, refreshIntervalMs: 0 }} />, { wrapper });
    await waitFor(() => expect(within(container).getByText(/Template answer from the board/)).toBeTruthy());
    expect(within(container).getAllByText("Hermes (offline — templated) → everyone").length).toBeGreaterThan(0);
    expect(within(container).getAllByText(/replies are templated/)).toHaveLength(1);
  });

  test("is inert (no fetch, empty-state copy) when collaboration is omitted", () => {
    const { getByText } = render(<CoPilotRail />, { wrapper });
    expect(getByText("No agent chatter yet.")).toBeTruthy();
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
    await waitFor(() => expect(within(container).getByText("No agent chatter yet.")).toBeTruthy());

    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "what's blocking?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(poster).toHaveBeenCalledWith({
      text: "what's blocking?",
      addressedTo: "everyone",
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
    // PR-D3: the mutating /mission stages a Confirm gate before it fires.
    fireEvent.click(within(container).getByRole("button", { name: "Confirm" }));
    expect(onSpawnMission).toHaveBeenCalledWith("https://staging.averray.com/x");
  });

  test("shows the current board summary and links it back to a card", () => {
    const onCardClick = vi.fn();
    const { getByText, getByRole } = render(
      <CoPilotRail
        boardCards={[card548]}
        boardBanner={banner}
        onCardClick={onCardClick}
        collaboration={{ fetcher: async () => [], refreshIntervalMs: 0 }}
      />,
      { wrapper },
    );
    expect(getByText(/Needs you:/)).toBeTruthy();
    expect(getByText(/Operator review is waiting on agent #548/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Open referenced card agent #548" }));
    expect(onCardClick).toHaveBeenCalledWith("agent #548");
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
    expect(within(container).getByText("You → everyone")).toBeTruthy();
    expect(within(container).getAllByText(/chat/).length).toBeGreaterThan(0);
    fireEvent.click(getByRole("button", { name: "Open referenced card agent #548" }));
    expect(onCardClick).toHaveBeenCalledWith("agent #548");
  });

  test("renders a multi-agent room with directed turns and kind ranking", async () => {
    const fetcher = vi.fn(async () => [
      msg("codex-help", "codex", "Need a second read on the deploy edge.", {
        kind: "request_help",
        addressedTo: "claude",
      }),
      msg("claude-status", "claude", "I am reading the trace.", {
        kind: "status",
        addressedTo: "hermes",
      }),
      msg("tester-proposal", "test-writer", "Add a browser auth regression.", {
        kind: "proposal",
        addressedTo: "everyone",
      }),
      msg("security-chat", "security", "Secrets stay isolated.", { addressedTo: "docs" }),
      msg("docs-chat", "docs", "Runbook note is ready.", { addressedTo: "operator" }),
      msg("system-chat", "system", "Board snapshot refreshed.", { addressedTo: "everyone" }),
    ]);
    const { container } = render(<CoPilotRail collaboration={{ fetcher, refreshIntervalMs: 0 }} />, { wrapper });
    await waitFor(() => expect(within(container).getByText("Codex → Claude")).toBeTruthy());
    expect(within(container).getByText("Claude → Hermes")).toBeTruthy();
    expect(within(container).getByText("Test-writer → everyone")).toBeTruthy();
    expect(within(container).getByText("Security → Docs")).toBeTruthy();
    expect(within(container).getByText("Docs → You")).toBeTruthy();
    expect(within(container).getByText("System → everyone")).toBeTruthy();
    expect(container.querySelector(".hm-turn--kind-request_help")?.className).toContain("hm-turn--rank-prominent");
    expect(container.querySelector(".hm-turn--kind-status")?.className).toContain("hm-turn--rank-muted");
  });

  test("threads collaboration turns by their related card/task reference", async () => {
    const onCardClick = vi.fn();
    const fetcher = vi.fn(async () => [
      msg("operator-question", "operator", "Can this move?", {
        relatedPr: { repo: "depre-dev/agent", number: 548 },
      }),
      msg("hermes-reply", "hermes", "It needs one more review.", {
        addressedTo: "operator",
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
    await waitFor(() => expect(within(container).getByText("Thread · depre-dev/agent #548")).toBeTruthy());
    expect(within(container).getByText("2 turns")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Open referenced card agent #548" }));
    expect(onCardClick).toHaveBeenCalledWith("agent #548");
  });

  test("the composer can address a specific agent through the collaboration target field", async () => {
    const poster = vi.fn(async () => undefined);
    const { container, getByLabelText } = render(
      <CoPilotRail collaboration={{ fetcher: async () => [], poster, refreshIntervalMs: 0 }} />,
      { wrapper },
    );
    const target = getByLabelText("Message target") as HTMLSelectElement;
    fireEvent.change(target, { target: { value: "codex" } });
    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "please inspect this" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(poster).toHaveBeenCalledWith({
      text: "please inspect this",
      addressedTo: "codex",
    });
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
