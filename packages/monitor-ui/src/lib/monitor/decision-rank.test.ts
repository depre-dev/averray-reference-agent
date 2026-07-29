import { describe, expect, test } from "vitest";

import type { BoardCard } from "./card-types.js";
import type { ProductHealth } from "./product-health.js";
import { decisionPriorityFor, rankDecisionCards } from "./decision-rank.js";

function decision(overrides: Record<string, unknown> = {}): BoardCard {
  return {
    id: "task-1",
    lane: "codex-needed",
    type: "task",
    agentType: "codex",
    title: "Review proposed work",
    summary: "",
    repo: "depre-dev/averray-reference-agent",
    freshness: 10,
    state: "fresh",
    risk: [],
    waitingOn: { actor: "operator", tone: "info" },
    taskStatus: "proposed",
    prompt: "Review the proposal.",
    ...overrides,
  } as BoardCard;
}

function health(
  probes: ProductHealth["probes"],
): ProductHealth {
  return {
    enabled: true,
    at: 1,
    status: probes.some((probe) => probe.status === "red")
      ? "red"
      : probes.some((probe) => probe.status === "degraded")
        ? "degraded"
        : "healthy",
    checks: 1,
    probes,
  };
}

describe("money-first decision ranking", () => {
  test("orders money-blocking, unknown, standard, then routine verification", () => {
    const routine = decision({
      id: "routine",
      type: "deploy",
      title: "post-production-deploy verification after workflow run #40",
      isAction: true,
      freshness: 1,
    });
    const standard = decision({
      id: "standard",
      type: "pr",
      files: [{ path: "packages/monitor-ui/src/App.tsx", diff: "+1 -0", critical: false }],
      isAction: true,
      freshness: 1,
    });
    const unknown = decision({ id: "unknown", freshness: 999 });
    const money = decision({
      id: "money",
      type: "pr",
      files: [{ path: "services/settlement/submit.ts", diff: "+4 -1", critical: false }],
      freshness: 999,
    });

    expect(rankDecisionCards([routine, standard, unknown, money]).map((card) => card.id))
      .toEqual(["money", "unknown", "standard", "routine"]);
  });

  test("uses degraded probe status only when the card explicitly links to that probe", () => {
    const degraded = health([
      { name: "signer_liquidity", status: "degraded", detail: "runway low", sparkline: [] },
    ]);
    const linked = decision({ id: "linked", title: "Signer gas runway needs a top-up decision" });
    const unrelated = decision({ id: "unrelated", title: "Review accessibility copy" });

    expect(decisionPriorityFor(linked, degraded)).toEqual({
      tier: "money-blocking",
      reason: "Money first · Signer liquidity degraded",
    });
    expect(decisionPriorityFor(unrelated, degraded).tier).toBe("unknown");
  });

  test("recognizes money repos/paths and the server-provided critical-file flag", () => {
    expect(decisionPriorityFor(decision({ repo: "depre-dev/settlement-worker" })).tier)
      .toBe("money-blocking");
    expect(decisionPriorityFor(decision({
      type: "pr",
      files: [{ path: "packages/api/src/treasury/routes.ts", diff: "+1 -0", critical: false }],
    })).reason).toBe("Money first · treasury path");
    expect(decisionPriorityFor(decision({
      type: "pr",
      files: [{ path: "contracts/AgentTreasury.sol", diff: "+1 -0", critical: true }],
    })).reason).toBe("Money first · treasury path");
    expect(decisionPriorityFor(decision({
      type: "pr",
      files: [{ path: "contracts/Registry.sol", diff: "+1 -0", critical: true }],
    })).reason).toBe("Money first · critical file");
  });

  test("preserves the existing urgency order inside a tier", () => {
    const fresh = decision({
      id: "fresh",
      type: "pr",
      files: [{ path: "services/payout/read.ts", diff: "+1 -0", critical: false }],
      freshness: 1,
    });
    const failing = decision({
      id: "failing",
      type: "pr",
      files: [{ path: "services/escrow/write.ts", diff: "+1 -0", critical: false }],
      freshness: 100,
      checks: { pass: 0, running: 0, fail: 1, pending: 0, total: 1 },
    });

    expect(rankDecisionCards([fresh, failing]).map((card) => card.id))
      .toEqual(["failing", "fresh"]);
  });

  test("keeps every isDecision card exactly once and does not mutate the input", () => {
    const unknown = decision({ id: "unknown" });
    const money = decision({
      id: "money",
      type: "pr",
      files: [{ path: "services/escrow/index.ts", diff: "", critical: false }],
    });
    const finished = decision({
      id: "finished",
      type: "done",
      lane: "done",
      closedAt: "2026-07-29T10:00:00Z",
      mergeStatus: "MERGED",
    });
    const input = [unknown, finished, money];
    const snapshot = [...input];

    expect(rankDecisionCards(input).map((card) => card.id)).toEqual(["money", "unknown"]);
    expect(input).toEqual(snapshot);
  });

  // GATE (#579): the demotion is title-driven, so on its own it sank a RED
  // production deploy below "rename a label". Demoting a card that is reporting
  // a failure is the same class of harm as hiding it — the board stops
  // representing what is actually urgent.
  test("a FAILING verification is not routine — failure evidence cancels the demotion", () => {
    const failing = decision({
      id: "failing",
      type: "deploy",
      title: "post-production-deploy verification after workflow run #41",
      checkRuns: [{ name: "smoke", status: "fail" }],
    });
    const trivial = decision({ id: "trivial", title: "rename a label" });

    expect(decisionPriorityFor(failing).tier).not.toBe("routine-verification");
    expect(rankDecisionCards([failing, trivial]).map((card) => card.id)).toEqual([
      "failing",
      "trivial",
    ]);
  });

  test.each([
    ["a failing check run", { checkRuns: [{ name: "smoke", status: "fail" }] }],
    ["a high-severity finding", { riskSignals: [{ severity: "high", code: "X", message: "m" }] }],
    ["an offline upstream", { state: "source-offline" }],
    ["a task failure reason", { type: "task", failureReason: "runner exited 1" }],
    ["a FAILED verdict", { type: "pr", verdict: "FAILED — smoke red" }],
  ])("%s keeps a verification card out of the bottom tier", (_label, over) => {
    const card = decision({ title: "post-deploy verification", ...over });
    expect(decisionPriorityFor(card).tier).not.toBe("routine-verification");
  });

  test("a CLEAN verification still sinks — the demotion itself is intact", () => {
    const clean = decision({
      id: "clean",
      type: "deploy",
      title: "post-production-deploy verification after workflow run #42",
      checkRuns: [{ name: "smoke", status: "pass" }],
    });
    expect(decisionPriorityFor(clean).tier).toBe("routine-verification");
  });
});
