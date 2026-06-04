import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  approveCodexTask,
  listCodexTasks,
  proposeCodexTask,
  readCodexRunnerHeartbeat,
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
    const usagePath = join(path.replace(/tasks\.json$/, ""), "llm-usage.jsonl");
    const previousUsagePath = process.env.LLM_USAGE_LOG_PATH;
    process.env.LLM_USAGE_LOG_PATH = usagePath;
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 390,
      title: "Finish draft",
      surface: "ops hygiene",
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
          outcome: { opened: true, pullRequestUrl: "https://github.com/averray-agent/agent/pull/390" },
          usage: {
            model: "gpt-5-codex",
            inputTokens: 20,
            outputTokens: 8,
          },
        };
      },
    });
    if (previousUsagePath === undefined) delete process.env.LLM_USAGE_LOG_PATH;
    else process.env.LLM_USAGE_LOG_PATH = previousUsagePath;

    expect(result.status).toBe("completed");
    await expect(readFile(usagePath, "utf8").then((line) => JSON.parse(line))).resolves.toMatchObject({
      agent: "codex",
      model: "gpt-5-codex",
      taskId: proposed.task.id,
      runId: "github-pr-390",
      inputTokens: 20,
      outputTokens: 8,
    });
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({
      id: proposed.task.id,
      status: "completed",
      runnerId: "test-runner",
      attemptCount: 1,
      completionSummary: "ready for Hermes\nhttps://github.com/averray-agent/agent/pull/390",
      stdoutTail: "branch pushed\nready for Hermes\n",
      routingOutcome: {
        agent: "codex",
        surface: "ops hygiene",
        outcome: "opened_pr",
        tokenUsage: {
          model: "gpt-5-codex",
          inputTokens: 20,
          outputTokens: 8,
          totalTokens: 28,
        },
      },
    });
    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({
      runnerId: "test-runner",
      status: "completed",
      activeTaskId: proposed.task.id,
      message: "ready for Hermes\nhttps://github.com/averray-agent/agent/pull/390",
    });
  });

  it("claims only Codex-routed tasks and leaves Claude-routed tasks for Claude", async () => {
    const path = await tempQueuePath();
    const claude = await proposeCodexTask({
      repo: "averray-agent/agent",
      agent: "claude",
      title: "Claude task",
      prompt: "Build a frontend refinement.",
    }, { path, now: new Date("2026-06-01T10:00:00.000Z") });
    const codex = await proposeCodexTask({
      repo: "averray-agent/agent",
      agent: "codex",
      title: "Codex task",
      prompt: "Fix the runner guard.",
    }, { path, now: new Date("2026-06-01T10:01:00.000Z") });
    await approveCodexTask(claude.task.id, { path, now: new Date("2026-06-01T10:02:00.000Z") });
    await approveCodexTask(codex.task.id, { path, now: new Date("2026-06-01T10:03:00.000Z") });

    const seen: string[] = [];
    const result = await runCodexTaskRunnerOnce(config(path), {
      executor: async (task) => {
        seen.push(task.id);
        return {
          exitCode: 0,
          stdout: "done\n",
          stderr: "",
          summary: "done",
          outcome: { opened: true, pullRequestUrl: "https://github.com/averray-agent/agent/pull/606" },
        };
      },
      now: new Date("2026-06-01T10:04:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(seen).toEqual([codex.task.id]);
    const tasks = await listCodexTasks({ path });
    expect(tasks.find((task) => task.id === codex.task.id)).toMatchObject({ status: "completed", agent: "codex" });
    expect(tasks.find((task) => task.id === claude.task.id)).toMatchObject({ status: "approved", agent: "claude" });
  });

  it("executes greenfield Codex tasks without requiring CODEX_TASK_PR", async () => {
    const path = await tempQueuePath();
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      agent: "codex",
      title: "Add runner guard",
      prompt: "Fix the greenfield runner path.",
      correlationId: "greenfield-1",
    }, { path });
    await approveCodexTask(proposed.task.id, { path });

    const result = await runCodexTaskRunnerOnce(config(path), {
      executor: async (task) => {
        expect(task.pullRequestNumber).toBeUndefined();
        expect(renderCodexTaskRunnerArgs(["--pr={pr}", "{CODEX_TASK_PR}"], task)).toEqual(["--pr=", ""]);
        return {
          exitCode: 0,
          stdout: "opened pr\n",
          stderr: "",
          summary: "opened pr",
          outcome: { opened: true, pullRequestUrl: "https://github.com/averray-agent/agent/pull/607" },
        };
      },
    });

    expect(result.status).toBe("completed");
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({
      id: proposed.task.id,
      status: "completed",
      agent: "codex",
    });
    expect(task.pullRequestNumber).toBeUndefined();
  });

  it("marks a zero-exit no-PR outcome failed instead of completed", async () => {
    const path = await tempQueuePath();
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      agent: "codex",
      surface: "ops hygiene",
      title: "No diff",
      prompt: "Try the change.",
    }, { path });
    await approveCodexTask(proposed.task.id, { path });

    const result = await runCodexTaskRunnerOnce(config(path), {
      executor: async () => ({
        exitCode: 0,
        stdout: "Codex produced no changes; not opening a PR.\n",
        stderr: "",
        summary: "Codex produced no changes; not opening a PR.",
        outcome: { opened: false, reason: "no_changes" },
      }),
    });

    expect(result).toMatchObject({ status: "failed", reason: "no_changes" });
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({
      id: proposed.task.id,
      status: "failed",
      failureReason: "no_changes",
      completionSummary: "no_changes",
      progressMessage: "no_changes",
      routingOutcome: {
        agent: "codex",
        surface: "ops hygiene",
        outcome: "no_pr",
      },
    });
  });

  it("marks an executor timeout error failed", async () => {
    const path = await tempQueuePath();
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      pullRequestNumber: 394,
      prompt: "Finish PR #394.",
    }, { path });
    await approveCodexTask(proposed.task.id, { path });

    const result = await runCodexTaskRunnerOnce(config(path), {
      executor: async () => {
        throw new Error("Codex task command timed out after 1000ms.");
      },
    });

    expect(result).toMatchObject({ status: "failed", reason: "Codex task command timed out after 1000ms." });
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({
      status: "failed",
      failureReason: "Codex task command timed out after 1000ms.",
      completionSummary: "Codex task command timed out after 1000ms.",
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
    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({
      runnerId: "test-runner",
      status: "failed",
      activeTaskId: proposed.task.id,
      message: "could not push branch",
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
    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({ status: "disabled" });

    await expect(runCodexTaskRunnerOnce(config(path, { command: undefined }))).resolves.toMatchObject({
      status: "misconfigured",
    });
    expect((await listCodexTasks({ path }))[0]).toMatchObject({ status: "approved" });
    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({ status: "misconfigured" });
  });

  it("reports idle heartbeat when no approved task is waiting", async () => {
    const path = await tempQueuePath();

    await expect(runCodexTaskRunnerOnce(config(path))).resolves.toMatchObject({ status: "idle" });
    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({
      runnerId: "test-runner",
      status: "idle",
      message: "Codex runner is online; no approved task is waiting.",
    });
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

  it("renders empty PR placeholders for greenfield task command args", async () => {
    const path = await tempQueuePath();
    const proposed = await proposeCodexTask({
      repo: "averray-agent/agent",
      agent: "codex",
      title: "New task",
      prompt: "Build new task.",
    }, { path });

    expect(renderCodexTaskRunnerArgs(["exec", "--pr={pr}", "{CODEX_TASK_PR}", "{prompt}"], proposed.task)).toEqual([
      "exec",
      "--pr=",
      "",
      "Build new task.",
    ]);
  });
});
