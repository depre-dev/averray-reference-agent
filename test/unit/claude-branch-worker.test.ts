import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildGuardedClaudePrompt,
  claudeBranchName,
  parseClaudeStreamJsonOutput,
  parseClaudeWorkerConfig,
  parseClaudeWorkerTask,
  renderClaudeWorkerArgs,
  runClaudeBranchWorker,
  validateClaudeWorkerTask,
  type ClaudeWorkerConfig,
  type ClaudeWorkerTask,
  type CommandResult,
  type ExecFn,
} from "../../services/slack-operator/src/claude-branch-worker.js";
import { defineSpecialistAgent, TEST_WRITER_ROLE_PROMPT } from "../../services/slack-operator/src/specialist-agents.js";

const task: ClaudeWorkerTask = {
  id: "claude-task-averray-agent-agent-new-20260530-abc123",
  repo: "averray-agent/agent",
  title: "Add a health endpoint",
  prompt: "Add GET /healthz returning 200.",
  correlationId: "corr-1",
};

describe("claude branch worker — pure functions", () => {
  it("parses a greenfield task (no PR) and a PR-bearing task", () => {
    const green = parseClaudeWorkerTask({ CLAUDE_TASK_ID: "t1", CLAUDE_TASK_REPO: "a/b", CLAUDE_TASK_PROMPT: "do x" });
    expect(green).toMatchObject({ id: "t1", repo: "a/b", prompt: "do x" });
    expect(green.agent).toBe("claude");
    expect(green.pullRequestNumber).toBeUndefined();
    const withPr = parseClaudeWorkerTask({ CLAUDE_TASK_ID: "t1", CLAUDE_TASK_REPO: "a/b", CLAUDE_TASK_PROMPT: "x", CLAUDE_TASK_PR: "42", CLAUDE_TASK_AGENT: "test-writer" });
    expect(withPr.pullRequestNumber).toBe(42);
    expect(withPr.agent).toBe("test-writer");
    expect(() => parseClaudeWorkerTask({ CLAUDE_TASK_REPO: "a/b", CLAUDE_TASK_PROMPT: "x" } as NodeJS.ProcessEnv)).toThrow(/CLAUDE_TASK_ID/);
  });

  it("config defaults + allow-list", () => {
    const c = parseClaudeWorkerConfig({ CLAUDE_BRANCH_WORKER_ALLOWED_REPOS: "a/b, c/d" });
    expect(c.baseBranch).toBe("main");
    expect(c.claudeCommand).toBe("claude");
    expect(c.claudeArgs).toEqual([
      "-p",
      "{prompt}",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ]);
    expect(c.allowedRepos).toEqual(["a/b", "c/d"]);
  });

  it("lets operators override headless Claude flags without adding a max-turns default", () => {
    const c = parseClaudeWorkerConfig({
      CLAUDE_BRANCH_WORKER_ALLOWED_REPOS: "a/b",
      CLAUDE_BRANCH_WORKER_OUTPUT_FORMAT: "text",
      CLAUDE_BRANCH_WORKER_PERMISSION_MODE: "bypassPermissions",
      CLAUDE_BRANCH_WORKER_VERBOSE: "0",
    });

    expect(c.claudeArgs).toEqual([
      "-p",
      "{prompt}",
      "--output-format",
      "text",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("derives a claude/<slug>-<idtail> branch", () => {
    const b = claudeBranchName(task);
    expect(b.startsWith("claude/add-a-health-endpoint")).toBe(true);
    expect(b).toMatch(/^claude\/[a-z0-9-]+$/);
  });

  it("derives a specialist-prefixed branch for the test-writer", () => {
    const b = claudeBranchName({ ...task, agent: "test-writer" });
    expect(b.startsWith("test-writer/add-a-health-endpoint")).toBe(true);
    expect(b).toMatch(/^test-writer\/[a-z0-9-]+$/);
  });

  it("validate: rejects empty allow-list, disallowed repo, and protected/base branch", () => {
    const ok = parseClaudeWorkerConfig({ CLAUDE_BRANCH_WORKER_ALLOWED_REPOS: "averray-agent/agent" });
    expect(() => validateClaudeWorkerTask(task, "claude/x", parseClaudeWorkerConfig({}))).toThrow(/allowed repos/i);
    expect(() => validateClaudeWorkerTask({ ...task, repo: "evil/repo" }, "claude/x", ok)).toThrow(/not allowed/i);
    expect(() => validateClaudeWorkerTask(task, "main", ok)).toThrow(/protected\/base/i);
    expect(() => validateClaudeWorkerTask(task, "claude/x", ok)).not.toThrow();
  });

  it("guarded prompt forbids merge/secrets and tells Claude NOT to open the PR itself", () => {
    const p = buildGuardedClaudePrompt(task, "claude/x");
    expect(p).toMatch(/Do NOT merge, deploy/i);
    expect(p).toMatch(/never edit \.env/i);
    expect(p).toMatch(/Do NOT open the pull request yourself/i);
    expect(p).toContain(task.prompt);
  });

  it("injects the TEST-WRITER specialist role prompt", () => {
    const p = buildGuardedClaudePrompt({ ...task, agent: "test-writer" }, "test-writer/x");
    expect(p).toContain("TEST-WRITER ROLE");
    expect(p).toContain(TEST_WRITER_ROLE_PROMPT);
    expect(p).toContain("Prefer adding or tightening tests");
  });

  it("keeps the next specialist config-only at the worker seam", () => {
    const docs = defineSpecialistAgent({
      id: "docs",
      label: "Docs",
      branchPrefix: "docs",
      greenfield: true,
      prBodyLabel: "docs specialist",
      commitPrefix: "Docs task",
      roleTitle: "DOCS",
      rolePrompt: "DOCS ROLE: improve docs only.",
    });

    expect(docs).toMatchObject({
      id: "docs",
      branchPrefix: "docs",
      rolePrompt: "DOCS ROLE: improve docs only.",
    });
  });

  it("renders placeholders into operator-supplied claude args", () => {
    expect(renderClaudeWorkerArgs(["-p", "{prompt}", "--task-id", "{taskId}"], "hello", task))
      .toEqual(["-p", "hello", "--task-id", task.id]);
  });

  it("parses stream-json progress, final result text, and usage", () => {
    const parsed = parseClaudeStreamJsonOutput([
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "Editing the worker now." }],
        },
      }),
      JSON.stringify({
        type: "result",
        result: "Done; opened a pull request.",
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 120,
          output_tokens: 30,
          cache_read_input_tokens: 15,
        },
      }),
      "",
    ].join("\n"));

    expect(parsed.sawJson).toBe(true);
    expect(parsed.progressMessages).toEqual([
      "Claude session initialized.",
      "Editing the worker now.",
      "Claude finished: Done; opened a pull request.",
    ]);
    expect(parsed.finalResultText).toBe("Done; opened a pull request.");
    expect(parsed.usage).toMatchObject({
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 15,
      costUsd: 0.0123,
    });
  });
});

describe("claude branch worker — orchestration (injected exec + PR open)", () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
    tempDirs.length = 0;
  });
  async function workRoot(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "claude-worker-test-"));
    tempDirs.push(d);
    return d;
  }
  async function config(overrides: Partial<ClaudeWorkerConfig> = {}): Promise<ClaudeWorkerConfig> {
    return {
      apiBaseUrl: "https://api.github.com",
      githubToken: "ghp_FAKE",
      allowedRepos: ["averray-agent/agent"],
      workRoot: await workRoot(),
      keepWorktree: false,
      gitUserName: "Averray Claude Worker",
      gitUserEmail: "claude-worker@averray.local",
      baseBranch: "main",
      claudeCommand: "claude",
      claudeArgs: ["-p", "{prompt}"],
      commandTimeoutMs: 1_000,
      ...overrides,
    };
  }

  function fakeExec(opts: { claudeExit?: number; changed?: string[]; claudeStderr?: string; emptyCheckout?: boolean; cloneStderr?: string } = {}) {
    const calls: { command: string; args: string[] }[] = [];
    const exec: ExecFn = async (command, args, options) => {
      calls.push({ command, args });
      if (command === "git" && args[0] === "clone") {
        return { exitCode: 0, stdout: "", stderr: opts.cloneStderr ?? "" } satisfies CommandResult;
      }
      if (command === "git" && args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) {
        return { exitCode: 0, stdout: opts.emptyCheckout ? "false\n" : "true\n", stderr: "" } satisfies CommandResult;
      }
      if (command === "git" && args[0] === "ls-files") {
        return { exitCode: 0, stdout: opts.emptyCheckout ? "" : "package.json\n", stderr: "" } satisfies CommandResult;
      }
      if (command === "git" && args[0] === "status") {
        const lines = (opts.changed ?? ["src/healthz.ts"]).map((f) => ` M ${f}`).join("\n");
        return { exitCode: 0, stdout: lines, stderr: "" } satisfies CommandResult;
      }
      if (command === "claude") {
        options.onStdout?.("edited files\n");
        return { exitCode: opts.claudeExit ?? 0, stdout: "edited files", stderr: opts.claudeStderr ?? "" } satisfies CommandResult;
      }
      return { exitCode: 0, stdout: "", stderr: "" } satisfies CommandResult;
    };
    return { exec, calls };
  }

  it("happy path: creates the branch, runs Claude, commits, pushes, and OPENS a PR", async () => {
    const { exec, calls } = fakeExec();
    const prInputs: unknown[] = [];
    const outcome = await runClaudeBranchWorker(task, await config(), {
      exec,
      openPullRequest: async (_t, _c, input) => {
        prInputs.push(input);
        return { number: 777, html_url: "https://github.com/averray-agent/agent/pull/777" };
      },
    });
    const seq = calls.map((c) => `${c.command} ${c.args[0] ?? ""}`.trim());
    expect(seq).toContain("git clone");
    expect(calls.some((c) => c.command === "git" && c.args[0] === "checkout" && c.args.includes("-B"))).toBe(true);
    expect(calls.some((c) => c.command === "claude")).toBe(true);
    expect(calls.some((c) => c.command === "git" && c.args[0] === "commit")).toBe(true);
    expect(calls.some((c) => c.command === "git" && c.args[0] === "push")).toBe(true);
    expect(prInputs).toHaveLength(1);
    expect(prInputs[0]).toMatchObject({ base: "main" });
    expect((prInputs[0] as { head: string }).head).toMatch(/^claude\//);
    expect(outcome).toMatchObject({
      opened: true,
      pullRequestUrl: "https://github.com/averray-agent/agent/pull/777",
    });
  });

  it("streams Claude JSON progress and usage to the parent runner", async () => {
    const writes: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const streamOutput = [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Applying a small patch." }] },
      }),
      JSON.stringify({
        type: "result",
        result: "Finished cleanly.",
        model: "claude-sonnet-4-5",
        total_cost_usd: 0.04,
        usage: { input_tokens: 200, output_tokens: 40 },
      }),
      "",
    ].join("\n");
    const { exec } = fakeExec();
    const streamingExec: ExecFn = async (command, args, options) => {
      if (command === "claude") {
        options.onStdout?.(streamOutput);
        return { exitCode: 0, stdout: streamOutput, stderr: "" };
      }
      return exec(command, args, options);
    };

    try {
      const outcome = await runClaudeBranchWorker(task, await config({
        claudeArgs: [
          "-p",
          "{prompt}",
          "--output-format",
          "stream-json",
          "--verbose",
          "--permission-mode",
          "acceptEdits",
        ],
      }), {
        exec: streamingExec,
        openPullRequest: async () => ({ number: 779 }),
      });

      const output = writes.join("");
      expect(outcome).toMatchObject({ opened: true, pullRequestNumber: 779 });
      expect(output).toContain("CLAUDE_PROGRESS: Claude session initialized.");
      expect(output).toContain("CLAUDE_PROGRESS: Applying a small patch.");
      expect(output).toContain("CLAUDE_RESULT: Finished cleanly.");
      const usageLine = output.split(/\r?\n/).find((line) => line.startsWith("LLM_USAGE_JSON: "));
      expect(usageLine).toBeTruthy();
      expect(JSON.parse((usageLine as string).replace("LLM_USAGE_JSON: ", ""))).toMatchObject({
        model: "claude-sonnet-4-5",
        input_tokens: 200,
        output_tokens: 40,
        costUsd: 0.04,
      });
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("drops only an unsupported permission flag and keeps stream-json progress", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const { exec } = fakeExec();
    const streamOutput = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Still streaming." }] } }),
      JSON.stringify({ type: "result", result: "Finished.", usage: { input_tokens: 9, output_tokens: 3 } }),
      "",
    ].join("\n");
    const fallbackExec: ExecFn = async (command, args, options) => {
      calls.push({ command, args });
      if (command === "claude" && args.includes("--permission-mode")) {
        return { exitCode: 1, stdout: "", stderr: "error: unknown option --permission-mode" };
      }
      if (command === "claude") {
        options.onStdout?.(streamOutput);
        return { exitCode: 0, stdout: streamOutput, stderr: "" };
      }
      return exec(command, args, options);
    };

    const outcome = await runClaudeBranchWorker(task, await config({
      claudeArgs: [
        "-p",
        "{prompt}",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
      ],
    }), {
      exec: fallbackExec,
      openPullRequest: async () => ({ number: 780 }),
    });

    const claudeCalls = calls.filter((call) => call.command === "claude");
    expect(outcome).toMatchObject({ opened: true, pullRequestNumber: 780 });
    expect(claudeCalls).toHaveLength(2);
    expect(claudeCalls[0]?.args).toContain("stream-json");
    expect(claudeCalls[1]?.args).toContain("stream-json");
    expect(claudeCalls[1]?.args).toContain("--verbose");
    expect(claudeCalls[1]?.args).not.toContain("--permission-mode");
  });

  it("drops only a custom unsupported max-turns flag and preserves hardened defaults", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const { exec } = fakeExec();
    const streamOutput = [
      JSON.stringify({ type: "result", result: "Finished.", usage: { input_tokens: 20, output_tokens: 5 } }),
      "",
    ].join("\n");
    const fallbackExec: ExecFn = async (command, args, options) => {
      calls.push({ command, args });
      if (command === "claude" && args.includes("--max-turns")) {
        return { exitCode: 1, stdout: "", stderr: "error: unrecognized flag --max-turns" };
      }
      if (command === "claude") {
        options.onStdout?.(streamOutput);
        return { exitCode: 0, stdout: streamOutput, stderr: "" };
      }
      return exec(command, args, options);
    };

    const outcome = await runClaudeBranchWorker(task, await config({
      claudeArgs: [
        "-p",
        "{prompt}",
        "--max-turns",
        "30",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
      ],
    }), {
      exec: fallbackExec,
      openPullRequest: async () => ({ number: 781 }),
    });

    const claudeCalls = calls.filter((call) => call.command === "claude");
    expect(outcome).toMatchObject({ opened: true, pullRequestNumber: 781 });
    expect(claudeCalls).toHaveLength(2);
    expect(claudeCalls[1]?.args).toContain("stream-json");
    expect(claudeCalls[1]?.args).toContain("--verbose");
    expect(claudeCalls[1]?.args).toContain("--permission-mode");
    expect(claudeCalls[1]?.args).not.toContain("--max-turns");
    expect(claudeCalls[1]?.args).not.toContain("30");
  });

  it("drops unsupported stream-json output-format without collapsing to bare -p", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const { exec } = fakeExec();
    const fallbackExec: ExecFn = async (command, args, options) => {
      calls.push({ command, args });
      if (command === "claude" && args.includes("--output-format")) {
        return { exitCode: 1, stdout: "", stderr: "error: unknown option --output-format stream-json" };
      }
      return exec(command, args, options);
    };

    const outcome = await runClaudeBranchWorker(task, await config({
      claudeArgs: [
        "-p",
        "{prompt}",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "acceptEdits",
      ],
    }), {
      exec: fallbackExec,
      openPullRequest: async () => ({ number: 782 }),
    });

    const claudeCalls = calls.filter((call) => call.command === "claude");
    expect(outcome).toMatchObject({ opened: true, pullRequestNumber: 782 });
    expect(claudeCalls).toHaveLength(2);
    expect(claudeCalls[1]?.args).toEqual([
      "-p",
      expect.stringContaining("Add GET /healthz returning 200."),
      "--verbose",
      "--permission-mode",
      "acceptEdits",
    ]);
  });

  it("test-writer specialist opens a normal PR through the same harness", async () => {
    const { exec, calls } = fakeExec();
    const prInputs: unknown[] = [];
    const outcome = await runClaudeBranchWorker({ ...task, agent: "test-writer", title: "Add parser tests" }, await config(), {
      exec,
      openPullRequest: async (_t, _c, input) => {
        prInputs.push(input);
        return { number: 778, html_url: "https://github.com/averray-agent/agent/pull/778" };
      },
    });

    expect(calls.some((c) => c.command === "claude")).toBe(true);
    expect(calls.some((c) => c.command === "git" && c.args[0] === "push")).toBe(true);
    expect((prInputs[0] as { head: string }).head).toMatch(/^test-writer\//);
    expect((prInputs[0] as { body: string }).body).toContain("test-writer specialist");
    expect((prInputs[0] as { body: string }).body).toContain("human-gated");
    expect(outcome).toMatchObject({ opened: true, pullRequestNumber: 778 });
  });

  it("no changes → does NOT commit, push, or open a PR", async () => {
    const { exec, calls } = fakeExec({ changed: [] });
    let opened = 0;
    const outcome = await runClaudeBranchWorker(task, await config(), {
      exec,
      openPullRequest: async () => { opened += 1; return { number: 1 }; },
    });
    expect(opened).toBe(0);
    expect(calls.some((c) => c.command === "git" && c.args[0] === "commit")).toBe(false);
    expect(calls.some((c) => c.command === "git" && c.args[0] === "push")).toBe(false);
    expect(outcome).toMatchObject({ opened: false, reason: expect.stringContaining("no_changes") });
  });

  it("empty checkout after clone → returns no-PR failure and preserves git stderr", async () => {
    const { exec, calls } = fakeExec({ emptyCheckout: true, cloneStderr: "remote: Repository not found." });
    const outcome = await runClaudeBranchWorker(task, await config(), {
      exec,
      openPullRequest: async () => ({ number: 1 }),
    });

    expect(outcome).toMatchObject({
      opened: false,
      reason: expect.stringContaining("remote: Repository not found."),
    });
    expect(calls.some((c) => c.command === "claude")).toBe(false);
    expect(calls.some((c) => c.command === "git" && c.args[0] === "push")).toBe(false);
  });

  it("rejects forbidden secret-like files before committing", async () => {
    const { exec } = fakeExec({ changed: ["src/ok.ts", ".env.production"] });
    await expect(
      runClaudeBranchWorker(task, await config(), { exec, openPullRequest: async () => ({ number: 1 }) }),
    ).rejects.toThrow(/forbidden secret-like file/i);
  });

  it("a non-zero Claude exit fails the task (no commit/push/PR)", async () => {
    const { exec, calls } = fakeExec({ claudeExit: 2, claudeStderr: "claude blew up" });
    let opened = 0;
    await expect(
      runClaudeBranchWorker(task, await config(), { exec, openPullRequest: async () => { opened += 1; return { number: 1 }; } }),
    ).rejects.toThrow(/claude blew up|claude exited/i);
    expect(opened).toBe(0);
    expect(calls.some((c) => c.command === "git" && c.args[0] === "push")).toBe(false);
  });

  it("refuses a repo outside the allow-list (before any git)", async () => {
    const { exec, calls } = fakeExec();
    await expect(
      runClaudeBranchWorker({ ...task, repo: "evil/repo" }, await config(), { exec, openPullRequest: async () => ({ number: 1 }) }),
    ).rejects.toThrow(/not allowed/i);
    expect(calls).toHaveLength(0); // validated before cloning
  });
});
