import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveCodexTask,
  listCodexTasks,
  proposeCodexTask,
} from "../../services/slack-operator/src/codex-task-queue.js";
import {
  parseCodexTaskRunnerConfig,
  renderCodexTaskRunnerArgs,
  runCodexTaskRunnerOnce,
  type CodexTaskRunnerConfig,
} from "../../services/slack-operator/src/codex-task-runner.js";

describe("codex task runner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempQueuePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "averray-codex-runner-"));
    tempDirs.push(dir);
    return join(dir, "tasks.json");
  }

  function config(path: string, overrides: Partial<CodexTaskRunnerConfig> = {}): CodexTaskRunnerConfig {
    return {
      enabled: true,
      path,
      runnerId: "test-runner",
      command: "fake-codex",
      args: [],
      pollIntervalMs: 10,
      timeoutMs: 1_000,
      outputTailBytes: 1_000,
      ...overrides,
    };
  }

  it("claims an approved task, executes it, and marks it completed", async () => {
    const path = await tempQueuePath();
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 390,
      title: "Finish draft",
      prompt: "Finish PR #390.",
      correlationId: "github-pr-390",
      requester: "monitor",
    }, { path });
    await approveCodexTask(proposed.task.id, { path, approvedBy: "operator" });

    const result = await runCodexTaskRunnerOnce(config(path), {
      executor: async (task) => {
        expect(task.prompt).toBe("Finish PR #390.");
        return {
          exitCode: 0,
          stdout: "branch pushed\nready for Hermes\n",
          stderr: "",
          summary: "ready for Hermes",
        };
      },
    });

    expect(result.status).toBe("completed");
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({
      id: proposed.task.id,
      status: "completed",
      runnerId: "test-runner",
      attemptCount: 1,
      completionSummary: "ready for Hermes",
      stdoutTail: "branch pushed\nready for Hermes\n",
    });
  });

  it("marks an approved task failed when the executor exits nonzero", async () => {
    const path = await tempQueuePath();
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 391,
      prompt: "Fix PR #391.",
    }, { path });
    await approveCodexTask(proposed.task.id, { path });

    const result = await runCodexTaskRunnerOnce(config(path), {
      executor: async () => ({
        exitCode: 7,
        stdout: "some progress\n",
        stderr: "could not push branch\n",
      }),
    });

    expect(result.status).toBe("failed");
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({
      status: "failed",
      exitCode: 7,
      failureReason: "could not push branch",
      stderrTail: "could not push branch\n",
    });
  });

  it("does not mutate tasks when disabled or missing command", async () => {
    const path = await tempQueuePath();
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 392,
      prompt: "Fix PR #392.",
    }, { path });
    await approveCodexTask(proposed.task.id, { path });

    await expect(runCodexTaskRunnerOnce(config(path, { enabled: false }))).resolves.toMatchObject({ status: "disabled" });
    expect((await listCodexTasks({ path }))[0]).toMatchObject({ status: "approved" });

    await expect(runCodexTaskRunnerOnce(config(path, { command: undefined }))).resolves.toMatchObject({
      status: "misconfigured",
    });
    expect((await listCodexTasks({ path }))[0]).toMatchObject({ status: "approved" });
  });

  it("parses JSON command arguments from env", () => {
    const parsed = parseCodexTaskRunnerConfig({
      CODEX_TASK_RUNNER_ENABLED: "1",
      CODEX_TASK_RUNNER_COMMAND: "codex",
      CODEX_TASK_RUNNER_ARGS: "[\"exec\",\"--full-auto\"]",
      CODEX_TASK_RUNNER_POLL_INTERVAL_MS: "5000",
    });

    expect(parsed.enabled).toBe(true);
    expect(parsed.command).toBe("codex");
    expect(parsed.args).toEqual(["exec", "--full-auto"]);
    expect(parsed.pollIntervalMs).toBe(5_000);
  });

  it("renders prompt placeholders in configured command args", async () => {
    const path = await tempQueuePath();
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 393,
      title: "Finish draft",
      prompt: "Continue PR #393.",
      correlationId: "github-pr-393",
    }, { path });

    expect(renderCodexTaskRunnerArgs(["exec", "--full-auto", "{prompt}", "--pr={pr}", "{repo}"], proposed.task)).toEqual([
      "exec",
      "--full-auto",
      "Continue PR #393.",
      "--pr=393",
      "averray-agent/agent",
    ]);
  });
});
