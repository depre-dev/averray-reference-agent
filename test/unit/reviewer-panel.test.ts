import { describe, expect, it } from "vitest";
import {
  evaluateReviewPanel,
  planReviewForRisk,
  type ReviewPanelResponse,
} from "../../services/slack-operator/src/reviewer-panel.js";

describe("C2 reviewer panel", () => {
  it("fans high-risk work out to Hermes plus both builder agents", () => {
    const plan = planReviewForRisk({ riskTier: "high", reason: "contracts touched" });

    expect(plan).toEqual({
      mode: "panel",
      reviewers: ["hermes", "codex", "claude"],
      reason: "contracts touched",
    });
  });

  it("keeps low/medium work on the single non-builder C1 review path", () => {
    expect(planReviewForRisk({ riskTier: "low", builder: "codex" })).toMatchObject({
      mode: "single",
      reviewers: ["claude"],
    });
    expect(planReviewForRisk({ riskTier: "medium", builder: "claude" })).toMatchObject({
      mode: "single",
      reviewers: ["codex"],
    });
  });

  it("returns panel PASS when all independent reviewers agree", () => {
    const evaluation = evaluateReviewPanel({
      panelId: "panel-1",
      relatedLabel: "agent#404",
      reviewers: ["hermes", "codex", "claude"],
      responses: responses("pass", "pass", "pass"),
    });

    expect(evaluation).toMatchObject({
      agreement: "agreement",
      panelVerdict: "pass",
      escalate: false,
    });
  });

  it("allows a no-block majority while keeping minority reasoning attached", () => {
    const evaluation = evaluateReviewPanel({
      panelId: "panel-2",
      relatedLabel: "agent#405",
      reviewers: ["hermes", "codex", "claude"],
      responses: responses("pass", "pass", "concern"),
    });

    expect(evaluation).toMatchObject({
      agreement: "majority",
      panelVerdict: "pass",
      escalate: false,
    });
    expect(evaluation.reviewers).toHaveLength(3);
  });

  it("escalates disagreement with every reviewer verdict in the D4 alert payload", () => {
    const evaluation = evaluateReviewPanel({
      panelId: "panel-3",
      relatedLabel: "agent#406",
      reviewers: ["hermes", "codex", "claude"],
      responses: [
        { reviewer: "hermes", verdict: "pass", reasoning: "checks are green" },
        { reviewer: "codex", verdict: "concern", reasoning: "migration rollback unclear" },
        { reviewer: "claude", verdict: "block", reasoning: "secret boundary changed" },
      ],
      boardUrl: "https://monitor.example/monitor",
    });

    expect(evaluation).toMatchObject({
      agreement: "blocked",
      panelVerdict: "block",
      escalate: true,
      alert: {
        count: 1,
        boardUrl: "https://monitor.example/monitor",
      },
    });
    expect(evaluation.alert?.text).toContain("Hermes: pass");
    expect(evaluation.alert?.text).toContain("Codex: concern");
    expect(evaluation.alert?.text).toContain("Claude: block");
  });

  it("waits instead of escalating while a panelist has not responded", () => {
    const evaluation = evaluateReviewPanel({
      panelId: "panel-4",
      relatedLabel: "agent#407",
      reviewers: ["hermes", "codex", "claude"],
      responses: [{ reviewer: "hermes", verdict: "pass", reasoning: "ok" }],
    });

    expect(evaluation).toMatchObject({
      agreement: "pending",
      panelVerdict: "pending",
      escalate: false,
    });
  });
});

function responses(
  hermes: ReviewPanelResponse["verdict"],
  codex: ReviewPanelResponse["verdict"],
  claude: ReviewPanelResponse["verdict"]
): ReviewPanelResponse[] {
  return [
    { reviewer: "hermes", verdict: hermes, reasoning: "Hermes reasoning" },
    { reviewer: "codex", verdict: codex, reasoning: "Codex reasoning" },
    { reviewer: "claude", verdict: claude, reasoning: "Claude reasoning" },
  ];
}
