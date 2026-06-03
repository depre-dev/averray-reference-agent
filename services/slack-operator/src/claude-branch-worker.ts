// Claude branch worker (O2/C3) — the greenfield executor the claude-task-runner
// spawns per approved Claude-family task. Mirrors codex-branch-worker, but
// instead of working on an existing PR it:
//   create an agent-prefixed branch off a fresh base → run Claude in an
//   isolated worktree → commit → push → OPEN a pull request.
// The opened PR is auto-attributed by O1 (branch prefix) and
// flows into Operator review through the existing Hermes handoff.
//
// Auth: the runner already resolved the billing route and handed us an env
// with the right credential (and, in sub mode, no ANTHROPIC_API_KEY) — we
// just inherit it for the `claude` invocation. We never read or log the
// token/key here; the GitHub token is used only for git push + PR open.
//
// Guardrails (this is an unattended agent with push rights):
//   - repo allow-list (CLAUDE_BRANCH_WORKER_ALLOWED_REPOS) — refuse others;
//   - never the base/protected branch — we only ever push `claude/<slug>`;
//   - forbidden secret-like files are rejected before commit (reused guard);
//   - all command output is secret-redacted (reused sanitizer);
//   - the worker only ever runs tasks the runner already claimed at
//     status:"approved" (the runner enforces that).
//
// exec + GitHub fetch are injected so the whole flow is unit-testable with
// no real git, network, or provider calls.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertNoForbiddenFiles,
  gitCheckoutFailureReason,
  redact,
} from "./codex-branch-worker.js";
import {
  formatBranchWorkerOutcome,
  type BranchWorkerOutcome,
} from "./branch-worker-outcome.js";
import {
  specialistAgentDefinition,
  taskAgentBranchPrefix,
  taskAgentCommitPrefix,
  taskAgentLabel,
  taskAgentPrBodyLabel,
} from "./specialist-agents.js";

export interface ClaudeWorkerTask {
  id: string;
  /** Queue agent identity. "claude" by default; C3 specialists set e.g. "test-writer". */
  agent?: string;
  repo: string;
  /** Greenfield tasks have no PR yet; Claude opens its own. */
  pullRequestNumber?: number;
  title?: string;
  prompt: string;
  correlationId?: string;
}

export interface ClaudeWorkerConfig {
  apiBaseUrl: string;
  githubToken?: string;
  allowedRepos: string[];
  workRoot: string;
  keepWorktree: boolean;
  gitUserName: string;
  gitUserEmail: string;
  baseBranch: string;
  claudeCommand: string;
  claudeArgs: string[];
  maxTurns: number;
  commandTimeoutMs: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  token?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  suppressStdout?: boolean;
  suppressStderr?: boolean;
}

/** Run a command. Injected in tests; `defaultExec` spawns for real. */
export type ExecFn = (
  command: string,
  args: string[],
  options: ExecOptions
) => Promise<CommandResult>;

export interface OpenedPullRequest {
  number: number;
  html_url?: string;
}

export interface ClaudeBranchWorkerDeps {
  exec?: ExecFn;
  /** Opens the PR; injected in tests. Defaults to the GitHub REST API. */
  openPullRequest?: (
    task: ClaudeWorkerTask,
    config: ClaudeWorkerConfig,
    input: { head: string; base: string; title: string; body: string }
  ) => Promise<OpenedPullRequest>;
}

const PROTECTED_BRANCHES = new Set(["main", "master", "production", "prod"]);
// Headless Claude Code defaults. `stream-json` gives the task runner live
// progress lines instead of one silent blob; the bare `-p` fallback below keeps
// older Claude Code builds working when a flag is unavailable.
const DEFAULT_CLAUDE_OUTPUT_FORMAT = "stream-json";
const DEFAULT_CLAUDE_PERMISSION_MODE = "acceptEdits";
const DEFAULT_CLAUDE_MAX_TURNS = 30;
const TEXT_FALLBACK_CLAUDE_ARGS = ["-p", "{prompt}"];

export function parseClaudeWorkerTask(env: NodeJS.ProcessEnv = process.env): ClaudeWorkerTask {
  const prRaw = env.CLAUDE_TASK_PR?.trim();
  const pullRequestNumber = prRaw ? Number(prRaw) : undefined;
  if (prRaw && (!Number.isInteger(pullRequestNumber) || (pullRequestNumber as number) < 1)) {
    throw new Error("CLAUDE_TASK_PR, when set, must be a positive integer.");
  }
  return {
    id: requiredEnv(env, "CLAUDE_TASK_ID"),
    agent: env.CLAUDE_TASK_AGENT?.trim() || "claude",
    repo: requiredEnv(env, "CLAUDE_TASK_REPO"),
    ...(pullRequestNumber ? { pullRequestNumber } : {}),
    ...(env.CLAUDE_TASK_TITLE ? { title: env.CLAUDE_TASK_TITLE } : {}),
    prompt: requiredEnv(env, "CLAUDE_TASK_PROMPT"),
    ...(env.CLAUDE_TASK_CORRELATION_ID ? { correlationId: env.CLAUDE_TASK_CORRELATION_ID } : {}),
  };
}

export function parseClaudeWorkerConfig(env: NodeJS.ProcessEnv = process.env): ClaudeWorkerConfig {
  const maxTurns = positiveInt(env.CLAUDE_BRANCH_WORKER_MAX_TURNS, DEFAULT_CLAUDE_MAX_TURNS);
  return {
    apiBaseUrl: env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
    githubToken: resolveGithubTokenForRepo(env.CLAUDE_TASK_REPO ?? "", env),
    allowedRepos: parseCsv(env.CLAUDE_BRANCH_WORKER_ALLOWED_REPOS || env.GITHUB_HELPER_REPOS || env.GITHUB_DEFAULT_REPO),
    workRoot: env.CLAUDE_BRANCH_WORKER_ROOT?.trim() || join(tmpdir(), "averray-claude-worker"),
    keepWorktree: env.CLAUDE_BRANCH_WORKER_KEEP_WORKTREE === "1" || env.CLAUDE_BRANCH_WORKER_KEEP_WORKTREE === "true",
    gitUserName: env.CLAUDE_BRANCH_WORKER_GIT_USER_NAME?.trim() || "Averray Claude Worker",
    gitUserEmail: env.CLAUDE_BRANCH_WORKER_GIT_USER_EMAIL?.trim() || "claude-worker@averray.local",
    baseBranch: env.CLAUDE_BRANCH_WORKER_BASE_BRANCH?.trim() || "main",
    claudeCommand: env.CLAUDE_BRANCH_WORKER_CLAUDE_COMMAND?.trim() || "claude",
    claudeArgs: parseArgs(env.CLAUDE_BRANCH_WORKER_CLAUDE_ARGS, defaultClaudeArgs(env)),
    maxTurns,
    commandTimeoutMs: positiveInt(env.CLAUDE_BRANCH_WORKER_TIMEOUT_MS, 30 * 60_000),
  };
}

/** Deterministic `<agent-prefix>/<slug>-<idtail>` head branch for the task. */
export function claudeBranchName(task: ClaudeWorkerTask): string {
  const base = (task.title || task.prompt || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const tail = task.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-8);
  return `${taskAgentBranchPrefix(task.agent ?? "claude")}/${[base, tail].filter(Boolean).join("-") || "task"}`;
}

export function validateClaudeWorkerTask(task: ClaudeWorkerTask, branch: string, config: ClaudeWorkerConfig): void {
  const label = taskAgentLabel(task.agent ?? "claude");
  if (config.allowedRepos.length === 0) {
    throw new Error(`No ${label} worker allowed repos configured (CLAUDE_BRANCH_WORKER_ALLOWED_REPOS).`);
  }
  if (!config.allowedRepos.includes(task.repo)) {
    throw new Error(`Repo ${task.repo} is not allowed for ${label} worker dispatch.`);
  }
  if (PROTECTED_BRANCHES.has(branch.toLowerCase()) || branch === config.baseBranch) {
    throw new Error(`Refusing to let Claude push to protected/base branch ${branch}.`);
  }
}

export function buildGuardedClaudePrompt(task: ClaudeWorkerTask, branch: string): string {
  const specialist = specialistAgentDefinition(task.agent);
  const label = taskAgentLabel(task.agent ?? "claude");
  return [
    `You are ${label} working for Hermes on an approved Averray task.`,
    specialist?.rolePrompt ?? "",
    "",
    "Hard boundaries:",
    `- Work only in this checked-out worktree on branch ${branch}.`,
    "- Do NOT merge, deploy, rotate secrets, claim jobs, submit platform work, or push to main.",
    "- Do NOT add or print secrets, JWTs, private keys, or provider tokens; never edit .env files.",
    "- Keep the change minimal and specific to the task; run the smallest relevant local checks.",
    "- Do NOT open the pull request yourself — the harness commits, pushes, and opens it.",
    "- Leave merge/deploy decisions to Hermes and the operator.",
    "",
    `Repository: ${task.repo}`,
    `Title: ${task.title || "untitled"}`,
    task.correlationId ? `Correlation ID: ${task.correlationId}` : "",
    "",
    "Task from Hermes:",
    task.prompt,
  ].filter(Boolean).join("\n");
}

export function renderClaudeWorkerArgs(
  args: string[],
  prompt: string,
  task: ClaudeWorkerTask,
  config?: Pick<ClaudeWorkerConfig, "maxTurns">
): string[] {
  const replacements: Record<string, string> = {
    "{prompt}": prompt,
    "{taskId}": task.id,
    "{repo}": task.repo,
    "{title}": task.title ?? "",
    "{correlationId}": task.correlationId ?? "",
    "{agent}": task.agent ?? "claude",
    "{agentLabel}": taskAgentLabel(task.agent ?? "claude"),
    "{maxTurns}": String(config?.maxTurns ?? DEFAULT_CLAUDE_MAX_TURNS),
  };
  return args.map((arg) => {
    let value = arg;
    for (const [token, replacement] of Object.entries(replacements)) {
      value = value.split(token).join(replacement);
    }
    return value;
  });
}

export function buildPullRequestBody(task: ClaudeWorkerTask): string {
  const label = taskAgentPrBodyLabel(task.agent ?? "claude");
  const specialist = specialistAgentDefinition(task.agent);
  return [
    `Opened by the Averray **${label}** for an approved Hermes task.`,
    specialist ? `Specialist role: **${specialist.roleTitle}**.` : "",
    "",
    "**Task**",
    task.prompt,
    "",
    task.correlationId ? `Correlation ID: \`${task.correlationId}\`` : "",
    "",
    "_Automated change on a fresh branch. Review + merge are human-gated (AGENTS.md)._",
  ].filter(Boolean).join("\n");
}

export async function runClaudeBranchWorker(
  task: ClaudeWorkerTask = parseClaudeWorkerTask(),
  config: ClaudeWorkerConfig = parseClaudeWorkerConfig(),
  deps: ClaudeBranchWorkerDeps = {}
): Promise<BranchWorkerOutcome> {
  const exec = deps.exec ?? defaultExec;
  const openPullRequest = deps.openPullRequest ?? openPullRequestViaApi;
  const branch = claudeBranchName(task);
  validateClaudeWorkerTask(task, branch, config);

  const cloneUrl = `https://github.com/${task.repo}.git`;
  await mkdir(config.workRoot, { recursive: true });
  const workdir = await mkdtemp(join(config.workRoot, `${slug(task.id)}-`));
  try {
    const cloneResult = await exec("git", ["clone", "--no-tags", "--depth=50", cloneUrl, workdir], { token: config.githubToken });
    const checkoutFailure = await gitCheckoutFailureReason(exec, workdir, cloneResult, taskAgentLabel(task.agent ?? "claude"));
    if (checkoutFailure) return { opened: false, reason: checkoutFailure, summary: checkoutFailure };
    await exec("git", ["config", "user.name", config.gitUserName], { cwd: workdir });
    await exec("git", ["config", "user.email", config.gitUserEmail], { cwd: workdir });
    await exec("git", ["fetch", "origin", config.baseBranch], { cwd: workdir, token: config.githubToken });
    await exec("git", ["checkout", "-B", branch, `origin/${config.baseBranch}`], { cwd: workdir });

    const prompt = buildGuardedClaudePrompt(task, branch);
    console.log(`${taskAgentLabel(task.agent ?? "claude")} worker starting ${task.repo} on ${branch}.`);
    const claude = await executeClaudeInvocation(exec, config, task, prompt, workdir);
    if (claude.exitCode !== 0) {
      throw new Error(lastNonEmptyLine(claude.stderr) || lastNonEmptyLine(claude.stdout) || `claude exited with ${claude.exitCode}.`);
    }

    const changedFiles = await listChangedFiles(exec, workdir);
    assertNoForbiddenFiles(changedFiles, taskAgentLabel(task.agent ?? "claude"));
    if (changedFiles.length === 0) {
      console.log(`${taskAgentLabel(task.agent ?? "claude")} produced no changes for ${task.repo}; not opening a PR.`);
      return {
        opened: false,
        reason: `no_changes: ${taskAgentLabel(task.agent ?? "claude")} produced no changes for ${task.repo}; not opening a PR.`,
        summary: `${taskAgentLabel(task.agent ?? "claude")} produced no changes for ${task.repo}; not opening a PR.`,
      };
    }

    await exec("git", ["add", "-A"], { cwd: workdir });
    await exec("git", ["commit", "-m", commitMessage(task)], { cwd: workdir });
    await exec("git", ["push", "origin", `HEAD:${branch}`], { cwd: workdir, token: config.githubToken });

    const pr = await openPullRequest(task, config, {
      head: branch,
      base: config.baseBranch,
      title: pullRequestTitle(task),
      body: buildPullRequestBody(task),
    });
    console.log(`${taskAgentLabel(task.agent ?? "claude")} opened PR #${pr.number} on ${task.repo} (${branch})${pr.html_url ? ` — ${pr.html_url}` : ""}.`);
    return {
      opened: true,
      pullRequestNumber: pr.number,
      ...(pr.html_url ? { pullRequestUrl: pr.html_url } : {}),
      summary: `${taskAgentLabel(task.agent ?? "claude")} opened PR #${pr.number} on ${task.repo}.`,
    };
  } finally {
    if (!config.keepWorktree) await rm(workdir, { recursive: true, force: true });
  }
}

async function openPullRequestViaApi(
  task: ClaudeWorkerTask,
  config: ClaudeWorkerConfig,
  input: { head: string; base: string; title: string; body: string }
): Promise<OpenedPullRequest> {
  const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/repos/${task.repo}/pulls`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "averray-claude-branch-worker",
      ...(config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {}),
    },
    body: JSON.stringify({ title: input.title, head: input.head, base: input.base, body: input.body, maintainer_can_modify: true }),
  });
  if (!response.ok) {
    throw new Error(`GitHub PR creation failed for ${task.repo} (${input.head} → ${input.base}): HTTP ${response.status}`);
  }
  const json = await response.json() as OpenedPullRequest;
  return { number: json.number, ...(json.html_url ? { html_url: json.html_url } : {}) };
}

export async function listChangedFiles(exec: ExecFn, cwd: string): Promise<string[]> {
  const result = await exec("git", ["status", "--porcelain"], { cwd });
  // Porcelain v1: 2 status chars + a space, then the path. Slice the fixed
  // 3-char prefix off the RAW line (don't trim first, or a worktree-modified
  // " M path" loses a character and the secret-file guard sees a wrong path).
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 3)
    .map((line) => {
      const entry = line.slice(3).trim();
      const arrow = entry.lastIndexOf(" -> "); // rename → keep the new path
      return (arrow >= 0 ? entry.slice(arrow + 4) : entry).trim();
    })
    .filter(Boolean);
}

interface ClaudeInvocationResult extends CommandResult {
  finalResultText?: string;
  usage?: Record<string, unknown>;
  usedTextFallback?: boolean;
}

interface ClaudeStreamState {
  buffer: string;
  sawJson: boolean;
  progressMessages: string[];
  finalResultText?: string;
  usage?: Record<string, unknown>;
  model?: string;
}

export interface ClaudeStreamParseResult {
  progressMessages: string[];
  finalResultText?: string;
  usage?: Record<string, unknown>;
  model?: string;
  sawJson: boolean;
}

async function executeClaudeInvocation(
  exec: ExecFn,
  config: ClaudeWorkerConfig,
  task: ClaudeWorkerTask,
  prompt: string,
  cwd: string
): Promise<ClaudeInvocationResult> {
  const renderedArgs = renderClaudeWorkerArgs(config.claudeArgs, prompt, task, config);
  const wantsStreamJson = claudeArgsRequestStreamJson(renderedArgs);
  if (!wantsStreamJson) {
    return exec(config.claudeCommand, renderedArgs, { cwd, timeoutMs: config.commandTimeoutMs });
  }

  const streamState = createClaudeStreamState();
  const streamResult = await exec(config.claudeCommand, renderedArgs, {
    cwd,
    timeoutMs: config.commandTimeoutMs,
    suppressStdout: true,
    onStdout: (chunk) => {
      const updates = observeClaudeStreamChunk(streamState, chunk);
      for (const message of updates.progressMessages) emitClaudeProgress(message);
    },
  });
  const parsed = finalizeClaudeStreamState(streamState);
  emitClaudeParsedResult(parsed);

  if (streamResult.exitCode !== 0 && shouldFallbackToTextClaude(streamResult)) {
    emitClaudeProgress("Claude stream-json flags were unavailable; retrying with text output.");
    const fallback = await exec(
      config.claudeCommand,
      renderClaudeWorkerArgs(TEXT_FALLBACK_CLAUDE_ARGS, prompt, task, config),
      { cwd, timeoutMs: config.commandTimeoutMs }
    );
    return {
      ...fallback,
      usedTextFallback: true,
    };
  }

  return {
    ...streamResult,
    ...(parsed.finalResultText ? { finalResultText: parsed.finalResultText } : {}),
    ...(parsed.usage ? { usage: parsed.usage } : {}),
  };
}

function createClaudeStreamState(): ClaudeStreamState {
  return {
    buffer: "",
    sawJson: false,
    progressMessages: [],
  };
}

export function parseClaudeStreamJsonOutput(output: string): ClaudeStreamParseResult {
  const state = createClaudeStreamState();
  observeClaudeStreamChunk(state, output);
  return finalizeClaudeStreamState(state);
}

function observeClaudeStreamChunk(state: ClaudeStreamState, chunk: string): ClaudeStreamParseResult {
  const startIndex = state.progressMessages.length;
  state.buffer += chunk;
  const lines = state.buffer.split(/\r?\n/);
  state.buffer = lines.pop() ?? "";
  for (const line of lines) observeClaudeStreamLine(state, line);
  return snapshotClaudeStreamState(state, startIndex);
}

function finalizeClaudeStreamState(state: ClaudeStreamState): ClaudeStreamParseResult {
  if (state.buffer.trim()) {
    observeClaudeStreamLine(state, state.buffer);
    state.buffer = "";
  }
  return snapshotClaudeStreamState(state, 0);
}

function snapshotClaudeStreamState(state: ClaudeStreamState, progressStart: number): ClaudeStreamParseResult {
  return {
    progressMessages: state.progressMessages.slice(progressStart),
    ...(state.finalResultText ? { finalResultText: state.finalResultText } : {}),
    ...(state.usage ? { usage: state.usage } : {}),
    ...(state.model ? { model: state.model } : {}),
    sawJson: state.sawJson,
  };
}

function observeClaudeStreamLine(state: ClaudeStreamState, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  const event = parseJsonObject(trimmed);
  if (!event) {
    state.progressMessages.push(capForProgress(trimmed));
    return;
  }
  state.sawJson = true;
  const progress = progressFromClaudeEvent(event);
  if (progress) state.progressMessages.push(progress);
  const resultText = finalResultTextFromClaudeEvent(event);
  if (resultText) state.finalResultText = resultText;
  const usage = usageFromClaudeEvent(event);
  if (usage) state.usage = usage;
  const model = stringField(event, "model")
    ?? stringField(recordField(event, "message"), "model")
    ?? stringField(state.usage, "model");
  if (model) state.model = model;
}

function progressFromClaudeEvent(event: Record<string, unknown>): string | undefined {
  const type = stringField(event, "type");
  const subtype = stringField(event, "subtype");
  if (type === "system" && subtype === "init") return "Claude session initialized.";
  if (type === "assistant") {
    const text = textFromClaudeMessage(recordField(event, "message") ?? event);
    if (text) return capForProgress(text);
    const tool = toolNameFromContent(recordField(event, "message")?.content ?? event.content);
    if (tool) return `Claude is using ${tool}.`;
  }
  if (type === "result") {
    const text = finalResultTextFromClaudeEvent(event);
    return text ? `Claude finished: ${capForProgress(text)}` : "Claude finished.";
  }
  const message = stringField(event, "progress")
    ?? stringField(event, "message")
    ?? stringField(event, "text")
    ?? stringField(event, "summary");
  return message ? capForProgress(message) : undefined;
}

function finalResultTextFromClaudeEvent(event: Record<string, unknown>): string | undefined {
  if (stringField(event, "type") !== "result") return undefined;
  return nonEmptyString(event.result)
    ?? nonEmptyString(event.summary)
    ?? nonEmptyString(event.message);
}

function usageFromClaudeEvent(event: Record<string, unknown>): Record<string, unknown> | undefined {
  const carrier = recordField(event, "usage")
    ?? recordField(recordField(event, "message"), "usage")
    ?? recordField(recordField(event, "result"), "usage");
  if (!carrier) return undefined;
  const model = stringField(event, "model")
    ?? stringField(recordField(event, "message"), "model")
    ?? stringField(carrier, "model");
  const costUsd = numberField(event, "costUsd")
    ?? numberField(event, "cost_usd")
    ?? numberField(event, "total_cost_usd")
    ?? numberField(carrier, "costUsd")
    ?? numberField(carrier, "cost_usd")
    ?? numberField(carrier, "total_cost_usd");
  return {
    ...carrier,
    ...(model ? { model } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function emitClaudeParsedResult(parsed: ClaudeStreamParseResult): void {
  if (parsed.usage) {
    process.stdout.write(redact(`LLM_USAGE_JSON: ${JSON.stringify(parsed.usage)}\n`));
  }
  if (parsed.finalResultText) {
    process.stdout.write(redact(`CLAUDE_RESULT: ${capForProgress(parsed.finalResultText, 600)}\n`));
  }
}

function emitClaudeProgress(message: string): void {
  process.stdout.write(redact(`CLAUDE_PROGRESS: ${capForProgress(message)}\n`));
}

function claudeArgsRequestStreamJson(args: readonly string[]): boolean {
  return args.some((arg, index) =>
    arg === "stream-json"
    || arg === "--output-format=stream-json"
    || (arg === "--output-format" && args[index + 1] === "stream-json")
  );
}

function shouldFallbackToTextClaude(result: CommandResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return /(?:unknown|unrecognized|invalid|unsupported|no such)\s+(?:option|argument|flag)|stream-json|output-format|permission-mode|max-turns|acceptEdits/i.test(output)
    && /(?:stream-json|output-format|permission-mode|max-turns|acceptEdits|--verbose)/i.test(output);
}

function textFromClaudeMessage(message: Record<string, unknown>): string | undefined {
  return textFromContent(message.content)
    ?? nonEmptyString(message.text)
    ?? nonEmptyString(message.result)
    ?? nonEmptyString(message.summary);
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) return content.trim();
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return "";
      if (item.type === "text") return nonEmptyString(item.text) ?? "";
      return "";
    })
    .join("\n")
    .trim();
  return text || undefined;
}

function toolNameFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "tool_use") {
      return nonEmptyString(item.name) ?? "a tool";
    }
  }
  return undefined;
}

const defaultExec: ExecFn = (command, args, options) =>
  new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, gitArgsWithAuth(command, args, options.token), {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let closed = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!closed) child.kill("SIGKILL");
        }, 5_000).unref();
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms.`));
      }, options.timeoutMs)
      : undefined;
    timeout?.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      options.onStdout?.(text);
      if (!options.suppressStdout) process.stdout.write(redact(text));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      options.onStderr?.(text);
      if (!options.suppressStderr) process.stderr.write(redact(text));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      closed = true;
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });

function gitArgsWithAuth(command: string, args: string[], token?: string): string[] {
  if (command !== "git" || !token) return args;
  // GitHub's git smart-HTTP endpoint rejects `Authorization: Bearer <PAT>`; it
  // requires Basic auth with the token as the password (x-access-token user).
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: Basic ${basic}`, ...args];
}

function resolveGithubTokenForRepo(repo: string, env: NodeJS.ProcessEnv): string | undefined {
  const [owner, name] = repo.split("/");
  const repoToken = owner && name ? parseTokenMap(env.GITHUB_REPO_TOKENS).get(`${owner}/${name}`) : undefined;
  const ownerToken = owner ? parseTokenMap(env.GITHUB_OWNER_TOKENS).get(owner) : undefined;
  const envRepoToken = owner && name ? env[`GITHUB_TOKEN_${toEnvKey(owner)}_${toEnvKey(name)}`]?.trim() : undefined;
  const envOwnerToken = owner ? env[`GITHUB_TOKEN_${toEnvKey(owner)}`]?.trim() : undefined;
  return repoToken ?? ownerToken ?? envRepoToken ?? envOwnerToken ?? env.GITHUB_TOKEN?.trim() ?? undefined;
}

function parseTokenMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of (value ?? "").split(/[\n,;]+/)) {
    const [rawKey, ...rest] = entry.split("=");
    const key = rawKey?.trim();
    const token = rest.join("=").trim();
    if (key && token) map.set(key, token);
  }
  return map;
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "").split(/[\n,;]+/).map((entry) => entry.trim()).filter(Boolean);
}

function defaultClaudeArgs(env: NodeJS.ProcessEnv): string[] {
  const outputFormat = env.CLAUDE_BRANCH_WORKER_OUTPUT_FORMAT?.trim() || DEFAULT_CLAUDE_OUTPUT_FORMAT;
  const permissionMode = env.CLAUDE_BRANCH_WORKER_PERMISSION_MODE?.trim() || DEFAULT_CLAUDE_PERMISSION_MODE;
  const verbose = env.CLAUDE_BRANCH_WORKER_VERBOSE === "0" || env.CLAUDE_BRANCH_WORKER_VERBOSE === "false"
    ? []
    : ["--verbose"];
  return [
    "-p",
    "{prompt}",
    "--output-format",
    outputFormat,
    ...verbose,
    "--max-turns",
    "{maxTurns}",
    "--permission-mode",
    permissionMode,
  ];
}

function parseArgs(value: string | undefined, fallback: string[]): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("CLAUDE_BRANCH_WORKER_CLAUDE_ARGS must be a JSON string array when it starts with '['.");
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function toEnvKey(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

function commitMessage(task: ClaudeWorkerTask): string {
  const title = (task.title || task.prompt || `${taskAgentLabel(task.agent ?? "claude")} task`).replace(/\s+/g, " ").trim();
  return `${taskAgentCommitPrefix(task.agent ?? "claude")}: ${title}`.slice(0, 72);
}

function pullRequestTitle(task: ClaudeWorkerTask): string {
  const title = (task.title || task.prompt || "Claude task").replace(/\s+/g, " ").trim();
  return title.slice(0, 80);
}

function lastNonEmptyLine(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.trim() ?? "";
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  return nonEmptyString(value[key]);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const raw = value[key];
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function capForProgress(value: string, max = 240): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, Math.max(0, max - 1))}...` : compact;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runClaudeBranchWorker()
    .then((outcome) => {
      console.log(formatBranchWorkerOutcome(outcome));
      if (!outcome.opened) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(redact(error instanceof Error ? error.message : String(error)));
      process.exitCode = 1;
    });
}
