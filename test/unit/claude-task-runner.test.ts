import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  approveCodexTask,
  listCodexTasks,
  proposeCodexTask,
  readCodexRunnerHeartbeat,
} from "../../services/slack-operator/src/codex-task-queue.js";
import {
  runClaudeTaskRunnerOnce,
  type ClaudeTaskRunnerConfig,
} from "../../services/slack-operator/src/claude-task-runner.js";

const FAKE_KEY = "sk-ant-FAKE-do-not-log";

describe("claude task runner", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function tempQueuePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "averray-claude-runner-"));
    tempDirs.push(dir);
    return join(dir, "tasks.json");
  }

  // Default config: confirmed sub route (OAuth token, no API key), executor injected.
  function config(path: string, overrides: Partial<ClaudeTaskRunnerConfig> = {}): ClaudeTaskRunnerConfig {
    return {
      enabled: true,
      agent: "claude",
      path,
      runnerId: "test-claude-runner",
      args: [],
      pollIntervalMs: 10,
      timeoutMs: 1_000,
      outputTailBytes: 1_000,
      authEnv: { CLAUDE_WORKER_AUTH_MODE: "sub", CLAUDE_CODE_OAUTH_TOKEN: "oauth-FAKE" },
      ...overrides,
    };
  }

  async function approvedClaudeTask(path: string, prompt = "Build the thing"): Promise<string> {
    const { task } = await proposeCodexTask({ repo: "averray-agent/agent", agent: "claude", prompt }, { path });
    await approveCodexTask(task.id, { path, approvedBy: "operator" });
    return task.id;
  }

  async function approvedTestWriterTask(path: string, prompt = "Add parser tests"): Promise<string> {
    const { task } = await proposeCodexTask({ repo: "averray-agent/agent", agent: "test-writer", prompt }, { path });
    await approveCodexTask(task.id, { path, approvedBy: "operator" });
    return task.id;
  }

  async function approvedCodexTask(path: string, pr = 390): Promise<string> {
    const { task } = await proposeCodexTask({ repo: "averray-agent/agent", pullRequestNumber: pr, prompt: "codex work" }, { path });
    await approveCodexTask(task.id, { path, approvedBy: "operator" });
    return task.id;
  }

  it("ROUTE GATE: mismatch (intent sub + ANTHROPIC_API_KEY) → refuses to claim, writes misconfigured heartbeat", async () => {
    const path = await tempQueuePath();
    const id = await approvedClaudeTask(path);
    const executor = vi.fn();

    const result = await runClaudeTaskRunnerOnce(
      config(path, { authEnv: { CLAUDE_WORKER_AUTH_MODE: "sub", CLAUDE_CODE_OAUTH_TOKEN: "oauth-FAKE", ANTHROPIC_API_KEY: FAKE_KEY } }),
      { executor, log: () => {} },
    );

    expect(result.status).toBe("misconfigured");
    expect(executor).not.toHaveBeenCalled();
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({ id, status: "approved" }); // NOT claimed
    const hb = await readCodexRunnerHeartbeat({ path });
    expect(hb).toMatchObject({ runnerId: "test-claude-runner", status: "misconfigured" });
    // never leaks the key value
    expect(JSON.stringify(hb)).not.toContain(FAKE_KEY);
  });

  it("claims only agent=claude approved tasks, leaving codex tasks for the codex runner", async () => {
    const path = await tempQueuePath();
    const codexId = await approvedCodexTask(path); // approved first (older)
    const claudeId = await approvedClaudeTask(path);
    const seen: string[] = [];

    const result = await runClaudeTaskRunnerOnce(config(path), {
      executor: async (task) => {
        seen.push(task.id);
        return {
          exitCode: 0,
          stdout: "opened PR",
          stderr: "",
          summary: "opened PR",
          outcome: { opened: true, pullRequestUrl: "https://github.com/averray-agent/agent/pull/777" },
        };
      },
      log: () => {},
    });

    expect(result.status).toBe("completed");
    expect(seen).toEqual([claudeId]); // claimed the claude task, skipped the older codex one
    const tasks = await listCodexTasks({ path });
    expect(tasks.find((t) => t.id === claudeId)?.status).toBe("completed");
    expect(tasks.find((t) => t.id === codexId)?.status).toBe("approved"); // untouched
  });

  it("can be configured as the C3 test-writer specialist runner", async () => {
    const path = await tempQueuePath();
    const claudeId = await approvedClaudeTask(path, "general Claude work");
    const testWriterId = await approvedTestWriterTask(path);
    const seen: Array<{ id: string; agent?: string }> = [];

    const result = await runClaudeTaskRunnerOnce(config(path, {
      agent: "test-writer",
      runnerId: "test-writer-runner",
    }), {
      executor: async (task) => {
        seen.push({ id: task.id, agent: task.agent });
        return {
          exitCode: 0,
          stdout: "opened PR",
          stderr: "",
          summary: "opened PR",
          outcome: { opened: true, pullRequestUrl: "https://github.com/averray-agent/agent/pull/778" },
        };
      },
      log: () => {},
    });

    expect(result.status).toBe("completed");
    expect(seen).toEqual([{ id: testWriterId, agent: "test-writer" }]);
    const tasks = await listCodexTasks({ path });
    expect(tasks.find((t) => t.id === testWriterId)?.status).toBe("completed");
    expect(tasks.find((t) => t.id === claudeId)?.status).toBe("approved");
  });

  it("happy path: claim → execute → completeCodexTask + completed heartbeat", async () => {
    const path = await tempQueuePath();
    const id = await approvedClaudeTask(path);

    const result = await runClaudeTaskRunnerOnce(config(path), {
      executor: async () => ({
        exitCode: 0,
        stdout: "branch pushed\nPR opened\n",
        stderr: "",
        summary: "PR opened",
        outcome: { opened: true, pullRequestUrl: "https://github.com/averray-agent/agent/pull/779" },
      }),
      log: () => {},
    });

    expect(result.status).toBe("completed");
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({ id, status: "completed", completionSummary: "PR opened\nhttps://github.com/averray-agent/agent/pull/779" });
    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({
      runnerId: "test-claude-runner",
      status: "completed",
    });
  });

  it("records Claude SDK usage counters for completed tasks", async () => {
    const path = await tempQueuePath();
    const usagePath = join(path.replace(/tasks\.json$/, ""), "llm-usage.jsonl");
    const previousUsagePath = process.env.LLM_USAGE_LOG_PATH;
    process.env.LLM_USAGE_LOG_PATH = usagePath;
    const id = await approvedClaudeTask(path);

    const result = await runClaudeTaskRunnerOnce(config(path, { model: "claude-sonnet-4-5" }), {
      executor: async () => ({
        exitCode: 0,
        stdout: "opened PR",
        stderr: "",
        summary: "opened PR",
        outcome: { opened: true, pullRequestUrl: "https://github.com/averray-agent/agent/pull/780" },
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 15,
        },
      }),
      log: () => {},
    });
    if (previousUsagePath === undefined) delete process.env.LLM_USAGE_LOG_PATH;
    else process.env.LLM_USAGE_LOG_PATH = previousUsagePath;

    expect(result.status).toBe("completed");
    await expect(readFile(usagePath, "utf8").then((line) => JSON.parse(line))).resolves.toMatchObject({
      agent: "claude",
      model: "claude-sonnet-4-5",
      taskId: id,
      inputTokens: 120,
      outputTokens: 30,
      cacheTokens: 15,
    });
  });

  it("zero-exit no-PR outcome → failCodexTask + failed heartbeat", async () => {
    const path = await tempQueuePath();
    const id = await approvedClaudeTask(path);

    const result = await runClaudeTaskRunnerOnce(config(path), {
      executor: async () => ({
        exitCode: 0,
        stdout: "Claude produced no changes; not opening a PR.\n",
        stderr: "",
        summary: "Claude produced no changes; not opening a PR.",
        outcome: { opened: false, reason: "no_changes" },
      }),
      log: () => {},
    });

    expect(result).toMatchObject({ status: "failed", reason: "no_changes" });
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({ id, status: "failed", failureReason: "no_changes", completionSummary: "no_changes" });
    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({ status: "failed", message: "no_changes" });
  });

  it("timeout errors remain failed", async () => {
    const path = await tempQueuePath();
    const id = await approvedClaudeTask(path);

    const result = await runClaudeTaskRunnerOnce(config(path), {
      executor: async () => {
        throw new Error("Claude task command timed out after 1000ms.");
      },
      log: () => {},
    });

    expect(result).toMatchObject({ status: "failed", reason: "Claude task command timed out after 1000ms." });
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({
      id,
      status: "failed",
      failureReason: "Claude task command timed out after 1000ms.",
      completionSummary: "Claude task command timed out after 1000ms.",
    });
  });

  it("failure path: non-zero exit → failCodexTask + failed heartbeat", async () => {
    const path = await tempQueuePath();
    const id = await approvedClaudeTask(path);

    const result = await runClaudeTaskRunnerOnce(config(path), {
      executor: async () => ({ exitCode: 1, stdout: "", stderr: "worker blew up", summary: undefined }),
      log: () => {},
    });

    expect(result.status).toBe("failed");
    const [task] = await listCodexTasks({ path });
    expect(task).toMatchObject({ id, status: "failed" });
    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({ status: "failed" });
  });

  it("HALT_FILE present → does not claim (kill switch)", async () => {
    const path = await tempQueuePath();
    const id = await approvedClaudeTask(path);
    const executor = vi.fn();

    const result = await runClaudeTaskRunnerOnce(config(path, { haltFile: "/data/HALT" }), {
      executor,
      isHalted: () => true,
      log: () => {},
    });

    expect(result.status).toBe("halted");
    expect(executor).not.toHaveBeenCalled();
    expect((await listCodexTasks({ path }))[0]).toMatchObject({ id, status: "approved" });
    await expect(readCodexRunnerHeartbeat({ path })).resolves.toMatchObject({ status: "idle" });
  });

  it("api mode with the daily budget exhausted → does not claim", async () => {
    const path = await tempQueuePath();
    const id = await approvedClaudeTask(path);
    const executor = vi.fn();

    const result = await runClaudeTaskRunnerOnce(
      config(path, { authEnv: { CLAUDE_WORKER_AUTH_MODE: "api", ANTHROPIC_API_KEY: FAKE_KEY, CLAUDE_WORKER_DAILY_BUDGET: "10" } }),
      { executor, spentTodayUsd: 10, log: () => {} },
    );

    expect(result.status).toBe("budget_exhausted");
    expect(executor).not.toHaveBeenCalled();
    expect((await listCodexTasks({ path }))[0]).toMatchObject({ id, status: "approved" });
  });

  it("disabled runner does not claim", async () => {
    const path = await tempQueuePath();
    await approvedClaudeTask(path);
    const result = await runClaudeTaskRunnerOnce(config(path, { enabled: false }), { executor: vi.fn(), log: () => {} });
    expect(result.status).toBe("disabled");
  });
});
