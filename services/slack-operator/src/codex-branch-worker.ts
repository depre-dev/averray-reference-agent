import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface CodexWorkerTask {
  id: string;
  repo: string;
  pullRequestNumber: number;
  title?: string;
  prompt: string;
  correlationId?: string;
}

export interface CodexWorkerConfig {
  apiBaseUrl: string;
  githubToken?: string;
  allowedRepos: string[];
  workRoot: string;
  keepWorktree: boolean;
  gitUserName: string;
  gitUserEmail: string;
  codexCommand: string;
  codexArgs: string[];
  commandTimeoutMs: number;
}

export interface GithubPullRequestForWorker {
  number: number;
  state: string;
  draft?: boolean;
  title?: string;
  html_url?: string;
  head: {
    ref: string;
    sha?: string;
    repo?: {
      full_name?: string;
      clone_url?: string;
      html_url?: string;
    } | null;
  };
  base?: {
    ref?: string;
    repo?: {
      full_name?: string;
    } | null;
  };
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_CODEX_ARGS = ["exec", "--full-auto", "{prompt}"];
const PROTECTED_BRANCHES = new Set(["main", "master", "production", "prod"]);
const DEFAULT_DENY_PATTERNS = [
  /^\.env(?:\.|$)/,
  /(^|\/)\.env(?:\.|$)/,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /private[-_]?key/i,
];

export function parseCodexWorkerTask(env: NodeJS.ProcessEnv = process.env): CodexWorkerTask {
  const repo = requiredEnv(env, "CODEX_TASK_REPO");
  const pullRequestNumber = Number(env.CODEX_TASK_PR);
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error("CODEX_TASK_PR must be a positive integer.");
  }
  return {
    id: requiredEnv(env, "CODEX_TASK_ID"),
    repo,
    pullRequestNumber,
    ...(env.CODEX_TASK_TITLE ? { title: env.CODEX_TASK_TITLE } : {}),
    prompt: requiredEnv(env, "CODEX_TASK_PROMPT"),
    ...(env.CODEX_TASK_CORRELATION_ID ? { correlationId: env.CODEX_TASK_CORRELATION_ID } : {}),
  };
}

export function parseCodexWorkerConfig(env: NodeJS.ProcessEnv = process.env): CodexWorkerConfig {
  return {
    apiBaseUrl: env.GITHUB_API_BASE_URL?.trim() || "https://api.github.com",
    githubToken: resolveGithubTokenForRepo(env.CODEX_TASK_REPO ?? "", env),
    allowedRepos: parseCsv(env.CODEX_BRANCH_WORKER_ALLOWED_REPOS || env.GITHUB_HELPER_REPOS || env.GITHUB_DEFAULT_REPO),
    workRoot: env.CODEX_BRANCH_WORKER_ROOT?.trim() || join(tmpdir(), "averray-codex-worker"),
    keepWorktree: env.CODEX_BRANCH_WORKER_KEEP_WORKTREE === "1" || env.CODEX_BRANCH_WORKER_KEEP_WORKTREE === "true",
    gitUserName: env.CODEX_BRANCH_WORKER_GIT_USER_NAME?.trim() || "Averray Codex Worker",
    gitUserEmail: env.CODEX_BRANCH_WORKER_GIT_USER_EMAIL?.trim() || "codex-worker@averray.local",
    codexCommand: env.CODEX_BRANCH_WORKER_CODEX_COMMAND?.trim() || "codex",
    codexArgs: parseArgs(env.CODEX_BRANCH_WORKER_CODEX_ARGS, DEFAULT_CODEX_ARGS),
    commandTimeoutMs: positiveInt(env.CODEX_BRANCH_WORKER_TIMEOUT_MS, 30 * 60_000),
  };
}

export function validatePullRequestForCodexWorker(
  task: CodexWorkerTask,
  pr: GithubPullRequestForWorker,
  config: CodexWorkerConfig
): void {
  if (config.allowedRepos.length === 0) {
    throw new Error("No Codex worker allowed repos configured.");
  }
  if (config.allowedRepos.length > 0 && !config.allowedRepos.includes(task.repo)) {
    throw new Error(`Repo ${task.repo} is not allowed for Codex worker dispatch.`);
  }
  if (pr.state !== "open") {
    throw new Error(`PR #${task.pullRequestNumber} is not open (${pr.state}).`);
  }
  const headRepo = pr.head.repo?.full_name;
  if (!headRepo) {
    throw new Error(`PR #${task.pullRequestNumber} does not expose a writable head repository.`);
  }
  const headRef = pr.head.ref;
  if (!headRef) {
    throw new Error(`PR #${task.pullRequestNumber} does not expose a head branch.`);
  }
  if (PROTECTED_BRANCHES.has(headRef.toLowerCase())) {
    throw new Error(`Refusing to let Codex work directly on protected branch ${headRef}.`);
  }
  const baseRepo = pr.base?.repo?.full_name;
  const baseRef = pr.base?.ref;
  if (baseRepo === headRepo && baseRef && baseRef === headRef) {
    throw new Error(`Refusing to let Codex work on the base branch ${baseRef}.`);
  }
}

export function buildGuardedCodexPrompt(task: CodexWorkerTask, pr: GithubPullRequestForWorker): string {
  const prUrl = pr.html_url ? `\nPR URL: ${pr.html_url}` : "";
  const correlation = task.correlationId ? `\nCorrelation ID: ${task.correlationId}` : "";
  return [
    "You are Codex working for Hermes on an approved Averray monitor task.",
    "",
    "Hard boundaries:",
    "- Work only on the checked-out PR branch.",
    "- Do not merge, deploy, rotate secrets, claim jobs, submit platform work, or edit production state.",
    "- Do not add or print secrets, JWTs, private keys, or provider tokens.",
    "- Keep the change minimal and specific to the task.",
    "- Run the smallest relevant local checks you can before finishing.",
    "- Leave GitHub merge/deploy decisions to Hermes and the operator.",
    "",
    `Repository: ${task.repo}`,
    `Pull request: #${task.pullRequestNumber}`,
    `Head branch: ${pr.head.ref}`,
    `Title: ${task.title || pr.title || "untitled"}`,
    prUrl.trim(),
    correlation.trim(),
    "",
    "Task from Hermes:",
    task.prompt,
  ].filter(Boolean).join("\n");
}

export function renderCodexWorkerArgs(args: string[], prompt: string, task: CodexWorkerTask): string[] {
  const replacements: Record<string, string> = {
    "{prompt}": prompt,
    "{taskId}": task.id,
    "{repo}": task.repo,
    "{pr}": String(task.pullRequestNumber),
    "{title}": task.title ?? "",
    "{correlationId}": task.correlationId ?? "",
  };
  return args.map((arg) => {
    let value = arg;
    for (const [token, replacement] of Object.entries(replacements)) {
      value = value.split(token).join(replacement);
    }
    return value;
  });
}

export async function runCodexBranchWorker(
  task: CodexWorkerTask = parseCodexWorkerTask(),
  config: CodexWorkerConfig = parseCodexWorkerConfig()
): Promise<void> {
  const pr = await fetchPullRequest(task, config);
  validatePullRequestForCodexWorker(task, pr, config);
  const headRepo = pr.head.repo?.full_name as string;
  const cloneUrl = pr.head.repo?.clone_url || `https://github.com/${headRepo}.git`;
  await mkdir(config.workRoot, { recursive: true });
  const workdir = await mkdtemp(join(config.workRoot, `${task.id}-`));
  let cleanup = !config.keepWorktree;
  try {
    await run("git", ["clone", "--no-tags", "--depth=50", cloneUrl, workdir], { token: config.githubToken });
    await run("git", ["config", "user.name", config.gitUserName], { cwd: workdir });
    await run("git", ["config", "user.email", config.gitUserEmail], { cwd: workdir });
    await run("git", ["fetch", "origin", `${pr.head.ref}:${pr.head.ref}`], { cwd: workdir, token: config.githubToken });
    await run("git", ["checkout", pr.head.ref], { cwd: workdir });
    const beforeSha = (await run("git", ["rev-parse", "HEAD"], { cwd: workdir })).stdout.trim();
    const prompt = buildGuardedCodexPrompt(task, pr);
    console.log(`Codex worker claimed ${task.repo}#${task.pullRequestNumber} on ${pr.head.ref}.`);
    const codex = await run(config.codexCommand, renderCodexWorkerArgs(config.codexArgs, prompt, task), {
      cwd: workdir,
      timeoutMs: config.commandTimeoutMs,
    });
    if (codex.exitCode !== 0) {
      throw new Error(lastNonEmptyLine(codex.stderr) || lastNonEmptyLine(codex.stdout) || `Codex exited with ${codex.exitCode}.`);
    }
    const changedFiles = await gitChangedFiles(workdir);
    assertNoForbiddenFiles(changedFiles);
    const hasChanges = changedFiles.length > 0;
    if (hasChanges) {
      await run("git", ["add", "-A"], { cwd: workdir });
      await run("git", ["commit", "-m", commitMessage(task)], { cwd: workdir });
    }
    const afterSha = (await run("git", ["rev-parse", "HEAD"], { cwd: workdir })).stdout.trim();
    if (afterSha !== beforeSha) {
      await run("git", ["push", "origin", `HEAD:${pr.head.ref}`], { cwd: workdir, token: config.githubToken });
      console.log(`Codex pushed ${afterSha.slice(0, 12)} to ${headRepo}:${pr.head.ref}.`);
    } else {
      console.log("Codex completed without producing a new commit.");
    }
    console.log(`Hermes should re-check ${task.repo}#${task.pullRequestNumber} after CI settles.`);
  } finally {
    if (cleanup) {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}

async function fetchPullRequest(task: CodexWorkerTask, config: CodexWorkerConfig): Promise<GithubPullRequestForWorker> {
  const response = await fetch(`${config.apiBaseUrl.replace(/\/$/, "")}/repos/${task.repo}/pulls/${task.pullRequestNumber}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "averray-codex-branch-worker",
      ...(config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub PR lookup failed for ${task.repo}#${task.pullRequestNumber}: HTTP ${response.status}`);
  }
  return await response.json() as GithubPullRequestForWorker;
}

async function gitChangedFiles(cwd: string): Promise<string[]> {
  const result = await run("git", ["status", "--porcelain"], { cwd });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

// Exported so the Claude branch worker reuses the exact same secret-file
// guard + output sanitization (AGENTS.md: never log/commit secrets) rather
// than maintaining a second copy that could drift.
export function assertNoForbiddenFiles(paths: string[], who = "Codex"): void {
  const forbidden = paths.filter((path) => DEFAULT_DENY_PATTERNS.some((pattern) => pattern.test(path)));
  if (forbidden.length > 0) {
    throw new Error(`${who} touched forbidden secret-like file(s): ${forbidden.join(", ")}`);
  }
}

function commitMessage(task: CodexWorkerTask): string {
  const title = (task.title || `PR ${task.pullRequestNumber}`).replace(/\s+/g, " ").trim();
  return `Codex task: ${title}`.slice(0, 72);
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; token?: string } = {}
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, gitArgsWithAuth(command, args, options.token), {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, 5_000).unref();
        reject(new Error(`${command} timed out after ${options.timeoutMs}ms.`));
      }, options.timeoutMs)
      : undefined;
    timeout?.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stdout.write(redact(text));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(redact(text));
    });
    child.on("error", (error) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      const result = { exitCode: code ?? 1, stdout, stderr };
      if (result.exitCode === 0) resolve(result);
      else reject(new Error(lastNonEmptyLine(stderr) || lastNonEmptyLine(stdout) || `${command} exited with ${result.exitCode}.`));
    });
  });
}

function gitArgsWithAuth(command: string, args: string[], token?: string): string[] {
  if (command !== "git" || !token) return args;
  return [
    "-c",
    `http.https://github.com/.extraheader=AUTHORIZATION: Bearer ${token}`,
    ...args,
  ];
}

function resolveGithubTokenForRepo(repo: string, env: NodeJS.ProcessEnv): string | undefined {
  const [owner, name] = repo.split("/");
  const repoToken = owner && name ? parseTokenMap(env.GITHUB_REPO_TOKENS).get(`${owner}/${name}`) : undefined;
  const ownerToken = owner ? parseTokenMap(env.GITHUB_OWNER_TOKENS).get(owner) : undefined;
  const envRepoToken = owner && name ? env[`GITHUB_TOKEN_${toEnvKey(owner)}_${toEnvKey(name)}`]?.trim() : undefined;
  const envOwnerToken = owner ? env[`GITHUB_TOKEN_${toEnvKey(owner)}`]?.trim() : undefined;
  return repoToken
    ?? ownerToken
    ?? envRepoToken
    ?? envOwnerToken
    ?? env.GITHUB_TOKEN?.trim()
    ?? undefined;
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

function parseArgs(value: string | undefined, fallback: string[]): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("CODEX_BRANCH_WORKER_CODEX_ARGS must be a JSON string array when it starts with '['.");
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

function lastNonEmptyLine(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.trim() ?? "";
}

export function redact(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted jwt]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[redacted github token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted api key]");
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runCodexBranchWorker()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
