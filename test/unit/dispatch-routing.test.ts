import { describe, expect, it, vi } from "vitest";

import { classifyTask } from "../../packages/averray-mcp/src/dispatch-routing.js";
import {
  invokeAgentTask,
  type AgentInvocationDeps,
  type AgentInvocationInput,
  type ProposedAgentTask,
} from "../../packages/averray-mcp/src/agent-invocation.js";
import type { DispatchPolicyConfig } from "../../packages/averray-mcp/src/dispatch-policy.js";

describe("classifyTask — the routing taxonomy (§O4-C)", () => {
  const high: Array<[string, string]> = [
    ["update the escrow Solidity contract", "contracts"],
    ["fix settlement on-chain payout finality", "chain/settlement"],
    ["the indexer is missing events", "indexer"],
    ["wire the XCM cross-chain transfer", "XCM"],
    ["raise the treasury policy spend cap", "treasury/policy"],
    ["reconcile the payment payout amounts", "payments"],
    ["add a DB migration for the new column", "DB migrations"],
    ["fix the deploy pipeline / ops compose", "deploy/ops"],
    ["rotate the API key secret in config", "secrets/config"],
  ];
  it.each(high)("high-risk surface %j → codex + high", (prompt) => {
    const r = classifyTask({ repo: "averray-agent/agent", prompt });
    expect(r.agent).toBe("codex");
    expect(r.riskTier).toBe("high");
    expect(r.reason).toMatch(/high-risk/);
  });

  const low: string[] = [
    "tweak the onboarding UI component styling",
    "fix a bug in the monitor board drawer",
    "update the README docs",
    "add a vitest spec for the parser",
    "refactor and rename a helper for clarity",
  ];
  it.each(low)("Claude surface %j → claude + low", (prompt) => {
    const r = classifyTask({ repo: "depre-dev/averray-reference-agent", prompt });
    expect(r.agent).toBe("claude");
    expect(r.riskTier).toBe("low");
    expect(r.reason).toMatch(/low-risk/);
  });

  it("ambiguous/general → claude + low (default)", () => {
    const r = classifyTask({ repo: "averray-agent/agent", prompt: "make the thing a bit nicer" });
    expect(r).toMatchObject({ agent: "claude", riskTier: "low" });
    expect(r.reason).toMatch(/default/);
  });

  it("escalate-safe: a high-risk signal wins over a Claude signal", () => {
    // "refactor" is a Claude surface, but the escrow contract is high-risk → codex.
    const r = classifyTask({ repo: "averray-agent/agent", prompt: "refactor the escrow settlement contract" });
    expect(r).toMatchObject({ agent: "codex", riskTier: "high" });
  });

  it("honors an explicit area hint", () => {
    expect(classifyTask({ area: "contracts" })).toMatchObject({ agent: "codex", riskTier: "high" });
    expect(classifyTask({ area: "ui" })).toMatchObject({ agent: "claude", riskTier: "low" });
  });

  it("word boundaries: 'props' does not trip the 'ops' (deploy/ops) keyword", () => {
    const r = classifyTask({ repo: "depre-dev/averray-reference-agent", prompt: "pass the component props down" });
    expect(r.agent).toBe("claude"); // UI component, not deploy/ops
    expect(r.riskTier).toBe("low");
  });
});

// ── enqueue uses routing as an overridable default ──────────────────

const ALLOWED: DispatchPolicyConfig = {
  allowedRepos: ["averray-agent/agent"],
  allowedAgents: ["codex", "claude"],
  perDayMax: 10,
  perRepoPerDayMax: 5,
  perDayUsdMax: 0,
};

function baseDeps(proposeTaskFn: (t: ProposedAgentTask) => Promise<{ id?: string }>): AgentInvocationDeps {
  return {
    query: (async () => []) as AgentInvocationDeps["query"],
    workflowDeps: {} as AgentInvocationDeps["workflowDeps"],
    handoffEventRecorder: vi.fn(async () => ({})),
    assertNoKillSwitchFn: async () => {},
    dispatchPolicyConfig: ALLOWED,
    listQueuedTasksFn: async () => [],
    proposeTaskFn,
    agentScorecardFn: async () => ({ kind: "averray_agent_scorecard", agents: [] }),
    now: new Date("2026-05-31T12:00:00Z"),
  };
}

const enqueue = (over: Partial<AgentInvocationInput> = {}): AgentInvocationInput => ({
  requester: "hermes",
  intent: "enqueue_agent_task",
  repo: "averray-agent/agent",
  prompt: "tweak the onboarding UI component",
  ...over,
});

describe("enqueue_agent_task — routing as an overridable default", () => {
  it("derives the agent + risk tier when no agent is given (UI → claude/low)", async () => {
    const proposeTaskFn = vi.fn(async () => ({ id: "t1" }));
    const result = (await invokeAgentTask(enqueue(), baseDeps(proposeTaskFn))) as {
      status: string; result?: { agent?: string; riskTier?: string; agentExplicit?: boolean };
    };
    const task = proposeTaskFn.mock.calls[0]![0];
    expect(task.agent).toBe("claude");
    expect(task.riskTier).toBe("low");
    expect(task.routingReason).toMatch(/claude, low-risk/);
    expect(result.result?.agentExplicit).toBe(false);
  });

  it("uses A2 scorecard data as the low-risk default when enough samples exist", async () => {
    const proposeTaskFn = vi.fn(async () => ({ id: "t1b" }));
    await invokeAgentTask(enqueue(), {
      ...baseDeps(proposeTaskFn),
      learnedRoutingConfig: { minSamples: 5, explorationRate: 0 },
      agentScorecardFn: async () => ({
        kind: "averray_agent_scorecard",
        agents: [
          { agent: "codex", surfaces: [{ surface: "frontend", count: 10, ready: 9, blocked: 0 }] },
          { agent: "claude", surfaces: [{ surface: "frontend", count: 10, ready: 5, blocked: 2 }] },
        ],
      }),
    });
    const task = proposeTaskFn.mock.calls[0]![0];
    expect(task.agent).toBe("codex");
    expect(task.riskTier).toBe("low");
    expect(task.routingReason).toMatch(/A2 learned routing/);
    expect(task.routingReason).toMatch(/codex 90% ready/);
  });

  it("high-risk surface with no agent → codex/high persisted", async () => {
    const proposeTaskFn = vi.fn(async () => ({ id: "t2" }));
    await invokeAgentTask(enqueue({ prompt: "update the escrow settlement contract" }), baseDeps(proposeTaskFn));
    const task = proposeTaskFn.mock.calls[0]![0];
    expect(task.agent).toBe("codex");
    expect(task.riskTier).toBe("high");
  });

  it("an explicit agent OVERRIDES the routed default — but the risk tier is still computed", async () => {
    const proposeTaskFn = vi.fn(async () => ({ id: "t3" }));
    // Explicit claude on a high-risk contracts task: agent honored, tier still high.
    const result = (await invokeAgentTask(
      enqueue({ agent: "claude", prompt: "update the escrow settlement contract" }),
      baseDeps(proposeTaskFn),
    )) as { result?: { agent?: string; riskTier?: string; agentExplicit?: boolean } };
    const task = proposeTaskFn.mock.calls[0]![0];
    expect(task.agent).toBe("claude"); // override wins
    expect(task.riskTier).toBe("high"); // tier never under-classified
    expect(result.result?.agentExplicit).toBe(true);
  });

  it("explicit agent still wins even when A2 would pick another low-risk agent", async () => {
    const proposeTaskFn = vi.fn(async () => ({ id: "t3b" }));
    await invokeAgentTask(enqueue({ agent: "claude" }), {
      ...baseDeps(proposeTaskFn),
      learnedRoutingConfig: { minSamples: 5, explorationRate: 0 },
      agentScorecardFn: async () => ({
        kind: "averray_agent_scorecard",
        agents: [
          { agent: "codex", surfaces: [{ surface: "frontend", count: 10, ready: 10, blocked: 0 }] },
          { agent: "claude", surfaces: [{ surface: "frontend", count: 10, ready: 1, blocked: 5 }] },
        ],
      }),
    });
    const task = proposeTaskFn.mock.calls[0]![0];
    expect(task.agent).toBe("claude");
    expect(task.routingReason).toMatch(/UI\/frontend/);
    expect(task.routingReason).not.toMatch(/A2 learned routing/);
  });

  it("persists riskTier + routingReason on the proposed task (PR3 reads the tier)", async () => {
    const proposeTaskFn = vi.fn(async () => ({ id: "t4" }));
    await invokeAgentTask(enqueue({ prompt: "add a DB migration" }), baseDeps(proposeTaskFn));
    const task = proposeTaskFn.mock.calls[0]![0];
    expect(task).toMatchObject({ riskTier: "high", requester: "hermes" });
    expect(typeof task.routingReason).toBe("string");
    // proposes-only invariant — never approves
    expect(JSON.stringify(task)).not.toMatch(/approv/i);
  });
});
