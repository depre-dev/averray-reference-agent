// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { KanbanBoard } from "./KanbanBoard.js";
import type { BoardCard, Lane } from "../lib/monitor/card-types.js";

afterEach(cleanup);

function card(lane: Lane, id = lane): BoardCard {
  return { id, lane, type: "pr", state: "fresh", waitingOn: { actor: "agent", tone: "neutral" } } as unknown as BoardCard;
}
function grouped(partial: Partial<Record<Lane, BoardCard[]>>): Record<Lane, BoardCard[]> {
  return {
    "needs-attention": [], drafts: [], "codex-needed": [], "hermes-checking": [],
    "operator-review": [], "release-queue": [], deploying: [], done: [],
    ...partial,
  };
}
const renderCard = (c: BoardCard) => <div className="hm-card" key={c.id}>{c.id}</div>;
// Mirror BoardView's seeding: a pipeline lane is "expanded" when it has cards.
const expandedFor = (...lanes: Lane[]) => new Set<Lane>(lanes);

describe("KanbanBoard", () => {
  test("renders a hero Decision Inbox holding the DECIDE-tier cards", () => {
    const g = grouped({ "needs-attention": [card("needs-attention", "act-1")], "codex-needed": [card("codex-needed", "t-1")] });
    const { container } = render(
      <KanbanBoard grouped={g} expanded={expandedFor("codex-needed")} onToggleLane={() => {}} renderCard={renderCard} />,
    );
    const inbox = container.querySelector('section.hm-col--inbox[data-h4-tier="decide"]') as HTMLElement;
    expect(inbox).toBeTruthy();
    expect(inbox.getAttribute("aria-label")).toBe("Your decisions lane");
    expect(within(inbox).getByText("act-1")).toBeTruthy();
    expect(within(inbox).getByText("Everything waiting on you")).toBeTruthy();
    // exactly one DECIDE column (the inbox is the only actionable surface)
    expect(container.querySelectorAll('section.hm-col[data-h4-tier="decide"]').length).toBe(1);
  });

  test("shows an honest success empty-state when nothing waits on you", () => {
    const { getByText } = render(
      <KanbanBoard grouped={grouped({ "codex-needed": [card("codex-needed")] })} expanded={expandedFor("codex-needed")} onToggleLane={() => {}} renderCard={renderCard} />,
    );
    expect(getByText("Nothing waiting on you")).toBeTruthy();
  });

  test("renders read-only WATCH/HIDE tier columns with design eyebrows", () => {
    const g = grouped({ "codex-needed": [card("codex-needed")], done: [card("done")] });
    const { getByRole } = render(
      <KanbanBoard grouped={g} expanded={expandedFor("codex-needed", "done")} onToggleLane={() => {}} renderCard={renderCard} />,
    );
    expect(getByRole("region", { name: "Builder tasks lane" })).toBeTruthy();
    expect(getByRole("region", { name: "Done lane" })).toBeTruthy();
  });

  test("hides empty non-gate lanes but keeps the operator-review gate as a reachable rail", () => {
    const { container, getByRole, queryByRole } = render(
      <KanbanBoard grouped={grouped({ "codex-needed": [card("codex-needed")] })} expanded={expandedFor("codex-needed")} onToggleLane={() => {}} renderCard={renderCard} />,
    );
    // empty non-gate (drafts, deploying, …) hide entirely
    expect(queryByRole("region", { name: "Drafts lane" })).toBeNull();
    // empty gate (operator-review) survives as a rail
    expect(getByRole("button", { name: /Runs needing review \(0 cards\)/ })).toBeTruthy();
    expect(container.querySelectorAll(".hm-col-rail").length).toBe(1);
  });

  test("a collapsed (not-expanded) non-empty lane renders as a rail that expands on click", () => {
    const onToggleLane = vi.fn();
    const g = grouped({ done: [card("done", "d1")] });
    const { getByRole } = render(
      <KanbanBoard grouped={g} expanded={expandedFor()} onToggleLane={onToggleLane} renderCard={renderCard} />,
    );
    fireEvent.click(getByRole("button", { name: /Expand Done \(1 cards\)/ }));
    expect(onToggleLane).toHaveBeenCalledWith("done");
  });

  test("the header collapse chevron toggles a pipeline lane (but the inbox has none)", () => {
    const onToggleLane = vi.fn();
    const g = grouped({ "needs-attention": [card("needs-attention")], "codex-needed": [card("codex-needed")] });
    const { getByRole, queryByRole } = render(
      <KanbanBoard grouped={g} expanded={expandedFor("codex-needed")} onToggleLane={onToggleLane} renderCard={renderCard} />,
    );
    expect(queryByRole("button", { name: /Collapse Your decisions lane/ })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Collapse Builder tasks lane" }));
    expect(onToggleLane).toHaveBeenCalledWith("codex-needed");
  });

  test("uses renderLaneHeader and renderLaneBody overrides for pipeline lanes", () => {
    const g = grouped({ "codex-needed": [card("codex-needed", "real")] });
    const { getByText, queryByText } = render(
      <KanbanBoard
        grouped={g}
        expanded={expandedFor("codex-needed")}
        onToggleLane={() => {}}
        renderCard={renderCard}
        renderLaneHeader={(lane) => (lane === "codex-needed" ? <div>＋ Propose task</div> : null)}
        renderLaneBody={(lane) => (lane === "codex-needed" ? <div>grouped body</div> : undefined)}
      />,
    );
    expect(getByText("＋ Propose task")).toBeTruthy();
    expect(getByText("grouped body")).toBeTruthy();
    // the body override replaces the default card render
    expect(queryByText("real")).toBeNull();
  });
});
