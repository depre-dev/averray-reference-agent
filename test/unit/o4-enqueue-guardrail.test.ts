import { describe, expect, it, vi } from "vitest";

import {
  loadDispatchPolicyConfig,
  evaluateDispatchPolicy,
  type DispatchPolicyConfig,
} from "../../packages/averray-mcp/src/dispatch-policy.js";
import {
  invokeAgentTask,
  type AgentInvocationDeps,
  type AgentInvocationInput,
  type QueuedTaskSummary,
} from "../../packages/averray-mcp/src/agent-invocation.js";

const ALLOWED: DispatchPolicyConfig = {
  allowedRepos: ["averray-agent/agent"],
  allowedAgents: ["codex", "claude"],
  perDayMax: 10,
  perRepoPerDayMax: 5,
};

describe("dispatch-policy — allowlist + budget (fail-closed)", () => {
  it("empty allowlist denies everything (never allow-all)", () => {
    const cfg: DispatchPolicyConfig = { ...ALLOWED, allowedRepos: [] };
    expect(evaluateDispatchPolicy(cfg, { repo: "averray-agent/agent", agent: "codex", todayCount: 0, todayRepoCount: 0 }))
      .toEqual({ allowed: false, reason: "dispatch_allowlist_empty" });
  });

  it("allows a repo + agent that are on the allowlist and under budget", () => {
    expect(evaluateDispatchPolicy(ALLOWED, { repo: "averray-agent/agent", agent: "claude", todayCount: 3, todayRepoCount: 1 }))
      .toEqual({ allowed: true, reason: "dispatch_allowed" });
  });

  it("rejects a repo not on the allowlist", () => {
    expect(evaluateDispatchPolicy(ALLOWED, { repo: "evil/repo", agent: "codex", todayCount: 0, todayRepoCount: 0 }).reason)
      .toBe("repo_not_allowed");
  });

  it("rejects an agent not on the allowlist", () => {
    expect(evaluateDispatchPolicy(ALLOWED, { repo: "averray-agent/agent", agent: "gpt5", todayCount: 0, todayRepoCount: 0 }).reason)
      .toBe("agent_not_allowed");
  });

  it("enforces the per-day budget (under / at / over)", () => {
    const at = evaluateDispatchPolicy(ALLOWED, { repo: "averray-agent/agent", agent: "codex", todayCount: 10, todayRepoCount: 0 });
    expect(at).toEqual({ allowed: false, reason: "daily_budget_exhausted" });
    const under = evaluateDispatchPolicy(ALLOWED, { repo: "averray-agent/agent", agent: "codex", todayCount: 9, todayRepoCount: 0 });
    expect(under.allowed).toBe(true);
  });

  it("enforces the per-repo daily budget", () => {
    const r = evaluateDispatchPolicy(ALLOWED, { repo: "averray-agent/agent", agent: "codex", todayCount: 3, todayRepoCount: 5 });
    expect(r).toEqual({ allowed: false, reason: "repo_daily_budget_exhausted" });
  });

  it("loadDispatchPolicyConfig: fail-closed default repos + env override + default agents", () => {
    // No POLICY_CONFIG_PATH / yaml ⇒ empty repos (fail-closed); agents default codex+claude.
    const bare = loadDispatchPolicyConfig({ POLICY_CONFIG_PATH: "/does/not/exist.yaml" } as NodeJS.ProcessEnv);
    expect(bare.allowedRepos).toEqual([]);
    expect(bare.allowedAgents).toEqual(["codex", "claude"]);
    const overridden = loadDispatchPolicyConfig({
      POLICY_CONFIG_PATH: "/does/not/exist.yaml",
      HERMES_DISPATCH_ALLOWED_REPOS: "averray-agent/agent, depre-dev/site",
      HERMES_DISPATCH_PER_DAY_MAX: "3",
    } as NodeJS.ProcessEnv);
    expect(overridden.allowedRepos).toEqual(["averray-agent/agent", "depre-dev/site"]);
    expect(overridden.perDayMax).toBe(3);
  });
});

// ── enqueue_agent_task handler (proposes-only) ──────────────────────

function baseDeps(over: Partial<AgentInvocationDeps> = {}): AgentInvocationDeps {
  return {
    query: (async () => []) as AgentInvocationDeps["query"],
    workflowDeps: {} as AgentInvocationDeps["workflowDeps"],
    handoffEventRecorder: vi.fn(async () => ({})),
    assertNoKillSwitchFn: async () => {},
    dispatchPolicyConfig: ALLOWED,
    listQueuedTasksFn: async () => [],
    proposeTaskFn: vi.fn(async () => ({ id: "claude-task-1" })),
    now: new Date("2026-05-31T12:00:00Z"),
    ...over,
  };
}

const enqueue = (over: Partial<AgentInvocationInput> = {}): AgentInvocationInput => ({
  requester: "hermes",
  intent: "enqueue_agent_task",
  repo: "averray-agent/agent",
  prompt: "Add a HEALTHCHECK.md",
  agent: "claude",
  ...over,
});

describe("enqueue_agent_task — proposes-only handler", () => {
  it("HALT blocks: kill-switch throws → blocked, no task proposed", async () => {
    const proposeTaskFn = vi.fn(async () => ({ id: "x" }));
    const result = (await invokeAgentTask(enqueue(), baseDeps({
      assertNoKillSwitchFn: async () => { throw new Error("HALT_FILE present"); },
      proposeTaskFn,
    }))) as { status: string; reason?: string };
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("halt_file_present");
    expect(proposeTaskFn).not.toHaveBeenCalled();
  });

  it("rejects a disallowed repo with a clear reason (no task proposed)", async () => {
    const proposeTaskFn = vi.fn(async () => ({ id: "x" }));
    const result = (await invokeAgentTask(enqueue({ repo: "evil/repo" }), baseDeps({ proposeTaskFn }))) as { status: string; reason?: string };
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("repo_not_allowed");
    expect(proposeTaskFn).not.toHaveBeenCalled();
  });

  it("rejects when over the daily budget", async () => {
    const overBudget: QueuedTaskSummary[] = Array.from({ length: 10 }, () => ({
      requester: "hermes",
      createdAt: "2026-05-31T09:00:00Z",
      repo: "averray-agent/agent",
    }));
    const proposeTaskFn = vi.fn(async () => ({ id: "x" }));
    const result = (await invokeAgentTask(enqueue(), baseDeps({ listQueuedTasksFn: async () => overBudget, proposeTaskFn }))) as { status: string; reason?: string };
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("daily_budget_exhausted");
    expect(proposeTaskFn).not.toHaveBeenCalled();
  });

  it("requires repo + prompt", async () => {
    const r1 = (await invokeAgentTask(enqueue({ repo: "" }), baseDeps())) as { reason?: string };
    expect(r1.reason).toBe("repo_required");
    const r2 = (await invokeAgentTask(enqueue({ prompt: "" }), baseDeps())) as { reason?: string };
    expect(r2.reason).toBe("prompt_required");
  });

  it("allowed → proposes a task (requester=hermes), records a handoff event, NEVER approves", async () => {
    const proposeTaskFn = vi.fn(async () => ({ id: "claude-task-9" }));
    const handoff = vi.fn(async () => ({}));
    const result = (await invokeAgentTask(
      enqueue({ reason: "Hermes saw a gap" }),
      baseDeps({ proposeTaskFn, handoffEventRecorder: handoff }),
    )) as { status: string; result?: { status?: string; proposedTaskId?: string; requester?: string } };

    // proposed task posted with the right payload
    expect(proposeTaskFn).toHaveBeenCalledTimes(1);
    const task = proposeTaskFn.mock.calls[0]![0];
    expect(task).toMatchObject({
      repo: "averray-agent/agent",
      agent: "claude",
      prompt: "Add a HEALTHCHECK.md",
      requester: "hermes",
      reason: "Hermes saw a gap",
    });
    // proposes-only: the payload never asks to approve/run
    expect(JSON.stringify(task)).not.toMatch(/approv/i);
    expect("status" in task).toBe(false);

    // result is a completed, proposed-only invocation
    expect(result.status).toBe("completed");
    expect(result.result?.status).toBe("proposed");
    expect(result.result?.proposedTaskId).toBe("claude-task-9");

    // handoff event recorded (audit). The wrapper records started + completed.
    expect(handoff).toHaveBeenCalled();
    const phases = handoff.mock.calls.map((c) => (c[0] as { phase?: string }).phase);
    expect(phases).toContain("completed");
  });

  it("only today's Hermes tasks count toward budget (not other requesters / other days)", async () => {
    const queued: QueuedTaskSummary[] = [
      { requester: "operator", createdAt: "2026-05-31T08:00:00Z", repo: "averray-agent/agent" }, // not hermes
      { requester: "hermes", createdAt: "2026-05-30T08:00:00Z", repo: "averray-agent/agent" }, // yesterday
      { requester: "hermes", createdAt: "2026-05-31T08:00:00Z", repo: "averray-agent/agent" }, // counts (1)
    ];
    const proposeTaskFn = vi.fn(async () => ({ id: "ok" }));
    const result = (await invokeAgentTask(enqueue(), baseDeps({ listQueuedTasksFn: async () => queued, proposeTaskFn }))) as { status: string };
    expect(result.status).toBe("completed"); // 1 < perDayMax(10) → allowed
    expect(proposeTaskFn).toHaveBeenCalledTimes(1);
  });
});
