import { describe, expect, it } from "vitest";
import { railDigestCounts } from "./rail-digest.js";
import type { BoardCard } from "./card-types.js";

function c(over: Record<string, unknown>): BoardCard {
  return { id: "c", type: "pr", state: "fresh", waitingOn: { actor: "agent", tone: "neutral" }, ...over } as unknown as BoardCard;
}

describe("railDigestCounts", () => {
  it("counts needs-you from operator-waiting / action cards", () => {
    const counts = railDigestCounts([
      c({ waitingOn: { actor: "operator", tone: "warn" } }),
      c({ isAction: true }),
      c({ waitingOn: { actor: "CI", tone: "info" } }),
    ]);
    expect(counts.needsYou).toBe(2);
  });

  it("counts running from state, mission status, or workingNow", () => {
    const counts = railDigestCounts([
      c({ state: "running" }),
      c({ type: "mission", missionStatus: "running" }),
      c({ workingNow: { agent: "codex", label: "fixing", source: "runner" } }),
      c({ state: "fresh" }),
    ]);
    expect(counts.running).toBe(3);
  });

  it("is all-zero for an empty board", () => {
    expect(railDigestCounts([])).toEqual({ needsYou: 0, running: 0 });
  });
});
