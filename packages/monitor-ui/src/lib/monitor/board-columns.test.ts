import { describe, expect, it } from "vitest";
import {
  BOARD_COLUMNS,
  columnTier,
  columnVisibility,
  inboxCards,
  tierLabel,
  type BoardColumnDef,
} from "./board-columns.js";
import type { BoardCard, Lane } from "./card-types.js";

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

const col = (id: string): BoardColumnDef => BOARD_COLUMNS.find((c) => c.id === id)!;

describe("BOARD_COLUMNS", () => {
  it("leads with the inbox hero and maps the remaining seven lanes (no needs-attention pipeline column)", () => {
    expect(BOARD_COLUMNS[0]?.inbox).toBe(true);
    expect(BOARD_COLUMNS[0]?.name).toBe("Your decisions");
    expect(BOARD_COLUMNS.length).toBe(8);
    const pipelineLanes = BOARD_COLUMNS.filter((c) => !c.inbox).map((c) => c.lane);
    expect(pipelineLanes).not.toContain("needs-attention"); // folded into the inbox
    expect(pipelineLanes).toContain("operator-review");
    expect(pipelineLanes).toContain("done");
  });

  it("carries the design eyebrows for the named columns", () => {
    expect(col("codex-needed").name).toBe("Builder tasks");
    expect(col("operator-review").name).toBe("Runs needing review");
    expect(col("deploying").name).toBe("Deploying");
    expect(col("done").name).toBe("Done");
    expect(col("inbox").sub).toBe("Everything waiting on you");
  });

  it("marks the inbox and operator-review as gate lanes", () => {
    expect(col("inbox").gate).toBe(true);
    expect(col("operator-review").gate).toBe(true);
    expect(col("done").gate).toBeUndefined();
  });
});

describe("columnTier / tierLabel", () => {
  it("puts the inbox in DECIDE and pipeline columns on tierFor", () => {
    expect(columnTier(col("inbox"))).toBe("decide");
    expect(columnTier(col("codex-needed"))).toBe("watch");
    expect(columnTier(col("done"))).toBe("hide");
  });

  it("labels tiers for the column eyebrow", () => {
    expect(tierLabel("decide")).toBe("Decide");
    expect(tierLabel("watch")).toBe("Watch");
    expect(tierLabel("hide")).toBe("Hide");
  });
});

describe("inboxCards", () => {
  it("unions every DECIDE-tier lane's cards (currently needs-attention)", () => {
    const g = grouped({
      "needs-attention": [card("needs-attention", "a1"), card("needs-attention", "a2")],
      "operator-review": [card("operator-review", "o1")],
    });
    const ids = inboxCards(g).map((c) => c.id);
    expect(ids).toEqual(["a1", "a2"]);
    // operator-review is WATCH-tier → not folded into the inbox.
    expect(ids).not.toContain("o1");
  });

  it("is empty when no decide-tier card exists", () => {
    expect(inboxCards(grouped({ done: [card("done")] }))).toEqual([]);
  });
});

describe("columnVisibility", () => {
  const expanded = new Set<Lane>(["codex-needed"]);

  it("always shows the inbox as a full column", () => {
    expect(columnVisibility(col("inbox"), 0, new Set())).toBe("column");
  });

  it("hides an empty non-gate pipeline lane", () => {
    expect(columnVisibility(col("drafts"), 0, expanded)).toBe("hidden");
  });

  it("keeps an empty GATE lane as a reachable rail", () => {
    expect(columnVisibility(col("operator-review"), 0, expanded)).toBe("rail");
  });

  it("shows an expanded lane as a column and a collapsed one as a rail", () => {
    expect(columnVisibility(col("codex-needed"), 3, expanded)).toBe("column");
    expect(columnVisibility(col("deploying"), 3, expanded)).toBe("rail");
  });
});
