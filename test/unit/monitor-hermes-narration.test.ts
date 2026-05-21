import { describe, expect, it } from "vitest";

import {
  buildHermesBoardNarrationSignature,
  decideHermesBoardNarration,
  fallbackHermesBoardNarration,
  relatedPrForHermesBoardNarration,
  targetForHermesBoardNarration,
} from "../../services/slack-operator/src/monitor-hermes-narration.js";
import type { HermesBoardSnapshot } from "../../services/slack-operator/src/monitor-hermes-voice.js";

function board(overrides: Partial<HermesBoardSnapshot> = {}): HermesBoardSnapshot {
  return {
    headline: "Board now: 1 draft parked; 1 operator decision.",
    counts: { waiting: 1, operator: 1, recent: 20 },
    items: [
      {
        repo: "averray-agent/agent",
        number: 439,
        title: "PR is still marked as draft.",
        lane: "Waiting / Drafts",
        owner: "PR author",
        verdict: "draft",
        why: "GitHub reports this PR is still a draft.",
        next: "wait for the PR author unless Pascal explicitly delegates takeover",
      },
    ],
    ...overrides,
  };
}

describe("Hermes proactive board narration", () => {
  it("builds a stable signature that ignores freshness-only fields", () => {
    const first = buildHermesBoardNarrationSignature(board({
      generatedAt: "2026-05-21T08:00:00.000Z",
      items: [{ ...board().items![0], ageLabel: "fresh" }],
    }));
    const second = buildHermesBoardNarrationSignature(board({
      generatedAt: "2026-05-21T08:05:00.000Z",
      items: [{ ...board().items![0], ageLabel: "5m" }],
    }));
    expect(first).toBe(second);
    expect(first).toContain("Waiting / Drafts");
    expect(first).toContain("averray-agent/agent");
  });

  it("does not narrate unchanged or in-flight board state", () => {
    const signature = buildHermesBoardNarrationSignature(board());
    expect(decideHermesBoardNarration(board(), signature, "")).toMatchObject({
      shouldNarrate: false,
      reason: "unchanged",
    });
    expect(decideHermesBoardNarration(board(), "", signature)).toMatchObject({
      shouldNarrate: false,
      reason: "already_in_flight",
    });
  });

  it("narrates a new actionable board state", () => {
    const decision = decideHermesBoardNarration(board(), "", "");
    expect(decision.shouldNarrate).toBe(true);
    expect(decision.signature).toContain("waiting=1");
  });

  it("targets the current owner without pretending to message external PR authors", () => {
    expect(targetForHermesBoardNarration(board())).toBe("operator");
    expect(targetForHermesBoardNarration(board({
      counts: { codex: 1 },
      items: [{ ...board().items![0], lane: "Codex Needed", owner: "Codex", verdict: "delegated draft" }],
    }))).toBe("codex");
  });

  it("attaches relatedPr only for a single actionable PR", () => {
    expect(relatedPrForHermesBoardNarration(board())).toEqual({ repo: "averray-agent/agent", number: 439 });
    expect(relatedPrForHermesBoardNarration(board({
      items: [
        board().items![0],
        { repo: "averray-reference-agent", number: 179, title: "Operator review", lane: "Operator Review", owner: "Operator" },
      ],
    }))).toBeUndefined();
  });

  it("falls back to a conversational explanation when the LLM is unavailable", () => {
    const text = fallbackHermesBoardNarration(board());
    expect(text).toContain("averray-agent/agent#439");
    expect(text).toContain("Waiting / Drafts");
    expect(text).toContain("release path");
    expect(text).toContain("delegates takeover");
  });
});
