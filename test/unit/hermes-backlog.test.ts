import { describe, expect, it } from "vitest";

import { getHermesBacklogPlan } from "../../packages/averray-mcp/src/hermes-backlog.js";

describe("Hermes backlog plan", () => {
  it("returns a ranked roadmap-backed shortlist without mutating", () => {
    const plan = getHermesBacklogPlan({ now: new Date("2026-05-31T12:00:00Z"), limit: 3 });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      kind: "hermes_backlog_plan",
      generatedAt: "2026-05-31T12:00:00.000Z",
      mutates: false,
      safety: {
        proposesOnly: true,
        autoApprovalUnchanged: true,
      },
      source: {
        roadmap: "docs/HERMES_ROADMAP.md",
      },
    });
    expect(plan.items).toHaveLength(3);
    expect(plan.items.map((item) => item.id)).toEqual(["C1", "T6", "T4"]);
    expect(plan.items[0]).toMatchObject({
      owner: "claude",
      riskTier: "medium",
      trustLevel: "roadmap_sanctioned",
      requiresOperatorApproval: true,
    });
    expect(plan.items[0].closeCriteria.length).toBeGreaterThan(0);
    expect(plan.items[0].verificationPath.length).toBeGreaterThan(0);
    expect(plan.items[0].prompt).toContain("Build C1");
  });

  it("keeps backlog idle-ineligible while live board work is active", () => {
    const plan = getHermesBacklogPlan({
      board: {
        actionNeeded: 1,
        operatorReview: 1,
        drafts: 3,
      },
    });

    expect(plan.cadence.idleEligible).toBe(false);
    expect(plan.boardGate).toMatchObject({
      status: "busy",
      reason: "2 live cards should resolve before Hermes feeds more work.",
    });
    expect(plan.items[0].autoFlowEligible).toBe(true);
  });

  it("treats external drafts alone as quiet for roadmap proposals", () => {
    const plan = getHermesBacklogPlan({
      board: {
        drafts: 5,
      },
    });

    expect(plan.cadence.idleEligible).toBe(true);
    expect(plan.boardGate.status).toBe("quiet");
  });
});
