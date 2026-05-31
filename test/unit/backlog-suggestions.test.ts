import { describe, expect, it } from "vitest";

import {
  buildBacklogSuggestionsResponse,
  suggestBacklogFromCards,
} from "../../services/slack-operator/src/backlog-suggestions.js";
import type { BoardCard } from "../../services/slack-operator/src/monitor-v2.js";

function card(overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "agent #123",
    lane: "hermes-checking",
    type: "pr",
    agentType: "claude",
    title: "Polish onboarding layout",
    summary: "All checks passing",
    repo: "depre-dev/agent",
    freshness: 8,
    state: "fresh",
    risk: ["ui-only"],
    waitingOn: { actor: "agent", tone: "info" },
    ...overrides,
  } as BoardCard;
}

describe("backlog suggestions", () => {
  it("returns no suggestions for an empty or healthy board", () => {
    expect(suggestBacklogFromCards([])).toEqual([]);
    expect(suggestBacklogFromCards([
      card(),
      card({ id: "agent #124", type: "done", lane: "done" }),
    ])).toEqual([]);
  });

  it("turns a failed mission into a product-fix prompt without mutating", () => {
    const suggestions = suggestBacklogFromCards([
      card({
        id: "mission onboarding-001",
        type: "mission",
        agentType: "hermes",
        title: "Fresh-agent onboarding mission",
        risk: ["testbed"],
        mission: {
          verdict: "FAILED",
          verdictTone: "fail",
          confidence: 0.88,
          target: "https://app.averray.com/onboarding",
          seed: "fresh",
          path: [],
          blockers: [{ head: "Wallet copy unclear", body: "The page did not explain the required signer." }],
          evidence: [],
          mutationBoundary: "Read-only mission",
          recommendations: ["Clarify the signer step."],
        },
      }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      suggestedOwner: "claude",
      riskTier: "low",
      related: {
        cardId: "mission onboarding-001",
        missionTarget: "https://app.averray.com/onboarding",
        missionVerdict: "FAILED",
      },
    });
    expect(suggestions[0]?.suggestedPrompt).toContain("Investigate and propose a product fix");
    expect(suggestions[0]?.evidence).toContain("missionVerdict:FAILED");
  });

  it("keeps stale drafts with the operator instead of auto-routing Codex", () => {
    const suggestions = suggestBacklogFromCards([
      card({
        id: "agent #777",
        type: "draft",
        lane: "drafts",
        title: "Draft governance policy cleanup",
        isDraft: true,
        freshness: 60 * 30,
        state: "stale",
        waitingOn: { actor: "author", tone: "neutral" },
      }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      suggestedOwner: "operator",
      riskTier: "low",
    });
    expect(suggestions[0]?.suggestedPrompt).toBeUndefined();
    expect(suggestions[0]?.reason).toContain("explicitly approve a takeover");
  });

  it("escalates high-risk cards to operator review, not an agent", () => {
    const suggestions = suggestBacklogFromCards([
      card({
        id: "agent #900",
        risk: ["contracts"],
        files: [{ path: "contracts/EscrowCore.sol", diff: "+8 -2", critical: true }],
      }),
    ]);

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      suggestedOwner: "operator",
      riskTier: "high",
    });
    expect(suggestions[0]?.suggestedPrompt).toBeUndefined();
    expect(suggestions[0]?.evidence).toContain("criticalFile:contracts/EscrowCore.sol");
  });

  it("returns read-only endpoint safety metadata", () => {
    const response = buildBacklogSuggestionsResponse([], {
      now: new Date("2026-05-31T12:00:00.000Z"),
    });

    expect(response).toEqual({
      generatedAt: "2026-05-31T12:00:00.000Z",
      suggestions: [],
      safety: {
        readOnly: true,
        createsTasks: false,
        approvesTasks: false,
        mutatesGithub: false,
        mutatesSlack: false,
        mutatesTaskQueue: false,
      },
      source: {
        cardsRead: 0,
        source: "monitor_v2_board",
      },
    });
  });
});
