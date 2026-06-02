import type { DispatchPolicyDecision } from "@avg/averray-mcp/dispatch-policy";

import type { CodexRunnerHeartbeat, CodexTask } from "./codex-task-queue.js";

export interface TaskHealthConfig {
  enabled: boolean;
  intervalMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  approvedStaleMs: number;
  runningStaleMs: number;
  restartRecoveryMs: number;
}

export interface TaskHealthAction {
  taskId: string;
  action: "retry" | "defer_retry" | "escalate" | "none";
  reason: string;
  retryAfter?: Date;
}

export interface TaskHealthDeps {
  listTasks: () => Promise<CodexTask[]> | CodexTask[];
  readRunner: () => Promise<CodexRunnerHeartbeat | undefined> | CodexRunnerHeartbeat | undefined;
  retryTask: (id: string, reason: string) => Promise<unknown> | unknown;
  deferRetry: (id: string, retryAfter: Date, reason: string) => Promise<unknown> | unknown;
  escalateTask: (id: string, reason: string) => Promise<unknown> | unknown;
  isSuspended: () => boolean;
  isHalt: () => boolean;
  dispatchAllowed: (task: CodexTask) => Promise<DispatchPolicyDecision> | DispatchPolicyDecision;
  audit?: (action: TaskHealthAction) => Promise<unknown> | unknown;
  now: () => Date;
}

export interface TaskHealthResult {
  actions: TaskHealthAction[];
}

const TERMINAL_NO_ACTION = new Set(["completed", "cancelled"]);

export async function runTaskHealthOnce(
  config: TaskHealthConfig,
  deps: TaskHealthDeps,
): Promise<TaskHealthResult> {
  if (!config.enabled) return { actions: [] };
  const now = deps.now();
  const tasks = await deps.listTasks();
  const runner = await deps.readRunner();
  const actions: TaskHealthAction[] = [];

  for (const task of tasks) {
    const action = await decideTaskHealthAction(task, {
      config,
      now,
      runner,
      suspended: deps.isSuspended(),
      halt: deps.isHalt(),
      dispatch: task.status === "failed" || task.status === "running"
        ? await deps.dispatchAllowed(task)
        : { allowed: true, reason: "dispatch_not_needed" },
    });
    if (action.action === "none") continue;
    actions.push(action);
    if (action.action === "retry") {
      await deps.retryTask(action.taskId, action.reason);
    } else if (action.action === "defer_retry" && action.retryAfter) {
      await deps.deferRetry(action.taskId, action.retryAfter, action.reason);
    } else if (action.action === "escalate") {
      await deps.escalateTask(action.taskId, action.reason);
    }
    await deps.audit?.(action);
  }

  return { actions };
}

export async function decideTaskHealthAction(
  task: CodexTask,
  ctx: {
    config: TaskHealthConfig;
    now: Date;
    runner?: CodexRunnerHeartbeat;
    suspended: boolean;
    halt: boolean;
    dispatch: DispatchPolicyDecision;
  },
): Promise<TaskHealthAction> {
  const base = { taskId: task.id };
  if (TERMINAL_NO_ACTION.has(task.status)) return { ...base, action: "none", reason: "terminal" };
  if (task.selfManagementEscalatedAt) return { ...base, action: "none", reason: "already_escalated" };
  if (isInvalidSelfHealingTarget(task)) {
    return { ...base, action: "escalate", reason: "invalid_self_healing_target:testbed_mission_not_a_repo" };
  }

  if (task.status === "failed") {
    const scheduledRetry = parseDate(task.retryAfter);
    if (scheduledRetry && scheduledRetry.getTime() > ctx.now.getTime()) {
      return { ...base, action: "none", reason: "retry_backoff_pending" };
    }
    if (!mayRetry(task, ctx.config)) return { ...base, action: "escalate", reason: "retry_budget_exhausted" };
    if (ctx.halt) return { ...base, action: "escalate", reason: "halt_present" };
    if (ctx.suspended) return { ...base, action: "escalate", reason: "autopilot_suspended" };
    if (!ctx.dispatch.allowed) return { ...base, action: "escalate", reason: `dispatch_blocked:${ctx.dispatch.reason}` };

    const retryAfter = nextRetryAfter(task, ctx.config, ctx.now);
    if (retryAfter.getTime() > ctx.now.getTime()) {
      return { ...base, action: "defer_retry", reason: "retry_backoff_wait", retryAfter };
    }
    return { ...base, action: "retry", reason: "bounded_retry" };
  }

  if (task.status === "approved") {
    const approvedAgeMs = ageMs(task.approvedAt ?? task.updatedAt, ctx.now);
    if (approvedAgeMs >= ctx.config.approvedStaleMs) {
      return { ...base, action: "escalate", reason: "approved_task_stale" };
    }
    return { ...base, action: "none", reason: "approved_fresh" };
  }

  if (task.status === "running") {
    const staleAgeMs = ageMs(task.progressAt ?? task.startedAt ?? task.updatedAt, ctx.now);
    const runner = runnerStateForTask(task, ctx.runner, ctx.now);
    if (runner.unavailable && staleAgeMs >= ctx.config.restartRecoveryMs) {
      if (!mayRetry(task, ctx.config)) return { ...base, action: "escalate", reason: "restart_recovery_retry_budget_exhausted" };
      if (ctx.halt) return { ...base, action: "escalate", reason: "halt_present" };
      if (ctx.suspended) return { ...base, action: "escalate", reason: "autopilot_suspended" };
      if (!ctx.dispatch.allowed) return { ...base, action: "escalate", reason: `dispatch_blocked:${ctx.dispatch.reason}` };
      return { ...base, action: "retry", reason: "restart_recovery_requeue" };
    }
    if (staleAgeMs >= ctx.config.runningStaleMs) {
      return { ...base, action: "escalate", reason: runner.activeTaskMismatch ? "runner_active_task_mismatch" : "running_task_stale" };
    }
    return { ...base, action: "none", reason: "running_fresh" };
  }

  return { ...base, action: "none", reason: "not_managed" };
}

function isInvalidSelfHealingTarget(task: CodexTask): boolean {
  return task.requester === "hermes-self-healing" && task.repo === "testbed/mission";
}

function mayRetry(task: CodexTask, config: TaskHealthConfig): boolean {
  return Math.max(0, Math.floor(task.retryCount ?? 0)) < config.maxRetries;
}

function nextRetryAfter(task: CodexTask, config: TaskHealthConfig, now: Date): Date {
  const failedAt = Date.parse(task.failedAt ?? task.updatedAt);
  const start = Number.isFinite(failedAt) ? failedAt : now.getTime();
  const retryCount = Math.max(0, Math.floor(task.retryCount ?? 0));
  const backoff = config.retryBackoffMs * Math.max(1, 2 ** retryCount);
  return new Date(start + backoff);
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

function runnerStateForTask(
  task: CodexTask,
  runner: CodexRunnerHeartbeat | undefined,
  now: Date,
): { unavailable: boolean; activeTaskMismatch: boolean } {
  if (!runner) return { unavailable: true, activeTaskMismatch: false };
  const heartbeatAgeMs = ageMs(runner.updatedAt, now);
  const stale = heartbeatAgeMs > 90_000;
  const unavailable = stale || runner.status === "disabled" || runner.status === "misconfigured" || runner.status === "error" || runner.status === "failed";
  const activeTaskMismatch = Boolean(runner.activeTaskId && runner.activeTaskId !== task.id);
  return { unavailable: unavailable || activeTaskMismatch, activeTaskMismatch };
}

function ageMs(value: string | undefined, now: Date): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, now.getTime() - parsed);
}
