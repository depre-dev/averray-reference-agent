export type ReviewPanelRiskTier = "low" | "medium" | "high";
export type ReviewPanelBuilder = "codex" | "claude";
export type ReviewPanelReviewer = "hermes" | "codex" | "claude";
export type ReviewPanelMode = "single" | "panel";
export type ReviewPanelVerdict = "pass" | "concern" | "block";
export type ReviewPanelAgreement = "pending" | "agreement" | "majority" | "split" | "blocked";

export interface ReviewPanelPlanInput {
  riskTier?: ReviewPanelRiskTier | string;
  builder?: ReviewPanelBuilder | string;
  reason?: string;
}

export interface ReviewPanelPlan {
  mode: ReviewPanelMode;
  reviewers: ReviewPanelReviewer[];
  reason: string;
}

export interface ReviewPanelResponse {
  reviewer: ReviewPanelReviewer;
  verdict: ReviewPanelVerdict;
  reasoning: string;
}

export interface ReviewPanelEvaluationInput {
  panelId: string;
  relatedLabel: string;
  reviewers: ReviewPanelReviewer[];
  responses: ReviewPanelResponse[];
  boardUrl?: string;
}

export interface ReviewPanelEvaluation {
  panelId: string;
  relatedLabel: string;
  agreement: ReviewPanelAgreement;
  panelVerdict: ReviewPanelVerdict | "pending";
  escalate: boolean;
  summary: string;
  reviewers: ReviewPanelResponse[];
  alert?: {
    count: number;
    items: Array<{ id: string; title: string }>;
    boardUrl: string;
    text: string;
  };
}

export const HIGH_RISK_REVIEW_PANEL: ReviewPanelReviewer[] = ["hermes", "codex", "claude"];

export function planReviewForRisk(input: ReviewPanelPlanInput): ReviewPanelPlan {
  if (input.riskTier === "high") {
    return {
      mode: "panel",
      reviewers: [...HIGH_RISK_REVIEW_PANEL],
      reason: input.reason || "High-risk surface: request independent Hermes, Codex, and Claude review before operator decision.",
    };
  }

  const reviewer = nonBuilderReviewer(input.builder);
  return {
    mode: "single",
    reviewers: [reviewer],
    reason: input.reason || `Cross-agent review: ${displayName(reviewer)} reviews the builder's PR before Hermes/operator sign-off.`,
  };
}

export function evaluateReviewPanel(input: ReviewPanelEvaluationInput): ReviewPanelEvaluation {
  const responsesByReviewer = new Map(input.responses.map((response) => [response.reviewer, response]));
  const reviewers = input.reviewers.map((reviewer) => responsesByReviewer.get(reviewer)).filter(Boolean) as ReviewPanelResponse[];
  const pendingCount = input.reviewers.length - reviewers.length;

  // A block is actionable as soon as it lands; the operator should not wait for
  // the rest of the panel to answer before seeing the card.
  const blocker = reviewers.find((reviewer) => reviewer.verdict === "block");
  if (blocker) {
    return withEscalation(input, reviewers, {
      agreement: "blocked",
      panelVerdict: "block",
      summary: `${displayName(blocker.reviewer)} blocked ${input.relatedLabel}; operator decision required.`,
    });
  }

  if (pendingCount > 0) {
    return {
      panelId: input.panelId,
      relatedLabel: input.relatedLabel,
      agreement: "pending",
      panelVerdict: "pending",
      escalate: false,
      reviewers,
      summary: `Panel is waiting on ${pendingCount} reviewer${pendingCount === 1 ? "" : "s"} for ${input.relatedLabel}.`,
    };
  }

  const counts = verdictCounts(reviewers);
  const top = topVerdict(counts);
  const unanimous = top.count === reviewers.length;
  if (unanimous) {
    return {
      panelId: input.panelId,
      relatedLabel: input.relatedLabel,
      agreement: "agreement",
      panelVerdict: top.verdict,
      escalate: false,
      reviewers,
      summary: `Reviewer panel agrees: ${top.verdict} for ${input.relatedLabel}.`,
    };
  }

  if (top.count > reviewers.length / 2) {
    return withEscalation(input, reviewers, {
      agreement: "majority",
      panelVerdict: top.verdict,
      summary: `Reviewer panel disagrees on ${input.relatedLabel}; majority is ${top.verdict}, operator decision required.`,
    });
  }

  return withEscalation(input, reviewers, {
    agreement: "split",
    panelVerdict: "concern",
    summary: `Reviewer panel split on ${input.relatedLabel}; operator decision required.`,
  });
}

function withEscalation(
  input: ReviewPanelEvaluationInput,
  reviewers: ReviewPanelResponse[],
  result: Pick<ReviewPanelEvaluation, "agreement" | "panelVerdict" | "summary">
): ReviewPanelEvaluation {
  const boardUrl = input.boardUrl || "/monitor";
  return {
    panelId: input.panelId,
    relatedLabel: input.relatedLabel,
    ...result,
    escalate: true,
    reviewers,
    alert: {
      count: 1,
      items: [{ id: input.panelId, title: `Reviewer panel needs operator decision: ${input.relatedLabel}` }],
      boardUrl,
      text: `${result.summary}\n${reviewers.map((reviewer) =>
        `${displayName(reviewer.reviewer)}: ${reviewer.verdict} — ${reviewer.reasoning}`
      ).join("\n")}`,
    },
  };
}

function nonBuilderReviewer(builder: unknown): ReviewPanelReviewer {
  if (builder === "codex") return "claude";
  if (builder === "claude") return "codex";
  return "claude";
}

function verdictCounts(responses: ReviewPanelResponse[]): Array<{ verdict: ReviewPanelVerdict; count: number }> {
  const counts: Record<ReviewPanelVerdict, number> = { pass: 0, concern: 0, block: 0 };
  for (const response of responses) counts[response.verdict] += 1;
  return (Object.entries(counts) as Array<[ReviewPanelVerdict, number]>)
    .map(([verdict, count]) => ({ verdict, count }))
    .sort((a, b) => b.count - a.count);
}

function topVerdict(counts: Array<{ verdict: ReviewPanelVerdict; count: number }>): { verdict: ReviewPanelVerdict; count: number } {
  return counts[0] ?? { verdict: "concern", count: 0 };
}

function displayName(reviewer: ReviewPanelReviewer): string {
  if (reviewer === "hermes") return "Hermes";
  if (reviewer === "claude") return "Claude";
  return "Codex";
}
