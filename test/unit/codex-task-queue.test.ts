import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveCodexTask,
  cancelCodexTask,
  claimNextApprovedCodexTask,
  completeCodexTask,
  failCodexTask,
  listCodexTasks,
  proposeCodexTask,
  readCodexRunnerHeartbeat,
  summarizeCodexTasks,
  updateCodexTaskProgress,
  updateCodexRunnerHeartbeat,
} from "../../services/slack-operator/src/codex-task-queue.js";

describe("codex task queue", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempQueuePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "averray-codex-tasks-"));
    tempDirs.push(dir);
    return join(dir, "tasks.json");
  }

  it("proposes, dedupes, and approves active Codex tasks by PR", async () => {
    const path = await tempQueuePath();
    const first = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 385,
      correlationId: "github-pr-385",
      title: "Finish draft",
      prompt: "Continue PR #385.",
      reason: "draft PR",
      requester: "monitor",
    }, { path, now: new Date("2026-05-17T10:00:00.000Z") });

    expect(first.created).toBe(true);
    expect(first.task.status).toBe("proposed");

    const second = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 385,
      prompt: "Continue PR #385 with updated context.",
      requester: "monitor",
    }, { path, now: new Date("2026-05-17T10:05:00.000Z") });

    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.prompt).toBe("Continue PR #385 with updated context.");

    const approved = await approveCodexTask(first.task.id, {
      path,
      approvedBy: "operator",
      now: new Date("2026-05-17T10:06:00.000Z"),
    });

    expect(approved).toMatchObject({
      id: first.task.id,
      status: "approved",
      approvedBy: "operator",
    });

    const tasks = await listCodexTasks({ path });
    expect(tasks).toHaveLength(1);
    expect(summarizeCodexTasks(tasks).counts).toMatchObject({
      total: 1,
      proposed: 0,
      approved: 1,
      running: 0,
      terminal: 0,
    });
  });

  it("allows a fresh proposal after a task is cancelled", async () => {
    const path = await tempQueuePath();
    const first = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 386,
      prompt: "Fix PR #386.",
    }, { path, now: new Date("2026-05-17T11:00:00.000Z") });

    await cancelCodexTask(first.task.id, {
      path,
      cancelledBy: "operator",
      now: new Date("2026-05-17T11:02:00.000Z"),
    });

    const second = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 386,
      prompt: "Fix PR #386 after cancellation.",
    }, { path, now: new Date("2026-05-17T11:03:00.000Z") });

    expect(second.created).toBe(true);
    expect(second.task.id).not.toBe(first.task.id);

    const tasks = await listCodexTasks({ path });
    expect(tasks).toHaveLength(2);
    expect(summarizeCodexTasks(tasks).counts).toMatchObject({
      total: 2,
      proposed: 1,
      terminal: 1,
    });
  });

  it("claims the oldest approved task and records runner completion", async () => {
    const path = await tempQueuePath();
    const first = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 387,
      prompt: "Fix PR #387.",
    }, { path, now: new Date("2026-05-17T12:00:00.000Z") });
    const second = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 388,
      prompt: "Fix PR #388.",
    }, { path, now: new Date("2026-05-17T12:01:00.000Z") });

    await approveCodexTask(second.task.id, { path, now: new Date("2026-05-17T12:02:00.000Z") });
    await approveCodexTask(first.task.id, { path, now: new Date("2026-05-17T12:03:00.000Z") });

    const claimed = await claimNextApprovedCodexTask({
      path,
      runnerId: "runner-a",
      now: new Date("2026-05-17T12:04:00.000Z"),
    });

    expect(claimed).toMatchObject({
      id: second.task.id,
      status: "running",
      runnerId: "runner-a",
      attemptCount: 1,
      progressMessage: "Codex runner claimed the task.",
    });

    const progress = await updateCodexTaskProgress(second.task.id, {
      path,
      progressMessage: "Codex is editing files.",
      stdoutTail: "editing files",
      now: new Date("2026-05-17T12:04:30.000Z"),
    });

    expect(progress).toMatchObject({
      status: "running",
      progressMessage: "Codex is editing files.",
      stdoutTail: "editing files",
    });

    const completed = await completeCodexTask(second.task.id, {
      path,
      completionSummary: "Pushed fix.",
      exitCode: 0,
      stdoutTail: "ok",
      now: new Date("2026-05-17T12:05:00.000Z"),
    });

    expect(completed).toMatchObject({
      status: "completed",
      completionSummary: "Pushed fix.",
      progressMessage: "Pushed fix.",
      exitCode: 0,
      stdoutTail: "ok",
    });
    expect(completed?.events?.map((entry) => entry.status)).toEqual([
      "proposed",
      "approved",
      "running",
      "progress",
      "completed",
    ]);
    expect(summarizeCodexTasks(await listCodexTasks({ path })).counts).toMatchObject({
      approved: 1,
      running: 0,
      terminal: 1,
    });
  });

  it("records runner failures without claiming another task", async () => {
    const path = await tempQueuePath();
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 389,
      prompt: "Fix PR #389.",
    }, { path, now: new Date("2026-05-17T13:00:00.000Z") });
    await approveCodexTask(proposed.task.id, { path, now: new Date("2026-05-17T13:01:00.000Z") });
    await claimNextApprovedCodexTask({ path, runnerId: "runner-b", now: new Date("2026-05-17T13:02:00.000Z") });

    const failed = await failCodexTask(proposed.task.id, {
      path,
      failureReason: "CI stayed red.",
      exitCode: 2,
      stderrTail: "failed",
      now: new Date("2026-05-17T13:03:00.000Z"),
    });

    expect(failed).toMatchObject({
      status: "failed",
      failureReason: "CI stayed red.",
      exitCode: 2,
      stderrTail: "failed",
    });
    expect(await claimNextApprovedCodexTask({ path })).toBeUndefined();
  });

  it("records runner heartbeat and includes freshness in queue summary", async () => {
    const path = await tempQueuePath();
    const heartbeat = await updateCodexRunnerHeartbeat({
      path,
      runnerId: "runner-a",
      status: "idle",
      message: "waiting for approved work",
      now: new Date("2026-05-17T14:00:00.000Z"),
    });

    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({
      kind: "codex_runner_heartbeat",
      runnerId: "runner-a",
      status: "idle",
      message: "waiting for approved work",
    });

    expect(summarizeCodexTasks([], 100, {
      runner: heartbeat,
      now: new Date("2026-05-17T14:00:10.000Z"),
    })).toMatchObject({
      runner: {
        runnerId: "runner-a",
        status: "idle",
        ageMs: 10_000,
        stale: false,
      },
    });
  });
});
