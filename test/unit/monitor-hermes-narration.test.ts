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

  it("lets memory shape fallback narration when the LLM is unavailable", () => {
    const text = fallbackHermesBoardNarration(board(), {
      memoryNotes: [
        "Pascal preference: external agent draft PRs should wait unless Pascal explicitly delegates takeover.",
      ],
    });

    expect(text).toContain("remembered draft rule");
    expect(text).toContain("unless Pascal explicitly delegates takeover");
  });

  it("coaches operator-review decisions in fallback narration", () => {
    const text = fallbackHermesBoardNarration(board({
      counts: { operator: 1 },
      items: [
        {
          repo: "averray-reference-agent",
          number: 183,
          title: "2 changed files touch review-gated surfaces.",
          lane: "Operator Review",
          owner: "Operator",
          verdict: "needs review",
          why: "Hermes has already done the code-level pre-check.",
          next: "decide whether project intent and rollout risk are acceptable",
        },
      ],
    }));

    expect(text).toContain("project-level decision");
    expect(text).toContain("button opens the operator checklist");
    expect(text).toContain("approval is a local monitor sign-off, not a merge");
    expect(text).toContain("Safest next step");
    expect(text).toContain("send it back to Codex with a concrete ask");
  });

  it("coaches release queue decisions without implying the monitor merges", () => {
    const text = fallbackHermesBoardNarration(board({
      counts: { queue: 1 },
      items: [
        {
          repo: "averray-agent/agent",
          number: 440,
          title: "Live GitHub PR metadata and checks look merge-ready.",
          lane: "Release Queue",
          owner: "Merge steward",
          verdict: "ready",
          why: "Live GitHub PR metadata and checks look merge-ready.",
          next: "merge only after branch protection is green",
        },
      ],
    }));

    expect(text).toContain("button asks for merge-steward context");
    expect(text).toContain("it does not merge the PR");
    expect(text).toContain("branch protection is green");
  });
});
