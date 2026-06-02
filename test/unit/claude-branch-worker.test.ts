import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildGuardedClaudePrompt,
  claudeBranchName,
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
    expect(c.claudeArgs).toEqual(["-p", "{prompt}"]);
    expect(c.allowedRepos).toEqual(["a/b", "c/d"]);
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

  it("renders {prompt} into the claude args", () => {
    expect(renderClaudeWorkerArgs(["-p", "{prompt}"], "hello", task)).toEqual(["-p", "hello"]);
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
    const exec: ExecFn = async (command, args) => {
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
