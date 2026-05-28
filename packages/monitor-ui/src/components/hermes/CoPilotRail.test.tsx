// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { CoPilotRail } from "./CoPilotRail.js";
import { FIXTURE_CARDS } from "../../lib/monitor/fixtures.js";
import type { BoardCard } from "../../lib/monitor/card-types.js";
import type { CollaborationMessage } from "../../lib/monitor/collaboration.js";

afterEach(cleanup);

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function msg(id: string, author: CollaborationMessage["author"], text: string): CollaborationMessage {
  return { id, ts: Date.parse("2026-05-28T10:00:00Z"), author, kind: "chat", text, addressedTo: "everyone" };
}

const card548 = FIXTURE_CARDS.find((c) => c.id === "agent #548") as BoardCard;

describe("CoPilotRail", () => {
  test("renders the collaboration feed as turns", async () => {
    const fetcher = vi.fn(async () => [msg("1", "hermes", "Pre-check passed on #548.")]);
    const { container } = render(<CoPilotRail collaboration={{ fetcher, refreshIntervalMs: 0 }} />, { wrapper });
    await waitFor(() => expect(within(container).getByText("Pre-check passed on #548.")).toBeTruthy());
  });

  test("is inert (no fetch, empty-state copy) when collaboration is omitted", () => {
    const { getByText } = render(<CoPilotRail />, { wrapper });
    expect(getByText("No board chatter yet.")).toBeTruthy();
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
    await waitFor(() => expect(within(container).getByText("No board chatter yet.")).toBeTruthy());

    const input = container.querySelector(".hm-compose-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "what's blocking?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(poster).toHaveBeenCalledWith({
      text: "what's blocking?",
      relatedPr: { repo: "depre-dev/agent", number: 548 },
    });
    // Hermes's reply lands on the revalidate triggered by ask().
    await waitFor(() =>
      expect(within(container).getByText("CI is still running — 1 check left.")).toBeTruthy(),
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
});
