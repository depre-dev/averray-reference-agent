import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CodexTaskStatus =
  | "proposed"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface CodexTaskInput {
  repo: string;
  pullRequestNumber: number;
  correlationId?: string;
  title?: string;
  prompt: string;
  reason?: string;
  requester?: string;
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
  const existing = tasks.find((task) =>
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
    pullRequestNumber: input.pullRequestNumber,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.title ? { title: input.title } : {}),
    prompt: input.prompt,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.requester ? { requester: input.requester } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await writeCodexTasks(path, [...tasks, task]);
  return { task, created: true };
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
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function claimNextApprovedCodexTask(
  deps: CodexTaskQueueDeps & { runnerId?: string } = {}
): Promise<CodexTask | undefined> {
  const path = queuePath(deps.path);
  const tasks = await readCodexTasks(path);
  const existing = tasks
    .filter((task) => task.status === "approved")
    .sort((a, b) => Date.parse(a.approvedAt ?? a.updatedAt) - Date.parse(b.approvedAt ?? b.updatedAt))[0];
  if (!existing) return undefined;
  const now = (deps.now ?? new Date()).toISOString();
  const task: CodexTask = {
    ...existing,
    status: "running",
    startedAt: now,
    runnerId: deps.runnerId ?? existing.runnerId ?? "codex-task-runner",
    attemptCount: (existing.attemptCount ?? 0) + 1,
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
    ...(deps.completionSummary ? { completionSummary: deps.completionSummary } : {}),
    ...(typeof deps.exitCode === "number" ? { exitCode: deps.exitCode } : {}),
    ...(deps.stdoutTail ? { stdoutTail: deps.stdoutTail } : {}),
    ...(deps.stderrTail ? { stderrTail: deps.stderrTail } : {}),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export async function failCodexTask(
  id: string,
  deps: CodexTaskQueueDeps & {
    failureReason?: string;
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
  const task: CodexTask = {
    ...existing,
    status: "failed",
    failedAt: now,
    failureReason: deps.failureReason ?? "Codex task runner failed.",
    ...(typeof deps.exitCode === "number" ? { exitCode: deps.exitCode } : {}),
    ...(deps.stdoutTail ? { stdoutTail: deps.stdoutTail } : {}),
    ...(deps.stderrTail ? { stderrTail: deps.stderrTail } : {}),
    updatedAt: now,
  };
  await writeCodexTasks(path, replaceTask(tasks, task));
  return task;
}

export function summarizeCodexTasks(tasks: CodexTask[], limit = 100) {
  const sorted = tasks.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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

function isCodexTask(value: unknown): value is CodexTask {
  if (!isRecord(value)) return false;
  return value.kind === "codex_task"
    && value.schemaVersion === 1
    && typeof value.id === "string"
    && typeof value.repo === "string"
    && typeof value.pullRequestNumber === "number"
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

function makeCodexTaskId(repo: string, pullRequestNumber: number, timestamp: string): string {
  const safeRepo = repo.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const stamp = timestamp.replace(/[^0-9A-Za-z]/g, "");
  return `codex-task-${safeRepo}-${pullRequestNumber}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
