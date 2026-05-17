import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveCodexTask,
  cancelCodexTask,
  listCodexTasks,
  proposeCodexTask,
  summarizeCodexTasks,
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
});
