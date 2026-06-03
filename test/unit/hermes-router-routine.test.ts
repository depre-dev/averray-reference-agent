import { describe, expect, it, vi } from "vitest";

import type { DispatchPolicyConfig } from "@avg/averray-mcp/dispatch-policy";
import type { RoutedProposal, WorkRouterBacklogItem } from "@avg/averray-mcp/work-router";
import type { CodexTask } from "../../services/slack-operator/src/codex-task-queue.js";
import {
  routerCorrelationId,
  runHermesRouterOnce,
  type HermesRouterDeps,
} from "../../services/slack-operator/src/hermes-router-routine.js";

const NOW = new Date("2026-06-03T10:00:00.000Z");

const POLICY: DispatchPolicyConfig = {
  allowedRepos: ["depre-dev/averray-reference-agent"],
  allowedAgents: ["codex", "claude"],
  perDayMax: 10,
  perRepoPerDayMax: 5,
  perDayUsdMax: 0,
};

const PROPOSAL: RoutedProposal = {
  taskPrompt: "Fix the uncovered monitor follow-up.",
  repo: "depre-dev/averray-reference-agent",
  surface: "monitor board",
  agent: "claude",
  riskTier: "low",
  why: "Fills uncovered backlog gap: monitor board.",
  whyAgent: "UI/documentation-shaped work routes to Claude.",
  dedupeKey: "depre-dev/averray-reference-agent|monitor-board|monitor-board",
};

const BACKLOG: WorkRouterBacklogItem[] = [{
  repo: PROPOSAL.repo,
  title: "monitor board",
  prompt: PROPOSAL.taskPrompt,
  surface: PROPOSAL.surface,
}];

function config(overrides: Partial<Parameters<typeof runHermesRouterOnce>[0]> = {}): Parameters<typeof runHermesRouterOnce>[0] {
  return {
    enabled: true,
    intervalMs: 5 * 60_000,
    cooldownMs: 30 * 60_000,
    maxProposalsPerTick: 1,
    lookbackMs: 72 * 60 * 60_000,
    ...overrides,
  };
}

function task(overrides: Partial<CodexTask> = {}): CodexTask {
  return {
    schemaVersion: 1,
    kind: "codex_task",
    id: "task-1",
    repo: PROPOSAL.repo,
    prompt: PROPOSAL.taskPrompt,
    status: "proposed",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function deps(overrides: Partial<HermesRouterDeps> = {}): HermesRouterDeps {
  return {
    getBacklog: vi.fn(() => BACKLOG),
    listTasks: vi.fn(() => []),
    policy: vi.fn(() => POLICY),
    classify: vi.fn(() => ({ agent: "claude", riskTier: "low", reason: "UI/documentation-shaped work routes to Claude." })),
    plan: vi.fn(() => [PROPOSAL]),
    propose: vi.fn(() => ({
      created: true,
      task: task({
        id: "task-router-1",
        agent: PROPOSAL.agent,
        riskTier: PROPOSAL.riskTier,
        routingReason: PROPOSAL.whyAgent,
        title: `Hermes routed work: ${PROPOSAL.surface}`,
        reason: `${PROPOSAL.why} ${PROPOSAL.whyAgent}`,
        requester: "hermes-router",
        correlationId: routerCorrelationId(PROPOSAL),
      }),
    })),
    narrate: vi.fn(),
    audit: vi.fn(),
    isSuspended: vi.fn(() => false),
    isHalt: vi.fn(() => false),
    inCooldown: vi.fn(() => false),
    markHandled: vi.fn(),
    now: vi.fn(() => NOW),
    ...overrides,
  };
}

describe("Hermes router routine", () => {
  it("is a complete no-op when the feature flag is off", async () => {
    const d = deps();

    const result = await runHermesRouterOnce(config({ enabled: false }), d);

    expect(result).toEqual({ status: "disabled", proposed: [] });
    expect(d.getBacklog).not.toHaveBeenCalled();
    expect(d.plan).not.toHaveBeenCalled();
    expect(d.propose).not.toHaveBeenCalled();
    expect(d.narrate).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });

  it("pauses under HALT before planning or proposing", async () => {
    const d = deps({ isHalt: vi.fn(() => true) });

    const result = await runHermesRouterOnce(config(), d);

    expect(result).toEqual({ status: "paused", reason: "halt_present", proposed: [] });
    expect(d.getBacklog).not.toHaveBeenCalled();
    expect(d.plan).not.toHaveBeenCalled();
    expect(d.propose).not.toHaveBeenCalled();
    expect(d.narrate).not.toHaveBeenCalled();
  });

  it("pauses under D3 autopilot suspension before planning or proposing", async () => {
    const d = deps({ isSuspended: vi.fn(() => true) });

    const result = await runHermesRouterOnce(config(), d);

    expect(result).toEqual({ status: "paused", reason: "autopilot_suspended", proposed: [] });
    expect(d.getBacklog).not.toHaveBeenCalled();
    expect(d.plan).not.toHaveBeenCalled();
    expect(d.propose).not.toHaveBeenCalled();
    expect(d.narrate).not.toHaveBeenCalled();
  });

  it("creates only a proposed task and narrates it when enabled", async () => {
    const d = deps();

    const result = await runHermesRouterOnce(config(), d);

    expect(result.status).toBe("proposed");
    expect(result.proposed).toEqual([{
      taskId: "task-router-1",
      dedupeKey: PROPOSAL.dedupeKey,
      repo: PROPOSAL.repo,
      agent: PROPOSAL.agent,
      riskTier: PROPOSAL.riskTier,
    }]);
    expect(d.propose).toHaveBeenCalledWith(expect.objectContaining({
      repo: PROPOSAL.repo,
      agent: "claude",
      prompt: PROPOSAL.taskPrompt,
      requester: "hermes-router",
      correlationId: routerCorrelationId(PROPOSAL),
    }));
    expect((vi.mocked(d.propose).mock.calls[0]?.[0] as Record<string, unknown>).status).toBeUndefined();
    expect(d.narrate).toHaveBeenCalledWith(PROPOSAL, expect.objectContaining({
      id: "task-router-1",
      status: "proposed",
    }));
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "propose",
      reason: "routed_proposal",
      taskId: "task-router-1",
      surface: PROPOSAL.surface,
    }));
  });

  it("stays quiet when there is no backlog gap", async () => {
    const d = deps({ plan: vi.fn(() => []) });

    const result = await runHermesRouterOnce(config(), d);

    expect(result).toEqual({ status: "idle", reason: "no_backlog_gap", proposed: [] });
    expect(d.propose).not.toHaveBeenCalled();
    expect(d.narrate).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
  });

  it("does not duplicate an unchanged backlog proposal across ticks", async () => {
    const d = deps({
      listTasks: vi.fn(() => [task({
        id: "existing-router-task",
        correlationId: routerCorrelationId(PROPOSAL),
        status: "proposed",
      })]),
    });

    const result = await runHermesRouterOnce(config(), d);

    expect(result).toEqual({ status: "idle", reason: "no_backlog_gap", proposed: [] });
    expect(d.propose).not.toHaveBeenCalled();
    expect(d.narrate).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "skip",
      reason: "open_task_exists",
    }));
  });

  it("applies the dispatch policy before proposing", async () => {
    const d = deps({
      policy: vi.fn(() => ({ ...POLICY, allowedRepos: [] })),
    });

    const result = await runHermesRouterOnce(config(), d);

    expect(result).toEqual({ status: "idle", reason: "no_policy_allowed_proposals", proposed: [] });
    expect(d.propose).not.toHaveBeenCalled();
    expect(d.narrate).not.toHaveBeenCalled();
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "skip",
      reason: "dispatch_policy_blocked",
    }));
  });
});
