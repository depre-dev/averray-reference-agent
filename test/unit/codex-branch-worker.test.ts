import { describe, expect, it } from "vitest";

import {
  buildGuardedCodexGreenfieldPrompt,
  buildGuardedCodexPrompt,
  codexBranchName,
  type ExecFn,
  parseCodexWorkerConfig,
  parseCodexWorkerTask,
  renderCodexWorkerArgs,
  runCodexBranchWorker,
  validateGreenfieldCodexWorkerTask,
  validatePullRequestForCodexWorker,
  type CodexWorkerTask,
  type GithubPullRequestForWorker,
} from "../../services/slack-operator/src/codex-branch-worker.js";

describe("codex branch worker", () => {
  const task: CodexWorkerTask = {
    id: "codex-task-1",
    repo: "averray-agent/agent",
    pullRequestNumber: 381,
    title: "Finish draft",
    prompt: "Finish the draft and run tests.",
    correlationId: "github-pr-381",
  };

  const pr: GithubPullRequestForWorker = {
    number: 381,
    state: "open",
    draft: true,
    title: "Finish draft",
    html_url: "https://github.com/averray-agent/agent/pull/381",
    head: {
      ref: "codex/finish-draft",
      sha: "abc123",
      repo: {
        full_name: "averray-agent/agent",
        clone_url: "https://github.com/averray-agent/agent.git",
      },
    },
    base: {
      ref: "main",
      repo: { full_name: "averray-agent/agent" },
    },
  };

  it("parses PR-mode and greenfield tasks plus worker config from environment", () => {
    expect(parseCodexWorkerTask({
      CODEX_TASK_ID: "task-1",
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_TASK_PR: "381",
      CODEX_TASK_PROMPT: "Fix it.",
      CODEX_TASK_CORRELATION_ID: "corr-1",
    })).toMatchObject({
      id: "task-1",
      repo: "averray-agent/agent",
      pullRequestNumber: 381,
      prompt: "Fix it.",
      correlationId: "corr-1",
    });
    expect(parseCodexWorkerTask({
      CODEX_TASK_ID: "task-2",
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_TASK_PROMPT: "Build the missing thing.",
    })).toMatchObject({
      id: "task-2",
      repo: "averray-agent/agent",
      prompt: "Build the missing thing.",
    });
    expect(() => parseCodexWorkerTask({
      CODEX_TASK_ID: "task-3",
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_TASK_PR: "nope",
      CODEX_TASK_PROMPT: "Fix it.",
    })).toThrow(/positive integer/);

    expect(parseCodexWorkerConfig({
      CODEX_TASK_REPO: "averray-agent/agent",
      GITHUB_REPO_TOKENS: "averray-agent/agent=repo-token",
      CODEX_BRANCH_WORKER_ALLOWED_REPOS: "averray-agent/agent,depre-dev/averray-reference-agent",
      CODEX_BRANCH_WORKER_CODEX_COMMAND: "codex",
      CODEX_BRANCH_WORKER_CODEX_ARGS: "[\"exec\",\"{prompt}\"]",
    })).toMatchObject({
      githubToken: "repo-token",
      allowedRepos: ["averray-agent/agent", "depre-dev/averray-reference-agent"],
      codexCommand: "codex",
      codexArgs: ["exec", "{prompt}"],
      baseBranch: "main",
    });
  });

  it("builds a guarded prompt that preserves Hermes/Codex/operator boundaries", () => {
    const prompt = buildGuardedCodexPrompt(task, pr);
    expect(prompt).toContain("Work only on the checked-out PR branch.");
    expect(prompt).toContain("Do not merge, deploy, rotate secrets, claim jobs, submit platform work");
    expect(prompt).toContain("Repository: averray-agent/agent");
    expect(prompt).toContain("Pull request: #381");
    expect(prompt).toContain("Task from Hermes:");
    expect(prompt).toContain("Finish the draft and run tests.");
  });

  it("refuses protected or disallowed branches before running Codex", () => {
    expect(() => validatePullRequestForCodexWorker(task, pr, parseCodexWorkerConfig({
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_BRANCH_WORKER_ALLOWED_REPOS: "averray-agent/agent",
    }))).not.toThrow();

    expect(() => validatePullRequestForCodexWorker(task, {
      ...pr,
      head: { ...pr.head, ref: "main" },
    }, parseCodexWorkerConfig({
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_BRANCH_WORKER_ALLOWED_REPOS: "averray-agent/agent",
    }))).toThrow(/protected branch main/);

    expect(() => validatePullRequestForCodexWorker(task, pr, parseCodexWorkerConfig({
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_BRANCH_WORKER_ALLOWED_REPOS: "other/repo",
    }))).toThrow(/not allowed/);

    expect(() => validatePullRequestForCodexWorker(task, pr, parseCodexWorkerConfig({
      CODEX_TASK_REPO: "averray-agent/agent",
    }))).toThrow(/allowed repos/);
  });

  it("renders Codex args with task placeholders", () => {
    expect(renderCodexWorkerArgs(["exec", "--full-auto", "{prompt}", "--pr={pr}", "{correlationId}"], "Guarded prompt", task)).toEqual([
      "exec",
      "--full-auto",
      "Guarded prompt",
      "--pr=381",
      "github-pr-381",
    ]);
  });

  it("builds and validates a greenfield branch for Codex tasks without a PR", () => {
    const greenfield: CodexWorkerTask = {
      id: "codex-task-greenfield-123456",
      repo: "averray-agent/agent",
      title: "Add runner guard",
      prompt: "Add the missing guard.",
    };
    const branch = codexBranchName(greenfield);
    const config = parseCodexWorkerConfig({
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_BRANCH_WORKER_ALLOWED_REPOS: "averray-agent/agent",
    });

    expect(branch).toMatch(/^codex\/add-runner-guard-[a-z0-9-]+$/);
    expect(() => validateGreenfieldCodexWorkerTask(greenfield, branch, config)).not.toThrow();
    expect(buildGuardedCodexGreenfieldPrompt(greenfield, branch)).toContain("the harness commits, pushes, and opens it");
    expect(renderCodexWorkerArgs(["--pr={pr}", "{prompt}"], "Prompt", greenfield)).toEqual(["--pr=", "Prompt"]);
  });

  it("runs a greenfield Codex task by branching from base and opening a new PR", async () => {
    const greenfield: CodexWorkerTask = {
      id: "codex-task-greenfield-abcdef",
      repo: "averray-agent/agent",
      title: "Add runner guard",
      prompt: "Add the missing guard.",
      correlationId: "mission-1",
    };
    const config = parseCodexWorkerConfig({
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_BRANCH_WORKER_ALLOWED_REPOS: "averray-agent/agent",
      CODEX_BRANCH_WORKER_CODEX_COMMAND: "codex",
      CODEX_BRANCH_WORKER_CODEX_ARGS: "[\"exec\",\"{prompt}\"]",
    });
    const commands: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const exec: ExecFn = async (command, args, options) => {
      commands.push({ command, args, ...(options?.cwd ? { cwd: options.cwd } : {}) });
      if (command === "git" && args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) {
        return { exitCode: 0, stdout: "true\n", stderr: "" };
      }
      if (command === "git" && args[0] === "ls-files") {
        return { exitCode: 0, stdout: "package.json\n", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: " M services/slack-operator/src/codex-branch-worker.ts\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const opened: Array<{ head: string; base: string; title: string; body: string }> = [];

    const outcome = await runCodexBranchWorker(greenfield, config, {
      exec,
      openPullRequest: async (_task, _config, input) => {
        opened.push(input);
        return { number: 606, html_url: "https://github.com/averray-agent/agent/pull/606" };
      },
    });

    const branch = codexBranchName(greenfield);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "git", args: ["clone", "--no-tags", "--depth=50", "https://github.com/averray-agent/agent.git", expect.any(String)] }),
      expect.objectContaining({ command: "git", args: ["fetch", "origin", "main"] }),
      expect.objectContaining({ command: "git", args: ["checkout", "-B", branch, "origin/main"] }),
      expect.objectContaining({ command: "codex", args: ["exec", expect.stringContaining("Task from Hermes:")] }),
      expect.objectContaining({ command: "git", args: ["push", "origin", `HEAD:${branch}`] }),
    ]));
    expect(opened).toEqual([expect.objectContaining({
      head: branch,
      base: "main",
      title: "codex: Add runner guard",
      body: expect.stringContaining("Review + merge are human-gated"),
    })]);
    expect(outcome).toMatchObject({
      opened: true,
      pullRequestUrl: "https://github.com/averray-agent/agent/pull/606",
    });
  });

  it("returns a no-PR outcome when greenfield Codex produces no changes", async () => {
    const greenfield: CodexWorkerTask = {
      id: "codex-task-greenfield-nochange",
      repo: "averray-agent/agent",
      title: "No changes",
      prompt: "Try the change.",
    };
    const config = parseCodexWorkerConfig({
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_BRANCH_WORKER_ALLOWED_REPOS: "averray-agent/agent",
      CODEX_BRANCH_WORKER_CODEX_COMMAND: "codex",
      CODEX_BRANCH_WORKER_CODEX_ARGS: "[\"exec\",\"{prompt}\"]",
    });
    const commands: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      commands.push({ command, args });
      if (command === "git" && args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) {
        return { exitCode: 0, stdout: "true\n", stderr: "" };
      }
      if (command === "git" && args[0] === "ls-files") {
        return { exitCode: 0, stdout: "package.json\n", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const outcome = await runCodexBranchWorker(greenfield, config, {
      exec,
      openPullRequest: async () => ({ number: 1 }),
    });

    expect(outcome).toMatchObject({ opened: false, reason: expect.stringContaining("no_changes") });
    expect(commands.some((c) => c.command === "git" && c.args[0] === "push")).toBe(false);
  });

  it("returns a no-PR outcome when clone leaves an empty checkout", async () => {
    const greenfield: CodexWorkerTask = {
      id: "codex-task-greenfield-empty",
      repo: "averray-agent/agent",
      title: "Empty clone",
      prompt: "Try the change.",
    };
    const config = parseCodexWorkerConfig({
      CODEX_TASK_REPO: "averray-agent/agent",
      CODEX_BRANCH_WORKER_ALLOWED_REPOS: "averray-agent/agent",
      CODEX_BRANCH_WORKER_CODEX_COMMAND: "codex",
      CODEX_BRANCH_WORKER_CODEX_ARGS: "[\"exec\",\"{prompt}\"]",
    });
    const commands: Array<{ command: string; args: string[] }> = [];
    const exec: ExecFn = async (command, args) => {
      commands.push({ command, args });
      if (command === "git" && args[0] === "clone") {
        return { exitCode: 0, stdout: "", stderr: "fatal: could not read Username for https://github.com" };
      }
      if (command === "git" && args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) {
        return { exitCode: 0, stdout: "false\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const outcome = await runCodexBranchWorker(greenfield, config, {
      exec,
      openPullRequest: async () => ({ number: 1 }),
    });

    expect(outcome).toMatchObject({
      opened: false,
      reason: expect.stringContaining("fatal: could not read Username"),
    });
    expect(commands.some((c) => c.command === "codex")).toBe(false);
    expect(commands.some((c) => c.command === "git" && c.args[0] === "push")).toBe(false);
  });
});
