import { describe, expect, it, vi } from "vitest";

import {
  buildAutopilotAwayDigest,
  deliverAutopilotAwayDigest,
  formatAutopilotAwayDigestForOperator,
  initialAutopilotAwayDigestTrackerState,
  observeAutopilotAwayDigestSession,
  type AwayDigestBoardCard,
  type AutopilotAuditEvent,
} from "../../services/slack-operator/src/away-digest.js";
import type { CodexTask } from "../../services/slack-operator/src/codex-task-queue.js";

const START = "2026-05-31T08:00:00.000Z";
const END = "2026-05-31T09:00:00.000Z";
const NOW = new Date(END);

function task(overrides: Partial<CodexTask>): CodexTask {
  return {
    schemaVersion: 1,
    kind: "codex_task",
    id: "task-1",
    repo: "depre-dev/averray-reference-agent",
    status: "proposed",
    title: "Default task",
    prompt: "Do the thing.",
    createdAt: START,
    updatedAt: START,
    ...overrides,
  };
}

describe("autopilot away digest session tracking", () => {
  it("does not emit while supervised from the start", () => {
    const result = observeAutopilotAwayDigestSession(initialAutopilotAwayDigestTrackerState(), {
      now: NOW,
      autonomy: { mode: "supervised", setAt: END, setBy: "operator" },
    });

    expect(result.ended).toBeUndefined();
    expect(result.state.active).toBeUndefined();
  });

  it("emits exactly once when autopilot transitions back to supervised", () => {
    let state = initialAutopilotAwayDigestTrackerState();

    let result = observeAutopilotAwayDigestSession(state, {
      now: new Date(START),
      autonomy: { mode: "autopilot", setAt: START, until: END, setBy: "operator" },
    });
    state = result.state;

    result = observeAutopilotAwayDigestSession(state, {
      now: NOW,
      autonomy: { mode: "supervised", setAt: END, setBy: "operator-return" },
    });

    expect(result.ended).toMatchObject({
      sessionId: `autopilot:${START}`,
      startedAt: START,
      endedAt: END,
      endedBy: "operator-return",
    });

    const duplicate = observeAutopilotAwayDigestSession(result.state, {
      now: new Date("2026-05-31T09:01:00.000Z"),
      autonomy: { mode: "supervised", setAt: END, setBy: "operator-return" },
    });
    expect(duplicate.ended).toBeUndefined();
  });

  it("treats a D3 suspend as a session end", () => {
    let state = observeAutopilotAwayDigestSession(initialAutopilotAwayDigestTrackerState(), {
      now: new Date(START),
      autonomy: { mode: "autopilot", setAt: START, until: END, setBy: "operator" },
    }).state;

    const result = observeAutopilotAwayDigestSession(state, {
      now: NOW,
      autonomy: { mode: "autopilot", setAt: START, until: "2026-05-31T12:00:00.000Z", setBy: "operator" },
      suspended: true,
    });

    expect(result.ended).toMatchObject({ endedBy: "d3-suspend" });
  });

  it("can emit from an expiry transition even if the process missed the active tick", () => {
    const result = observeAutopilotAwayDigestSession(initialAutopilotAwayDigestTrackerState(), {
      now: NOW,
      autonomy: { mode: "supervised", setAt: END, setBy: "autopilot-expiry" },
      endedAutonomy: { mode: "autopilot", setAt: START, until: END, setBy: "operator" },
      endedBy: "autopilot-expiry",
    });

    expect(result.ended).toMatchObject({
      sessionId: `autopilot:${START}`,
      endedBy: "autopilot-expiry",
    });
  });
});

describe("autopilot away digest aggregation", () => {
  const tasks: CodexTask[] = [
    task({
      id: "task-auto",
      title: "Tweak monitor copy",
      agent: "claude",
      riskTier: "low",
      routingReason: "claude had better UI score",
      approvedAt: "2026-05-31T08:05:00.000Z",
      approvedBy: "hermes-autopilot",
      status: "approved",
    }),
    task({
      id: "task-high",
      title: "Touch deploy secrets",
      riskTier: "high",
      routingReason: "deploy/secrets are high-risk",
      createdAt: "2026-05-31T08:10:00.000Z",
    }),
    task({
      id: "task-pr",
      title: "Open a follow-up PR",
      agent: "claude",
      status: "completed",
      completedAt: "2026-05-31T08:30:00.000Z",
      completionSummary: "Opened https://github.com/depre-dev/averray-reference-agent/pull/321",
    }),
    task({
      id: "task-failed",
      title: "Try flaky fix",
      status: "failed",
      failedAt: "2026-05-31T08:40:00.000Z",
      failureReason: "CI failed",
    }),
  ];

  const auditEvents: AutopilotAuditEvent[] = [
    {
      at: "2026-05-31T08:11:00.000Z",
      commandText: "autopilot escalated: task-high",
      result: {
        kind: "autopilot_auto_approval",
        action: "escalated",
        taskId: "task-high",
        riskTier: "high",
        reason: "high_risk_escalated",
        detail: "deploy/secrets are high-risk",
      },
    },
    {
      at: "2026-05-31T08:45:00.000Z",
      commandText: "anomaly autopause",
      result: {
        kind: "anomaly_autopause",
        reason: "runner failures spiked",
        message: "Autopilot paused after runner failures spiked.",
      },
    },
  ];

  const boardCards: AwayDigestBoardCard[] = [
    {
      id: "card-review",
      lane: "operator-review",
      title: "Approve high-risk deploy change",
      summary: "Needs operator risk decision.",
      repo: "depre-dev/averray-reference-agent",
      agentType: "codex",
      waitingOn: { actor: "operator", tone: "warn" },
      state: "fresh",
      next: "Operator should approve or send back.",
    },
    {
      id: "card-checking",
      lane: "hermes-checking",
      title: "Hermes checking",
      summary: "No action.",
      repo: "depre-dev/averray-reference-agent",
      agentType: "hermes",
      waitingOn: { actor: "agent", tone: "neutral" },
      state: "fresh",
    },
  ];

  it("counts routed, auto-approved, escalated, opened PRs, failures, D3 suspends, and waiting work", () => {
    const digest = buildAutopilotAwayDigest({
      session: {
        sessionId: `autopilot:${START}`,
        startedAt: START,
        endedAt: END,
        endedBy: "operator-return",
      },
      generatedAt: NOW,
      tasks,
      auditEvents,
      boardCards,
    });

    expect(digest.counts).toEqual({
      routed: 4,
      autoApproved: 1,
      escalated: 1,
      openedPrs: 1,
      failures: 1,
      d3Suspends: 1,
      waitingOnOperator: 1,
    });
    expect(digest.autoApproved[0]).toMatchObject({
      title: "Tweak monitor copy",
      riskTier: "low",
      reason: "claude had better UI score",
    });
    expect(digest.escalated[0]).toMatchObject({
      id: "task-high",
      reason: "deploy/secrets are high-risk",
    });
    expect(digest.waitingOnOperator[0]).toMatchObject({
      id: "card-review",
      status: "operator-review",
    });

    const text = formatAutopilotAwayDigestForOperator(digest);
    expect(text).toContain("While you were away");
    expect(text).toContain("auto-approved 1");
    expect(text).toContain("Waiting on you");
  });

  it("returns a minimal digest for an empty session", () => {
    const digest = buildAutopilotAwayDigest({
      session: {
        sessionId: `autopilot:${START}`,
        startedAt: START,
        endedAt: END,
        endedBy: "autopilot-expiry",
      },
      generatedAt: NOW,
      tasks: [],
      auditEvents: [],
      boardCards: [],
    });

    expect(digest.headline).toContain("nothing needed action");
    expect(digest.recommendedNextActions).toEqual(["Nothing needs you right now."]);
  });

  it("delivers to board, alert bridge, and audit sinks", async () => {
    const recordBoardDigest = vi.fn(async () => undefined);
    const auditDigest = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => true);

    const digest = await deliverAutopilotAwayDigest({
      session: {
        sessionId: `autopilot:${START}`,
        startedAt: START,
        endedAt: END,
        endedBy: "operator-return",
      },
      now: () => NOW,
      boardUrl: "https://monitor.averray.com/monitor",
      loadTasks: async () => tasks,
      loadAuditEvents: async () => auditEvents,
      loadBoardCards: async () => boardCards,
      recordBoardDigest,
      alert: { name: "test", dispatch },
      auditDigest,
    });

    expect(digest.counts.autoApproved).toBe(1);
    expect(recordBoardDigest).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(auditDigest).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].text).toContain("While you were away");
  });
});
