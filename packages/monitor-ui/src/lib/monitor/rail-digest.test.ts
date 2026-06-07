import { describe, expect, it } from "vitest";
import { railDigestCounts } from "./rail-digest.js";
import type { BoardCard } from "./card-types.js";

function c(over: Record<string, unknown>): BoardCard {
  return { id: "c", type: "pr", state: "fresh", waitingOn: { actor: "agent", tone: "neutral" }, ...over } as unknown as BoardCard;
}

describe("railDigestCounts", () => {
  it("counts needs-you from real operator decisions only (PR-F1 isDecision)", () => {
    const counts = railDigestCounts([
      c({ lane: "operator-review", waitingOn: { actor: "operator", tone: "warn" } }), // decision
      c({ isAction: true, waitingOn: { actor: "operator", tone: "warn" } }),          // decision
      c({ waitingOn: { actor: "CI", tone: "info" } }),                                 // not a decision
    ]);
    expect(counts.needsYou).toBe(2);
  });

  it("excludes done / verified / closed release history from the count (truth-boundary)", () => {
    const counts = railDigestCounts([
      c({ isAction: true, waitingOn: { actor: "operator", tone: "warn" } }),
      // finished release-history card that still carries the operator flag
      c({ type: "done", isAction: true, closedAt: "5/27/2026", mergeStatus: "MERGED", waitingOn: { actor: "operator", tone: "warn" } }),
    ]);
    expect(counts.needsYou).toBe(1);
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
