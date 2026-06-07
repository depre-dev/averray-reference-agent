// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PipelineMirrorCard } from "./PipelineMirrorCard.js";
import type { BoardCard } from "../lib/monitor/card-types.js";

afterEach(cleanup);

function mk(over: Record<string, unknown>): BoardCard {
  return {
    id: "agent #1", lane: "operator-review", type: "pr", agentType: "codex",
    title: "Card title", summary: "", repo: "owner/repo", freshness: 5, state: "fresh",
    risk: [], waitingOn: { actor: "agent", tone: "neutral" }, files: [],
    ...over,
  } as unknown as BoardCard;
}

describe("PipelineMirrorCard — PR-F2 done passive state", () => {
  test("a done/verified card is a passive VERIFIED mirror — no 'awaiting decision' jump", () => {
    const onJumpToInbox = vi.fn();
    const done = mk({
      id: "agent #538", type: "done", lane: "done", title: "Shipped last week",
      closedAt: "2026-05-27", mergeStatus: "MERGED",
      // a stale operator flag left over from its active life must NOT resurrect a jump
      waitingOn: { actor: "operator", tone: "warn" },
    });
    const { container, queryByText } = render(
      <PipelineMirrorCard card={done} tier="hide" inboxAvailable onJumpToInbox={onJumpToInbox} />,
    );
    expect(container.querySelector(".hm-pipeline-card--verified")).toBeTruthy();
    expect(container.textContent).toMatch(/VERIFIED/);
    expect(container.querySelector(".hm-pipeline-card-jump")).toBeNull();
    expect(queryByText(/Awaiting your decision/)).toBeNull();
    expect(container.querySelector(".is-awaiting-inbox")).toBeNull();
  });

  test("a card with a live operator decision keeps the jump-to-inbox affordance", () => {
    const onJumpToInbox = vi.fn();
    const live = mk({ lane: "operator-review", waitingOn: { actor: "operator", tone: "warn" } });
    const { container, getByRole } = render(
      <PipelineMirrorCard card={live} tier="watch" inboxAvailable onJumpToInbox={onJumpToInbox} />,
    );
    expect(container.querySelector(".is-awaiting-inbox")).toBeTruthy();
    const jump = getByRole("button");
    expect(jump.textContent).toMatch(/Awaiting your decision in inbox/);
    fireEvent.click(jump);
    expect(onJumpToInbox).toHaveBeenCalledWith(live);
  });

  test("no jump affordance when the inbox is unavailable, even for a live decision", () => {
    const live = mk({ lane: "operator-review", waitingOn: { actor: "operator", tone: "warn" } });
    const { container } = render(
      <PipelineMirrorCard card={live} tier="watch" inboxAvailable={false} onJumpToInbox={() => {}} />,
    );
    expect(container.querySelector(".hm-pipeline-card-jump")).toBeNull();
  });
});
