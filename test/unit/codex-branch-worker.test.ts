import { describe, expect, it } from "vitest";

import {
  buildGuardedCodexPrompt,
  parseCodexWorkerConfig,
  parseCodexWorkerTask,
  renderCodexWorkerArgs,
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

  it("parses task and worker config from environment", () => {
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
});
