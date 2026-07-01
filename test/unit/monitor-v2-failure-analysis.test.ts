import { describe, expect, it } from "vitest";

import {
  buildV2BoardSnapshot,
  failureAnalysisCardFor,
  type BoardCard,
} from "../../services/slack-operator/src/monitor-v2.js";
import { hashFailureContext } from "../../services/slack-operator/src/monitor-failure-analysis.js";

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "c1",
    lane: "needs-attention",
    type: "deploy",
    agentType: "hermes",
    title: "Deploy monitor stack",
    summary: "Deploy failed.",
    repo: "depre-dev/averray-reference-agent",
    freshness: 3,
    state: "failed-fetch",
    risk: [],
    waitingOn: { actor: "operator", tone: "warn" },
    isAction: true,
    ...over,
  } as BoardCard;
}

describe("failureAnalysisCardFor — which cards get an analysis (single source of truth)", () => {
  it("projects a failed operator-decision card to its grounded failure fields", () => {
    const projected = failureAnalysisCardFor(
      card({
        verdict: "deploy failed",
        checkRuns: [
          { name: "unit tests", status: "fail" },
          { name: "lint", status: "pass" },
          { name: "browser replay", status: "fail" },
        ],
        riskSignals: [{ severity: "high", code: "contract_touch", message: "touches escrow contract" }],
      }),
    );
    expect(projected).toBeTruthy();
    expect(projected!.id).toBe("c1");
    expect(projected!.repo).toBe("depre-dev/averray-reference-agent");
    expect(projected!.verdict).toBe("deploy failed");
    // only the FAILED check names are carried
    expect(projected!.failedCheckNames).toEqual(["unit tests", "browser replay"]);
    expect(projected!.riskSignals).toEqual(["touches escrow contract"]);
    expect(projected!.failureKind).toBe("deploy verification");
  });

  it("skips a NON-failure decision card (operator-review with a passing pre-check)", () => {
    const ok = card({
      type: "pr",
      lane: "operator-review",
      isAction: false,
      state: "fresh",
      verdict: "Hermes pre-check passed",
    });
    expect(failureAnalysisCardFor(ok)).toBeUndefined();
  });

  it("does NOT treat a NEGATED failure keyword in the verdict as a failure (truth boundary)", () => {
    // These verdicts contain 'error'/'fail' but are passing — a fabricated
    // "why it failed" here would violate the truth boundary.
    for (const verdict of [
      "Hermes pre-check passed, no errors",
      "previously failing, now green",
      "all checks passed; error resolved",
      "no failures found",
    ]) {
      const passing = card({ type: "pr", lane: "operator-review", isAction: false, state: "fresh", verdict });
      expect(failureAnalysisCardFor(passing)).toBeUndefined();
    }
  });

  it("DOES treat an un-negated failure verdict as a failure", () => {
    const failed = card({ type: "pr", lane: "operator-review", isAction: false, state: "fresh", verdict: "deploy failed at verification" });
    expect(failureAnalysisCardFor(failed)).toBeTruthy();
  });

  it("skips a non-decision card even when it has a failure signal (not awaiting the operator)", () => {
    const checking = card({ lane: "hermes-checking", isAction: false, verdict: "deploy failed" });
    expect(failureAnalysisCardFor(checking)).toBeUndefined();
  });

  it("skips done / history cards", () => {
    const done = card({ type: "done", lane: "done", isAction: false, verdict: "failed" });
    expect(failureAnalysisCardFor(done)).toBeUndefined();
  });

  it("recognizes a failed task card via taskStatus + failureReason", () => {
    const task = card({
      type: "task",
      taskStatus: "failed",
      failureReason: "runner exited non-zero: npm ci failed",
      state: "fresh",
    });
    const projected = failureAnalysisCardFor(task);
    expect(projected).toBeTruthy();
    expect(projected!.failureReason).toBe("runner exited non-zero: npm ci failed");
    expect(projected!.failureKind).toBe("codex task");
  });
});

describe("buildV2BoardSnapshot — threads a FRESH analysis onto failure cards only", () => {
  // A raw snapshot that classifies into an operator-review DECISION card carrying
  // a real GitHub source-read failure (→ failed-fetch + sourceFailure), so
  // failureAnalysisCardFor selects it.
  const raw = {
    active: [
      {
        title: "Deploy monitor stack",
        status: "needs_review",
        intent: "operator_review",
        summary: {
          pullRequest: { repo: "depre-dev/agent", number: 601, state: "open" },
          finalVerdict: "operator_review",
          githubLive: {
            fetchError: { code: "500", message: "GitHub returned 500 reading /pulls/601", lastGoodAt: "2026-06-30T12:00:00Z" },
          },
        },
        ageLabel: "5m",
      },
    ],
    recent: [],
  };

  it("attaches the cached analysis when its hash matches the card's current failure", () => {
    // First build with no reader to learn the real card + its failure hash.
    const probe = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    const failureCard = probe.cards.find((c) => failureAnalysisCardFor(c));
    expect(failureCard).toBeTruthy();
    const projected = failureAnalysisCardFor(failureCard!)!;
    const hash = hashFailureContext(projected);

    const analysis = { text: "GitHub read failed (500); this is an upstream/source outage, not a code regression — retry the fetch, don't roll back the deploy.", at: "2026-06-30T13:00:00Z" };
    const built = buildV2BoardSnapshot(raw, {
      repo: "depre-dev/agent",
      getAnalysis: (cardId, failureHash) =>
        cardId === failureCard!.id && failureHash === hash ? analysis : undefined,
    });
    const withAnalysis = built.cards.find((c) => c.id === failureCard!.id);
    expect(withAnalysis?.hermesAnalysis).toEqual(analysis);
  });

  it("does NOT attach a stale analysis (reader returns undefined for a non-matching hash)", () => {
    const built = buildV2BoardSnapshot(raw, {
      repo: "depre-dev/agent",
      // reader that never matches (simulates a stale cache for a changed failure)
      getAnalysis: () => undefined,
    });
    expect(built.cards.every((c) => c.hermesAnalysis === undefined)).toBe(true);
  });

  it("is byte-for-byte today's behavior when no reader is supplied (no analysis field anywhere)", () => {
    const built = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    expect(built.cards.every((c) => c.hermesAnalysis === undefined)).toBe(true);
    expect(JSON.stringify(built)).not.toContain("hermesAnalysis");
  });
});
