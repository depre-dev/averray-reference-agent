import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseClaudeTaskRunnerConfig } from "../../services/slack-operator/src/claude-task-runner.js";
import {
  approveCodexTask,
  claimNextApprovedCodexTask,
  proposeCodexTask,
  taskAgent,
} from "../../services/slack-operator/src/codex-task-queue.js";

// C3 test-writer RUNNER wiring: a Claude-family runner pinned to agent
// "test-writer" via CLAUDE_TASK_RUNNER_AGENT (the compose service sets it). It
// must claim ONLY approved agent=="test-writer" tasks, and the claude-runner
// (agent "claude") must never claim them — the queue's per-agent filter is the
// isolation seam.

describe("test-writer runner config", () => {
  it("pins agent=test-writer from CLAUDE_TASK_RUNNER_AGENT", () => {
    const config = parseClaudeTaskRunnerConfig({
      CLAUDE_TASK_RUNNER_AGENT: "test-writer",
      CLAUDE_TASK_RUNNER_ENABLED: "1",
      CLAUDE_TASK_RUNNER_ID: "vps-test-writer-task-runner",
    });
    expect(config.agent).toBe("test-writer");
    expect(config.enabled).toBe(true);
    expect(config.runnerId).toBe("vps-test-writer-task-runner");
  });

  it("trims/normalizes the agent value", () => {
    expect(parseClaudeTaskRunnerConfig({ CLAUDE_TASK_RUNNER_AGENT: "  test-writer  " }).agent).toBe("test-writer");
  });

  it("existing claude-runner behavior is unchanged: default agent is claude", () => {
    expect(parseClaudeTaskRunnerConfig({}).agent).toBe("claude");
    expect(parseClaudeTaskRunnerConfig({ CLAUDE_TASK_RUNNER_AGENT: "" }).agent).toBe("claude");
  });
});

describe("test-writer runner claim isolation", () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "averray-test-writer-runner-"));
    path = join(dir, "codex-tasks.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedApprovedTasks() {
    const codex = await proposeCodexTask(
      { repo: "averray-agent/agent", pullRequestNumber: 11, agent: "codex", prompt: "iterate PR" },
      { path },
    );
    const claude = await proposeCodexTask(
      { repo: "averray-agent/agent", agent: "claude", prompt: "build a thing" },
      { path },
    );
    const testWriter = await proposeCodexTask(
      { repo: "averray-agent/agent", agent: "test-writer", prompt: "add tests for the parser" },
      { path },
    );
    // Approve codex + claude FIRST (older) so a naive claimer would grab them.
    await approveCodexTask(codex.task.id, { path, approvedBy: "operator", now: new Date("2026-05-31T10:00:00.000Z") });
    await approveCodexTask(claude.task.id, { path, approvedBy: "operator", now: new Date("2026-05-31T10:01:00.000Z") });
    await approveCodexTask(testWriter.task.id, { path, approvedBy: "operator", now: new Date("2026-05-31T10:02:00.000Z") });
    return { codexId: codex.task.id, claudeId: claude.task.id, testWriterId: testWriter.task.id };
  }

  it("the test-writer runner claims ONLY the test-writer task (skips older codex/claude)", async () => {
    const { testWriterId } = await seedApprovedTasks();
    const claimed = await claimNextApprovedCodexTask({
      path,
      runnerId: "vps-test-writer-task-runner",
      agent: "test-writer",
      now: new Date("2026-05-31T10:03:00.000Z"),
    });
    expect(claimed?.id).toBe(testWriterId);
    expect(taskAgent(claimed!)).toBe("test-writer");
  });

  it("the claude runner never claims a test-writer task (and vice-versa)", async () => {
    const { claudeId, testWriterId } = await seedApprovedTasks();

    const claudeClaim = await claimNextApprovedCodexTask({
      path,
      runnerId: "vps-claude-task-runner",
      agent: "claude",
      now: new Date("2026-05-31T10:03:00.000Z"),
    });
    expect(claudeClaim?.id).toBe(claudeId);
    expect(claudeClaim?.id).not.toBe(testWriterId);

    // The test-writer task remains for the test-writer runner.
    const testWriterClaim = await claimNextApprovedCodexTask({
      path,
      runnerId: "vps-test-writer-task-runner",
      agent: "test-writer",
      now: new Date("2026-05-31T10:04:00.000Z"),
    });
    expect(testWriterClaim?.id).toBe(testWriterId);
  });

  it("a test-writer runner finds nothing when only codex/claude tasks are approved", async () => {
    const codex = await proposeCodexTask(
      { repo: "averray-agent/agent", pullRequestNumber: 12, agent: "codex", prompt: "x" },
      { path },
    );
    await approveCodexTask(codex.task.id, { path, approvedBy: "operator", now: new Date("2026-05-31T10:00:00.000Z") });
    const claimed = await claimNextApprovedCodexTask({ path, agent: "test-writer", now: new Date("2026-05-31T10:01:00.000Z") });
    expect(claimed).toBeUndefined();
  });
});
