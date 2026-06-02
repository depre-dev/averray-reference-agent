import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HermesDecisionRecord } from "@avg/averray-mcp/decision-records";

export type CodexTaskStatus =
  | "proposed"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type CodexRunnerHeartbeatStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "disabled"
  | "misconfigured"
  | "error";

/**
 * Which agent a task is dispatched to. Defaults to "codex" everywhere so
 * existing tasks and callers keep working unchanged; "claude" is the
 * greenfield Claude-worker path (P2), and C3 specialists (for example
 * "test-writer", "security", "docs") use the same per-agent filter. Resolve a
 * possibly-absent value via {@link taskAgent}.
 */
export type TaskAgent = "codex" | "claude" | "test-writer" | "security" | "docs" | (string & {});

/** Resolve a task's agent, defaulting legacy/undefined tasks to "codex". */
export function taskAgent(task: { agent?: TaskAgent | string }): TaskAgent {
  const agent = typeof task.agent === "string" ? task.agent.trim() : "";
  return agent ? (agent as TaskAgent) : "codex";
}

export interface CodexTaskInput {
  repo: string;
  /**
   * The PR this task acts on. Optional: greenfield tasks (Claude opens
   * its own PR) have no PR number yet. When present, propose dedupes on
   * repo + PR; when absent each task is distinct.
   */
  pullRequestNumber?: number;
  /** Which agent runs this task. Defaults to "codex". */
  agent?: TaskAgent;
  correlationId?: string;
  title?: string;
  prompt: string;
  reason?: string;
  requester?: string;
  /** O4-PR2 routing: the static-default risk tier (PR3 autopilot reads it). */
  riskTier?: "high" | "low";
  /** O4-PR2 routing: the one-line reason for the agent + tier (board + alert). */
  routingReason?: string;
  /** D2: why Hermes routed/proposed this task. */
  decisionRecord?: HermesDecisionRecord;
}

export interface CodexTaskEvent {
  at: string;
  status: CodexTaskStatus | "progress";
  message: string;
}

export interface CodexTaskWorkingNow {
  agent: TaskAgent;
  runnerId: string;
  label: string;
  since: string;
}

export interface CodexTask extends CodexTaskInput {
  schemaVersion: 1;
  kind: "codex_task";
  id: string;
  status: CodexTaskStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  approvedBy?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  startedAt?: string;
  runnerId?: string;
  attemptCount?: number;
  completedAt?: string;
  completionSummary?: string;
  failedAt?: string;
  failureReason?: string;
  exitCode?: number;
  stdoutTail?: string;
  stderrTail?: string;
  progressMessage?: string;
  progressAt?: string;
  workingNow?: CodexTaskWorkingNow;
  retryAfter?: string;
  retryCount?: number;
  selfManagementEscalatedAt?: string;
  selfManagementEscalationReason?: string;
  operatorDismissedAt?: string;
  operatorDismissedBy?: string;
  operatorSnoozedUntil?: string;
  operatorSnoozedBy?: string;
  events?: CodexTaskEvent[];
}

export interface CodexRunnerHeartbeat {
  schemaVersion: 1;
  kind: "codex_runner_heartbeat";
  runnerId: string;
  status: CodexRunnerHeartbeatStatus;
  message: string;
  updatedAt: string;
  activeTaskId?: string;
}

export interface CodexTaskQueueDeps {
  path?: string;
  now?: Date;
}

const TERMINAL_STATUSES = new Set<CodexTaskStatus>(["completed", "failed", "cancelled"]);

export async function listCodexTasks(deps: CodexTaskQueueDeps = {}): Promise<CodexTask[]> {
  const tasks = await readCodexTasks(queuePath(deps.path));
  return tasks.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export async function proposeCodexTask(
  input: CodexTaskInput,
  deps: CodexTaskQueueDeps = {}
): Promise<{ task: CodexTask; created: boolean }> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const now = (deps.now ?? new Date()).toISOString();
  // Dedupe only when the task targets a specific PR. Greenfield tasks
  // (no PR yet) are each distinct, so they always create a new entry.
  const existing = input.pullRequestNumber === undefined
    ? undefined
    : tasks.find((task) =>
        !TERMINAL_STATUSES.has(task.status)
        && task.repo === input.repo
        && task.pullRequestNumber === input.pullRequestNumber
      );
  if (existing) {
    const updated: CodexTask = {
      ...existing,
      correlationId: input.correlationId ?? existing.correlationId,
      title: input.title ?? existing.title,
      prompt: input.prompt || existing.prompt,
      reason: input.reason ?? existing.reason,
      requester: input.requester ?? existing.requester,
      decisionRecord: input.decisionRecord ?? existing.decisionRecord,
      updatedAt: now,
    };
    await writeCodexTasks(path, replaceTask(tasks, updated));
    return { task: updated, created: false };
  }

  const task: CodexTask = {
    schemaVersion: 1,
    kind: "codex_task",
    id: makeCodexTaskId(input.repo, input.pullRequestNumber, now),
    status: "proposed",
    repo: input.repo,
    agent: input.agent ?? "codex",
    ...(input.pullRequestNumber !== undefined ? { pullRequestNumber: input.pullRequestNumber } : {}),
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.title ? { title: input.title } : {}),
    prompt: input.prompt,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.requester ? { requester: input.requester } : {}),
    ...(input.riskTier ? { riskTier: input.riskTier } : {}),
    ...(input.routingReason ? { routingReason: input.routingReason } : {}),
    ...(input.decisionRecord ? { decisionRecord: input.decisionRecord } : {}),
    createdAt: now,
    updatedAt: now,
    events: [{
      at: now,
      status: "proposed",
      message: initialCodexTaskEventMessage(input),
    }],
  };
  await writeCodexTasks(path, [...tasks, task]);
  return { task, created: true };
}

function initialCodexTaskEventMessage(input: CodexTaskInput): string {
  const reason = (input.reason ?? "").toLowerCase();
  const agent = taskAgent(input);
  if (reason.includes("operator sent review back")) {
    return "Operator sent review back to Codex from the monitor.";
  }
  if (reason.includes("operator explicitly delegated")) {
    return "Operator delegated Codex takeover from the monitor.";
  }
  return `Hermes proposed a bounded ${taskAgentEventLabel(agent)} task.`;
}

function taskAgentEventLabel(agent: TaskAgent): string {
  if (agent === "codex") return "Codex";
  if (agent === "claude") return "Claude";
  if (agent === "test-writer") return "test-writer";
  if (agent === "security") return "security";
  if (agent === "docs") return "docs";
  return agent;
}

function taskAgentWorkingNowLabel(agent: TaskAgent): string {
  if (agent === "codex") return "Codex fixing";
  if (agent === "claude") return "Claude fixing";
  if (agent === "test-writer") return "Test-writer writing tests";
  if (agent === "security") return "Security reviewing";
  if (agent === "docs") return "Docs updating";
  return `${agent} working`;
}

export async function approveCodexTask(
  id: string,
  deps: CodexTaskQueueDeps & { approvedBy?: string } = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  if (TERMINAL_STATUSES.has(existing.status)) return existing;
  const now = (deps.now ?? new Date()).toISOString();
  const task: CodexTask = {
    ...existing,
    status: existing.status === "running" ? "running" : "approved",
    approvedAt: existing.approvedAt ?? now,
    approvedBy: deps.approvedBy ?? existing.approvedBy ?? "monitor",
    events: appendTaskEvent(existing, {
      at: now,
      status: "approved",
      message: `Operator approved ${taskAgentEventLabel(taskAgent(existing))} dispatch.`,
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function annotateCodexTaskDecisionRecord(
  id: string,
  decisionRecord: HermesDecisionRecord,
  deps: CodexTaskQueueDeps = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  const now = (deps.now ?? new Date()).toISOString();
  const task: CodexTask = {
    ...existing,
    decisionRecord,
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function cancelCodexTask(
  id: string,
  deps: CodexTaskQueueDeps & { cancelledBy?: string } = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  if (TERMINAL_STATUSES.has(existing.status)) return existing;
  const now = (deps.now ?? new Date()).toISOString();
  const task: CodexTask = {
    ...existing,
    status: "cancelled",
    cancelledAt: now,
    cancelledBy: deps.cancelledBy ?? "monitor",
    workingNow: undefined,
    events: appendTaskEvent(existing, {
      at: now,
      status: "cancelled",
      message: "Operator cancelled this Codex task.",
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function claimNextApprovedCodexTask(
  deps: CodexTaskQueueDeps & { runnerId?: string; agent?: TaskAgent } = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  // A per-agent runner claims only its own tasks; an unfiltered call (no
  // `agent`) claims any approved task, preserving the current behavior.
  const existing = tasks
    .filter((task) =>
      task.status === "approved"
      && !isTaskSnoozed(task, deps.now ?? new Date())
      && (deps.agent === undefined || taskAgent(task) === deps.agent)
    )
    .sort((a, b) => Date.parse(a.approvedAt ?? a.updatedAt) - Date.parse(b.approvedAt ?? b.updatedAt))[0];
  if (!existing) return undefined;
  const now = (deps.now ?? new Date()).toISOString();
  const agent = taskAgent(existing);
  const runnerId = deps.runnerId ?? existing.runnerId ?? "codex-task-runner";
  const task: CodexTask = {
    ...existing,
    status: "running",
    startedAt: now,
    runnerId,
    attemptCount: (existing.attemptCount ?? 0) + 1,
    progressMessage: `${taskAgentEventLabel(agent)} runner claimed the task.`,
    progressAt: now,
    workingNow: {
      agent,
      runnerId,
      label: taskAgentWorkingNowLabel(agent),
      since: now,
    },
    events: appendTaskEvent(existing, {
      at: now,
      status: "running",
      message: `${taskAgentEventLabel(agent)} runner ${runnerId} claimed the task.`,
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function updateCodexTaskProgress(
  id: string,
  deps: CodexTaskQueueDeps & {
    progressMessage?: string;
    stdoutTail?: string;
    stderrTail?: string;
  } = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  if (TERMINAL_STATUSES.has(existing.status)) return existing;
  const now = (deps.now ?? new Date()).toISOString();
  const progressMessage = deps.progressMessage ?? existing.progressMessage ?? `${taskAgentEventLabel(taskAgent(existing))} runner is still working.`;
  const task: CodexTask = {
    ...existing,
    progressMessage,
    progressAt: now,
    ...(deps.stdoutTail ? { stdoutTail: deps.stdoutTail } : {}),
    ...(deps.stderrTail ? { stderrTail: deps.stderrTail } : {}),
    events: appendTaskEvent(existing, {
      at: now,
      status: "progress",
      message: progressMessage,
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function completeCodexTask(
  id: string,
  deps: CodexTaskQueueDeps & {
    completionSummary?: string;
    exitCode?: number;
    stdoutTail?: string;
    stderrTail?: string;
  } = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  if (existing.status !== "running") return existing;
  const now = (deps.now ?? new Date()).toISOString();
  const task: CodexTask = {
    ...existing,
    status: "completed",
    completedAt: now,
    workingNow: undefined,
    ...(deps.completionSummary ? { completionSummary: deps.completionSummary } : {}),
    ...(typeof deps.exitCode === "number" ? { exitCode: deps.exitCode } : {}),
    ...(deps.stdoutTail ? { stdoutTail: deps.stdoutTail } : {}),
    ...(deps.stderrTail ? { stderrTail: deps.stderrTail } : {}),
    progressMessage: deps.completionSummary ?? `${taskAgentEventLabel(taskAgent(existing))} runner completed the task.`,
    progressAt: now,
    events: appendTaskEvent(existing, {
      at: now,
      status: "completed",
      message: deps.completionSummary ?? `${taskAgentEventLabel(taskAgent(existing))} runner completed the task.`,
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function failCodexTask(
  id: string,
  deps: CodexTaskQueueDeps & {
    failureReason?: string;
    completionSummary?: string;
    exitCode?: number;
    stdoutTail?: string;
    stderrTail?: string;
  } = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  if (TERMINAL_STATUSES.has(existing.status)) return existing;
  const now = (deps.now ?? new Date()).toISOString();
  const failureReason = deps.failureReason ?? `${taskAgentEventLabel(taskAgent(existing))} task runner failed.`;
  const task: CodexTask = {
    ...existing,
    status: "failed",
    failedAt: now,
    workingNow: undefined,
    failureReason,
    completionSummary: deps.completionSummary ?? failureReason,
    ...(typeof deps.exitCode === "number" ? { exitCode: deps.exitCode } : {}),
    ...(deps.stdoutTail ? { stdoutTail: deps.stdoutTail } : {}),
    ...(deps.stderrTail ? { stderrTail: deps.stderrTail } : {}),
    progressMessage: failureReason,
    progressAt: now,
    events: appendTaskEvent(existing, {
      at: now,
      status: "failed",
      message: failureReason,
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function retryCodexTask(
  id: string,
  deps: CodexTaskQueueDeps & {
    approvedBy?: string;
    reason?: string;
  } = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  if (existing.status !== "failed" && existing.status !== "running") return existing;
  const now = (deps.now ?? new Date()).toISOString();
  const {
    retryAfter: _retryAfter,
    selfManagementEscalatedAt: _escalatedAt,
    selfManagementEscalationReason: _escalationReason,
    workingNow: _workingNow,
    runnerId: _runnerId,
    startedAt: _startedAt,
    failedAt: _failedAt,
    failureReason: _failureReason,
    exitCode: _exitCode,
    ...rest
  } = existing;
  const message = deps.reason ?? `${taskAgentEventLabel(taskAgent(existing))} task scheduled for bounded retry.`;
  const task: CodexTask = {
    ...rest,
    status: "approved",
    approvedAt: now,
    approvedBy: deps.approvedBy ?? "o5-self-management",
    retryCount: (existing.retryCount ?? 0) + 1,
    progressMessage: message,
    progressAt: now,
    events: appendTaskEvent(existing, {
      at: now,
      status: "approved",
      message,
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function deferCodexTaskRetry(
  id: string,
  deps: CodexTaskQueueDeps & {
    retryAfter: Date;
    reason?: string;
  }
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  if (existing.status !== "failed") return existing;
  const now = (deps.now ?? new Date()).toISOString();
  const retryAfter = deps.retryAfter.toISOString();
  const message = deps.reason ?? `${taskAgentEventLabel(taskAgent(existing))} task will be retried after ${retryAfter}.`;
  const task: CodexTask = {
    ...existing,
    retryAfter,
    progressMessage: message,
    progressAt: now,
    events: appendTaskEvent(existing, {
      at: now,
      status: "progress",
      message,
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function escalateCodexTask(
  id: string,
  deps: CodexTaskQueueDeps & {
    reason: string;
  }
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  if (existing.selfManagementEscalatedAt && existing.selfManagementEscalationReason === deps.reason) return existing;
  const now = (deps.now ?? new Date()).toISOString();
  const task: CodexTask = {
    ...existing,
    selfManagementEscalatedAt: now,
    selfManagementEscalationReason: deps.reason,
    progressMessage: deps.reason,
    progressAt: now,
    events: appendTaskEvent(existing, {
      at: now,
      status: "progress",
      message: deps.reason,
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function dismissCodexTask(
  id: string,
  deps: CodexTaskQueueDeps & { dismissedBy?: string } = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  const now = (deps.now ?? new Date()).toISOString();
  const shouldCancel = !TERMINAL_STATUSES.has(existing.status) && existing.status !== "running";
  const task: CodexTask = {
    ...existing,
    ...(shouldCancel ? { status: "cancelled" as const, cancelledAt: existing.cancelledAt ?? now, cancelledBy: deps.dismissedBy ?? existing.cancelledBy ?? "operator" } : {}),
    operatorDismissedAt: existing.operatorDismissedAt ?? now,
    operatorDismissedBy: deps.dismissedBy ?? existing.operatorDismissedBy ?? "operator",
    events: appendTaskEvent(existing, {
      at: now,
      status: shouldCancel ? "cancelled" : "progress",
      message: shouldCancel
        ? "Operator dismissed this card; task dispatch was cancelled."
        : "Operator dismissed this card.",
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function snoozeCodexTask(
  id: string,
  deps: CodexTaskQueueDeps & { snoozedUntil: Date; snoozedBy?: string }
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks.find((task) => task.id === id);
  if (!existing) return undefined;
  const now = (deps.now ?? new Date()).toISOString();
  const snoozedUntil = deps.snoozedUntil.toISOString();
  const task: CodexTask = {
    ...existing,
    operatorSnoozedUntil: snoozedUntil,
    operatorSnoozedBy: deps.snoozedBy ?? "operator",
    events: appendTaskEvent(existing, {
      at: now,
      status: "progress",
      message: `Operator snoozed this card until ${snoozedUntil}.`,
    }),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function readCodexRunnerHeartbeat(
  deps: CodexTaskQueueDeps = {}
): Promise<CodexRunnerHeartbeat | undefined> {
  try {
    const content = await readFile(runnerHeartbeatPath(deps.path), "utf8");
    const value: unknown = JSON.parse(content);
    return isCodexRunnerHeartbeat(value) ? value : undefined;
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

export async function updateCodexRunnerHeartbeat(
  deps: CodexTaskQueueDeps & {
    runnerId: string;
    status: CodexRunnerHeartbeatStatus;
    message?: string;
    activeTaskId?: string;
  }
): Promise<CodexRunnerHeartbeat> {
  const now = (deps.now ?? new Date()).toISOString();
  const heartbeat: CodexRunnerHeartbeat = {
    schemaVersion: 1,
    kind: "codex_runner_heartbeat",
    runnerId: deps.runnerId,
    status: deps.status,
    message: deps.message ?? codexRunnerStatusMessage(deps.status),
    updatedAt: now,
    ...(deps.activeTaskId ? { activeTaskId: deps.activeTaskId } : {}),
  };
  const path = runnerHeartbeatPath(deps.path);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(heartbeat, null, 2)}\n`);
  return heartbeat;
}

export function summarizeCodexTasks(
  tasks: CodexTask[],
  limit = 100,
  deps: { runner?: CodexRunnerHeartbeat; now?: Date } = {}
) {
  const sorted = tasks.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const runner = deps.runner ? summarizeCodexRunnerHeartbeat(deps.runner, deps.now ?? new Date()) : undefined;
  return {
    schemaVersion: 1,
    kind: "codex_task_queue",
    counts: {
      total: sorted.length,
      proposed: sorted.filter((task) => task.status === "proposed").length,
      approved: sorted.filter((task) => task.status === "approved").length,
      running: sorted.filter((task) => task.status === "running").length,
      terminal: sorted.filter((task) => TERMINAL_STATUSES.has(task.status)).length,
    },
    ...(runner ? { runner } : {}),
    items: sorted.slice(0, limit),
  };
}

async function readCodexTasks(path: string): Promise<CodexTask[]> {
  try {
    const content = await readFile(path, "utf8");
    const value: unknown = JSON.parse(content);
    if (!Array.isArray(value)) return [];
    return value.filter(isCodexTask);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function writeCodexTasks(path: string, tasks: CodexTask[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(tasks, null, 2)}\n`);
}

function replaceTask(tasks: CodexTask[], task: CodexTask): CodexTask[] {
  return tasks.map((entry) => entry.id === task.id ? task : entry);
}

function appendTaskEvent(task: CodexTask, event: CodexTaskEvent): CodexTaskEvent[] {
  return [...(task.events ?? []), event]
    .filter((entry) => entry.at && entry.status && entry.message)
    .slice(-25);
}

function isCodexTask(value: unknown): value is CodexTask {
  if (!isRecord(value)) return false;
  return value.kind === "codex_task"
    && value.schemaVersion === 1
    && typeof value.id === "string"
    && typeof value.repo === "string"
    // Optional: greenfield tasks have no PR yet. Reject only a wrong type.
    && (value.pullRequestNumber === undefined || typeof value.pullRequestNumber === "number")
    && typeof value.prompt === "string"
    && typeof value.status === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function queuePath(path?: string): string {
  return path
    ?? process.env.AVERRAY_CODEX_TASKS_PATH
    ?? "/tmp/averray-reference-agent/codex-tasks.json";
}

function runnerHeartbeatPath(path?: string): string {
  return `${queuePath(path)}.runner.json`;
}

function summarizeCodexRunnerHeartbeat(heartbeat: CodexRunnerHeartbeat, now: Date) {
  const updatedMs = Date.parse(heartbeat.updatedAt);
  const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now.getTime() - updatedMs) : undefined;
  return {
    ...heartbeat,
    ...(typeof ageMs === "number" ? { ageMs, stale: ageMs > 90_000 } : { stale: true }),
  };
}

function codexRunnerStatusMessage(status: CodexRunnerHeartbeatStatus): string {
  switch (status) {
    case "idle":
      return "Codex runner is online and waiting for an approved task.";
    case "running":
      return "Codex runner is executing a task.";
    case "completed":
      return "Codex runner completed its latest task.";
    case "failed":
      return "Codex runner failed its latest task.";
    case "disabled":
      return "Codex task runner is disabled.";
    case "misconfigured":
      return "Codex task runner is misconfigured.";
    case "error":
      return "Codex task runner hit an error.";
  }
}

export function isTaskDismissed(task: Pick<CodexTask, "operatorDismissedAt">): boolean {
  return Boolean(task.operatorDismissedAt);
}

export function isTaskSnoozed(task: Pick<CodexTask, "operatorSnoozedUntil">, now: Date = new Date()): boolean {
  if (!task.operatorSnoozedUntil) return false;
  const untilMs = Date.parse(task.operatorSnoozedUntil);
  return Number.isFinite(untilMs) && untilMs > now.getTime();
}

function makeCodexTaskId(repo: string, pullRequestNumber: number | undefined, timestamp: string): string {
  const safeRepo = repo.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const stamp = timestamp.replace(/[^0-9A-Za-z]/g, "");
  const prPart = pullRequestNumber ?? "new"; // greenfield tasks have no PR yet
  return `codex-task-${safeRepo}-${prPart}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function isCodexRunnerHeartbeat(value: unknown): value is CodexRunnerHeartbeat {
  if (!isRecord(value)) return false;
  return value.kind === "codex_runner_heartbeat"
    && value.schemaVersion === 1
    && typeof value.runnerId === "string"
    && typeof value.status === "string"
    && typeof value.message === "string"
    && typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
