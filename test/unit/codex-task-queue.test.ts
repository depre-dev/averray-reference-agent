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
  taskAgent,
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
    expect(first.task.events?.[0]?.message).toBe("Hermes proposed a bounded Codex task.");

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

  it("records explicit operator delegation in the initial task event", async () => {
    const path = await tempQueuePath();
    const result = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 439,
      title: "Draft takeover",
      prompt: "Take over PR #439.",
      reason: "operator explicitly delegated draft takeover to Codex",
      requester: "monitor",
    }, { path, now: new Date("2026-05-17T10:30:00.000Z") });

    expect(result.created).toBe(true);
    expect(result.task.events?.[0]?.message).toBe("Operator delegated Codex takeover from the monitor.");
  });

  it("records operator review send-back in the initial task event", async () => {
    const path = await tempQueuePath();
    const result = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 151,
      title: "Operator send-back",
      prompt: "Follow up on PR #151.",
      reason: "operator sent review back to Codex",
      requester: "monitor",
    }, { path, now: new Date("2026-05-17T10:35:00.000Z") });

    expect(result.created).toBe(true);
    expect(result.task.events?.[0]?.message).toBe("Operator sent review back to Codex from the monitor.");
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

describe("codex task queue — multi-agent (P2)", () => {
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

  it("defaults agent to codex and stores an explicit claude agent", async () => {
    const path = await tempQueuePath();
    const codex = await proposeCodexTask(
      { repo: "averray-agent/agent", pullRequestNumber: 401, prompt: "x" },
      { path, now: new Date("2026-05-17T10:00:00.000Z") },
    );
    const claude = await proposeCodexTask(
      { repo: "averray-agent/agent", pullRequestNumber: 402, agent: "claude", prompt: "y" },
      { path, now: new Date("2026-05-17T10:01:00.000Z") },
    );
    expect(codex.task.agent).toBe("codex");
    expect(claude.task.agent).toBe("claude");
    expect(taskAgent(codex.task)).toBe("codex");
    expect(taskAgent(claude.task)).toBe("claude");
    // taskAgent defaults a legacy task with no agent field to codex.
    expect(taskAgent({})).toBe("codex");
  });

  it("creates greenfield tasks (no PR) and does not dedupe them", async () => {
    const path = await tempQueuePath();
    const first = await proposeCodexTask(
      { repo: "averray-agent/agent", agent: "claude", prompt: "build a thing" },
      { path, now: new Date("2026-05-17T10:00:00.000Z") },
    );
    const second = await proposeCodexTask(
      { repo: "averray-agent/agent", agent: "claude", prompt: "build another thing" },
      { path, now: new Date("2026-05-17T10:01:00.000Z") },
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(true); // greenfield: distinct, not deduped
    expect(first.task.id).not.toBe(second.task.id);
    expect(first.task.pullRequestNumber).toBeUndefined();
    const all = await listCodexTasks({ path });
    expect(all).toHaveLength(2);
  });

  it("claims only tasks matching the runner's agent filter", async () => {
    const path = await tempQueuePath();
    const codex = await proposeCodexTask(
      { repo: "r", pullRequestNumber: 1, prompt: "c" },
      { path, now: new Date("2026-05-17T10:00:00.000Z") },
    );
    const claude = await proposeCodexTask(
      { repo: "r", agent: "claude", prompt: "k" },
      { path, now: new Date("2026-05-17T10:01:00.000Z") },
    );
    await approveCodexTask(codex.task.id, { path, approvedBy: "operator", now: new Date("2026-05-17T10:02:00.000Z") });
    await approveCodexTask(claude.task.id, { path, approvedBy: "operator", now: new Date("2026-05-17T10:03:00.000Z") });

    // The claude runner skips the (older, approved-first) codex task.
    const claimedByClaude = await claimNextApprovedCodexTask({
      path,
      agent: "claude",
      runnerId: "claude-task-runner",
      now: new Date("2026-05-17T10:04:00.000Z"),
    });
    expect(claimedByClaude?.id).toBe(claude.task.id);
    expect(taskAgent(claimedByClaude!)).toBe("claude");

    // The codex runner claims the remaining codex task.
    const claimedByCodex = await claimNextApprovedCodexTask({
      path,
      agent: "codex",
      runnerId: "codex-task-runner",
      now: new Date("2026-05-17T10:05:00.000Z"),
    });
    expect(claimedByCodex?.id).toBe(codex.task.id);

    // No more tasks for either agent.
    expect(await claimNextApprovedCodexTask({ path, agent: "claude" })).toBeUndefined();
    expect(await claimNextApprovedCodexTask({ path, agent: "codex" })).toBeUndefined();
  });

  it("stores and filters a specialist agent", async () => {
    const path = await tempQueuePath();
    const specialist = await proposeCodexTask(
      { repo: "r", agent: "test-writer", prompt: "add tests" },
      { path, now: new Date("2026-05-17T10:00:00.000Z") },
    );
    await approveCodexTask(specialist.task.id, { path, approvedBy: "operator", now: new Date("2026-05-17T10:01:00.000Z") });

    const claimed = await claimNextApprovedCodexTask({
      path,
      agent: "test-writer",
      runnerId: "test-writer-runner",
      now: new Date("2026-05-17T10:02:00.000Z"),
    });

    expect(claimed?.id).toBe(specialist.task.id);
    expect(taskAgent(claimed!)).toBe("test-writer");
  });

  it("an unfiltered claim still takes any approved task (back-compat)", async () => {
    const path = await tempQueuePath();
    const claude = await proposeCodexTask(
      { repo: "r", agent: "claude", prompt: "k" },
      { path, now: new Date("2026-05-17T10:00:00.000Z") },
    );
    await approveCodexTask(claude.task.id, { path, approvedBy: "operator", now: new Date("2026-05-17T10:01:00.000Z") });
    const claimed = await claimNextApprovedCodexTask({ path, now: new Date("2026-05-17T10:02:00.000Z") });
    expect(claimed?.id).toBe(claude.task.id);
  });
});
