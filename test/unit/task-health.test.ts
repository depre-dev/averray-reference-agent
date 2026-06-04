import { describe, expect, it, vi } from "vitest";

import type { CodexTask } from "../../services/slack-operator/src/codex-task-queue.js";
import {
  decideTaskHealthAction,
  runTaskHealthOnce,
  summarizeTaskHealth,
  type TaskHealthConfig,
} from "../../services/slack-operator/src/task-health.js";

const config: TaskHealthConfig = {
  enabled: true,
  intervalMs: 60_000,
  maxRetries: 1,
  retryBackoffMs: 10 * 60_000,
  approvedStaleMs: 30 * 60_000,
  runningStaleMs: 20 * 60_000,
  restartRecoveryMs: 10 * 60_000,
};

function task(overrides: Partial<CodexTask>): CodexTask {
  return {
    schemaVersion: 1,
    kind: "codex_task",
    id: "task-1",
    status: "failed",
    repo: "depre-dev/averray-reference-agent",
    agent: "codex",
    prompt: "fix it",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("task health self-management", () => {
  it("retries a failed task once after backoff, then escalates when retry budget is spent", async () => {
    const now = new Date("2026-06-01T10:30:00.000Z");
    const retry = await decideTaskHealthAction(
      task({
        id: "retry-me",
        failedAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      }),
      {
        config,
        now,
        suspended: false,
        halt: false,
        dispatch: { allowed: true, reason: "dispatch_allowed" },
      },
    );

    expect(retry).toMatchObject({
      taskId: "retry-me",
      action: "retry",
      reason: "bounded_retry",
    });

    const exhausted = await decideTaskHealthAction(
      task({
        id: "escalate-me",
        retryCount: 1,
        failedAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      }),
      {
        config,
        now,
        suspended: false,
        halt: false,
        dispatch: { allowed: true, reason: "dispatch_allowed" },
      },
    );

    expect(exhausted).toMatchObject({
      taskId: "escalate-me",
      action: "escalate",
      reason: "retry_budget_exhausted",
    });
  });

  it("schedules backoff once and does not emit duplicate retry proposals while waiting", async () => {
    const now = new Date("2026-06-01T10:05:00.000Z");
    const failed = task({
      failedAt: "2026-06-01T10:00:00.000Z",
      updatedAt: "2026-06-01T10:00:00.000Z",
    });

    const first = await decideTaskHealthAction(failed, {
      config,
      now,
      suspended: false,
      halt: false,
      dispatch: { allowed: true, reason: "dispatch_allowed" },
    });
    expect(first).toMatchObject({
      action: "defer_retry",
      reason: "retry_backoff_wait",
      retryAfter: new Date("2026-06-01T10:10:00.000Z"),
    });

    const second = await decideTaskHealthAction({ ...failed, retryAfter: "2026-06-01T10:10:00.000Z" }, {
      config,
      now,
      suspended: false,
      halt: false,
      dispatch: { allowed: true, reason: "dispatch_allowed" },
    });
    expect(second).toMatchObject({
      action: "none",
      reason: "retry_backoff_pending",
    });
  });

  it("escalates invalid self-healing tasks that target the placeholder testbed mission repo instead of retrying", async () => {
    const action = await decideTaskHealthAction(
      task({
        id: "bad-self-heal",
        requester: "hermes-self-healing",
        repo: "testbed/mission",
        agent: "claude",
        failedAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      }),
      {
        config,
        now: new Date("2026-06-01T10:30:00.000Z"),
        suspended: false,
        halt: false,
        dispatch: { allowed: true, reason: "dispatch_allowed" },
      },
    );

    expect(action).toMatchObject({
      taskId: "bad-self-heal",
      action: "escalate",
      reason: "invalid_self_healing_target:testbed_mission_not_a_repo",
    });
  });

  it("escalates stale running placeholder self-healing tasks before restart recovery", async () => {
    const retryTask = vi.fn();
    const escalateTask = vi.fn();

    const result = await runTaskHealthOnce(config, {
      listTasks: () => [
        task({
          id: "running-bad-self-heal",
          status: "running",
          requester: "hermes-self-healing",
          repo: "testbed/mission",
          agent: "claude",
          startedAt: "2026-06-01T09:40:00.000Z",
          progressAt: "2026-06-01T09:40:00.000Z",
          updatedAt: "2026-06-01T09:40:00.000Z",
          attemptCount: 1,
        }),
      ],
      readRunner: () => undefined,
      retryTask,
      deferRetry: vi.fn(),
      escalateTask,
      isSuspended: () => false,
      isHalt: () => false,
      dispatchAllowed: () => ({ allowed: true, reason: "dispatch_allowed" }),
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result.actions).toEqual([
      {
        taskId: "running-bad-self-heal",
        action: "escalate",
        reason: "invalid_self_healing_target:testbed_mission_not_a_repo",
      },
    ]);
    expect(retryTask).not.toHaveBeenCalled();
    expect(escalateTask).toHaveBeenCalledWith(
      "running-bad-self-heal",
      "invalid_self_healing_target:testbed_mission_not_a_repo",
    );
  });

  it("escalates approved tasks that sit past the stale threshold", async () => {
    const action = await decideTaskHealthAction(
      task({
        id: "approved-stale",
        status: "approved",
        approvedAt: "2026-06-01T09:00:00.000Z",
        updatedAt: "2026-06-01T09:00:00.000Z",
      }),
      {
        config,
        now: new Date("2026-06-01T10:00:00.000Z"),
        suspended: false,
        halt: false,
        dispatch: { allowed: true, reason: "dispatch_not_needed" },
      },
    );

    expect(action).toMatchObject({
      taskId: "approved-stale",
      action: "escalate",
      reason: "approved_task_stale",
    });
  });

  it("requeues stale running tasks after a restart when the runner heartbeat no longer owns them", async () => {
    const retryTask = vi.fn();
    const escalateTask = vi.fn();

    const result = await runTaskHealthOnce(config, {
      listTasks: () => [
        task({
          id: "running-orphan",
          status: "running",
          startedAt: "2026-06-01T09:40:00.000Z",
          progressAt: "2026-06-01T09:40:00.000Z",
          updatedAt: "2026-06-01T09:40:00.000Z",
          attemptCount: 1,
        }),
      ],
      readRunner: () => undefined,
      retryTask,
      deferRetry: vi.fn(),
      escalateTask,
      isSuspended: () => false,
      isHalt: () => false,
      dispatchAllowed: () => ({ allowed: true, reason: "dispatch_allowed" }),
      now: () => new Date("2026-06-01T10:00:00.000Z"),
    });

    expect(result.actions).toEqual([
      {
        taskId: "running-orphan",
        action: "retry",
        reason: "restart_recovery_requeue",
      },
    ]);
    expect(retryTask).toHaveBeenCalledWith("running-orphan", "restart_recovery_requeue");
    expect(escalateTask).not.toHaveBeenCalled();
  });

  it("respects D3 anomaly pause before retrying into another dispatch", async () => {
    const result = await decideTaskHealthAction(
      task({
        failedAt: "2026-06-01T10:00:00.000Z",
        updatedAt: "2026-06-01T10:00:00.000Z",
      }),
      {
        config,
        now: new Date("2026-06-01T10:30:00.000Z"),
        suspended: true,
        halt: false,
        dispatch: { allowed: true, reason: "dispatch_allowed" },
      },
    );

    expect(result).toMatchObject({
      action: "escalate",
      reason: "autopilot_suspended",
    });
  });

  it("summarizes claimed-but-silent work as stuck, distinct from genuinely running", () => {
    const now = new Date("2026-06-01T10:00:00.000Z");
    const summary = summarizeTaskHealth([
      task({
        id: "running-stuck",
        status: "running",
        startedAt: "2026-06-01T09:40:00.000Z",
        progressAt: "2026-06-01T09:40:00.000Z",
        updatedAt: "2026-06-01T09:40:00.000Z",
      }),
      task({
        id: "running-fresh",
        status: "running",
        startedAt: "2026-06-01T09:59:00.000Z",
        progressAt: "2026-06-01T09:59:00.000Z",
        updatedAt: "2026-06-01T09:59:00.000Z",
      }),
    ], {
      config,
      now,
      sourceAvailable: true,
    });

    expect(summary).toMatchObject({
      status: "stuck",
      runningTasks: 2,
      stuckTasks: 1,
      runner: {
        status: "missing",
        reason: "no_runner_heartbeat",
      },
    });
  });

  it("marks task health unknown instead of zero when the queue source is unavailable", () => {
    const summary = summarizeTaskHealth([], {
      config,
      now: new Date("2026-06-01T10:00:00.000Z"),
      sourceAvailable: false,
    });

    expect(summary).toEqual({
      status: "unknown",
      runningTasks: 0,
      stuckTasks: 0,
      retryWaitingTasks: 0,
      escalatedTasks: 0,
      runner: { status: "unknown", reason: "task_queue_unavailable" },
    });
  });
});
