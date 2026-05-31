import { describe, expect, it } from "vitest";

import { classifyTask } from "../../packages/averray-mcp/src/dispatch-routing.js";
import {
  applyLearnedRouting,
  parseLearnedRoutingConfig,
} from "../../packages/averray-mcp/src/learned-routing.js";

const NOW = new Date("2026-05-31T12:00:00Z");

function scorecard(agents: unknown[]) {
  return {
    schemaVersion: 1,
    kind: "averray_agent_scorecard",
    agents,
  };
}

function agent(agentName: "codex" | "claude", surfaces: unknown[]) {
  return {
    agent: agentName,
    sampleCount: 100,
    cost: { status: "not_recorded" },
    trust: { status: "not_recorded" },
    surfaces,
  };
}

function agentWithCost(agentName: "codex" | "claude", surfaces: unknown[], averageUsdPerTask: number) {
  return {
    ...agent(agentName, surfaces),
    cost: {
      status: "recorded",
      totalUsd: averageUsdPerTask * 10,
      averageUsdPerTask,
      byModel: [{ model: `${agentName}-model`, runs: 10, costUsd: averageUsdPerTask * 10 }],
    },
  };
}

describe("A2 learned routing", () => {
  it("keeps high-risk tasks rule-bound to codex regardless of scorecard stats", () => {
    const staticDecision = classifyTask({ prompt: "update the escrow settlement contract" });
    const decision = applyLearnedRouting(
      { prompt: "update the escrow settlement contract" },
      staticDecision,
      {
        now: NOW,
        config: { minSamples: 2, explorationRate: 0 },
        scorecard: scorecard([
          agent("codex", [{ surface: "contracts", count: 10, ready: 1, blocked: 8 }]),
          agent("claude", [{ surface: "contracts", count: 10, ready: 10, blocked: 0 }]),
        ]),
      },
    );

    expect(decision).toMatchObject({ agent: "codex", riskTier: "high" });
    expect(decision.reason).toMatch(/rule-bound/);
    expect(decision.reason).toMatch(/scorecard ignored/);
    expect(decision.decisionRecord).toMatchObject({
      kind: "routing",
      decision: "routed to codex",
      inputs: { riskTier: "high", scorecardUsed: false },
      safety: { readOnly: true, mutates: false },
    });
  });

  it("routes non-high-risk work to the agent with stronger surface evidence", () => {
    const staticDecision = classifyTask({ prompt: "polish the onboarding UI component" });
    const decision = applyLearnedRouting(
      { prompt: "polish the onboarding UI component" },
      staticDecision,
      {
        now: NOW,
        config: { minSamples: 5, explorationRate: 0 },
        scorecard: scorecard([
          agent("codex", [{ surface: "frontend", count: 10, ready: 7, blocked: 2 }]),
          agent("claude", [{ surface: "frontend", count: 12, ready: 11, blocked: 0 }]),
        ]),
      },
    );

    expect(decision).toMatchObject({ agent: "claude", riskTier: "low" });
    expect(decision.reason).toMatch(/A2 learned routing/);
    expect(decision.reason).toMatch(/claude 92% ready/);
    expect(decision.reason).toMatch(/codex 70% ready/);
    expect(decision.decisionRecord).toMatchObject({
      kind: "routing",
      decision: "routed to claude",
      inputs: {
        mode: "learned",
        riskTier: "low",
        scorecardSnapshot: [
          expect.objectContaining({ agent: "claude" }),
          expect.objectContaining({ agent: "codex" }),
        ],
      },
    });
  });

  it("falls back to the static default during cold start", () => {
    const staticDecision = classifyTask({ prompt: "polish the onboarding UI component" });
    const decision = applyLearnedRouting(
      { prompt: "polish the onboarding UI component" },
      staticDecision,
      {
        now: NOW,
        config: { minSamples: 8, explorationRate: 0 },
        scorecard: scorecard([
          agent("codex", [{ surface: "frontend", count: 2, ready: 2, blocked: 0 }]),
          agent("claude", [{ surface: "frontend", count: 3, ready: 2, blocked: 1 }]),
        ]),
      },
    );

    expect(decision).toMatchObject({ agent: "claude", riskTier: "low" });
    expect(decision.reason).toMatch(/cold start/);
    expect(decision.reason).toMatch(/static default/);
  });

  it("recency-decays stale wins so recent evidence can take over", () => {
    const staticDecision = classifyTask({ prompt: "polish the onboarding UI component" });
    const decision = applyLearnedRouting(
      { prompt: "polish the onboarding UI component" },
      staticDecision,
      {
        now: NOW,
        config: { minSamples: 2, decayHalfLifeDays: 1, explorationRate: 0 },
        scorecard: scorecard([
          agent("codex", [{ surface: "frontend", count: 8, ready: 6, blocked: 0, observedAt: "2026-05-31T11:00:00Z" }]),
          agent("claude", [{ surface: "frontend", count: 80, ready: 80, blocked: 0, observedAt: "2026-05-21T12:00:00Z" }]),
        ]),
      },
    );

    expect(decision.agent).toBe("codex");
    expect(decision.reason).toMatch(/codex/);
  });

  it("uses injected RNG for deterministic exploration", () => {
    const staticDecision = classifyTask({ prompt: "polish the onboarding UI component" });
    const decision = applyLearnedRouting(
      { prompt: "polish the onboarding UI component" },
      staticDecision,
      {
        now: NOW,
        rng: () => 0,
        config: { minSamples: 5, explorationRate: 1 },
        scorecard: scorecard([
          agent("codex", [{ surface: "frontend", count: 10, ready: 6, blocked: 1 }]),
          agent("claude", [{ surface: "frontend", count: 10, ready: 10, blocked: 0 }]),
        ]),
      },
    );

    expect(decision.agent).toBe("codex");
    expect(decision.reason).toMatch(/exploration/);
  });

  it("uses recorded cost only as a close quality tie-break", () => {
    const staticDecision = classifyTask({ prompt: "polish the onboarding UI component" });
    const decision = applyLearnedRouting(
      { prompt: "polish the onboarding UI component" },
      staticDecision,
      {
        now: NOW,
        config: { minSamples: 5, explorationRate: 0, costTieMaxScoreDelta: 0.05 },
        scorecard: scorecard([
          agentWithCost("codex", [{ surface: "frontend", count: 100, ready: 90, blocked: 0 }], 0.20),
          agentWithCost("claude", [{ surface: "frontend", count: 100, ready: 88, blocked: 0 }], 0.02),
        ]),
      },
    );

    expect(decision.agent).toBe("claude");
    expect(decision.reason).toMatch(/A3 cost-aware routing/);
    expect(decision.reason).toMatch(/lower recorded cost/);
    expect(decision.decisionRecord).toMatchObject({
      inputs: {
        mode: "cost_aware",
        scorecardSnapshot: [
          expect.objectContaining({ agent: "codex", costUsdPerTask: 0.2 }),
          expect.objectContaining({ agent: "claude", costUsdPerTask: 0.02 }),
        ],
      },
    });
  });

  it("does not treat missing cost as cheap or expensive", () => {
    const staticDecision = classifyTask({ prompt: "polish the onboarding UI component" });
    const decision = applyLearnedRouting(
      { prompt: "polish the onboarding UI component" },
      staticDecision,
      {
        now: NOW,
        config: { minSamples: 5, explorationRate: 0, costTieMaxScoreDelta: 0.05 },
        scorecard: scorecard([
          agent("codex", [{ surface: "frontend", count: 100, ready: 90, blocked: 0 }]),
          agentWithCost("claude", [{ surface: "frontend", count: 100, ready: 88, blocked: 0 }], 0.01),
        ]),
      },
    );

    expect(decision.agent).toBe("codex");
    expect(decision.reason).toMatch(/cost neutral/);
    expect(decision.reason).toMatch(/cost not recorded/);
  });

  it("treats not_recorded and missing signals as neutral, not as free good score", () => {
    const staticDecision = classifyTask({ prompt: "polish the onboarding UI component" });
    const decision = applyLearnedRouting(
      { prompt: "polish the onboarding UI component" },
      staticDecision,
      {
        now: NOW,
        config: { minSamples: 5, explorationRate: 0 },
        scorecard: scorecard([
          agent("codex", [{ surface: "frontend", count: 5 }]),
          agent("claude", [{ surface: "frontend", count: 5, ready: 3, blocked: 0 }]),
        ]),
      },
    );

    expect(decision.agent).toBe("claude");
    expect(decision.reason).toMatch(/codex not recorded ready/);
  });

  it("parses conservative config from env with bounds", () => {
    const config = parseLearnedRoutingConfig({
      A2_LEARNED_ROUTING_MIN_SAMPLES: "3.8",
      A2_LEARNED_ROUTING_DECAY_HALF_LIFE_DAYS: "7",
      A2_LEARNED_ROUTING_EXPLORATION_RATE: "2",
    });

    expect(config).toMatchObject({ minSamples: 3, decayHalfLifeDays: 7, explorationRate: 1 });
    expect(config.costAware).toBe(true);
  });
});
