import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

import type { CodexTask } from "./codex-task-queue.js";
import {
  claimNextApprovedCodexTask,
  completeCodexTask,
  failCodexTask,
  updateCodexTaskProgress,
  updateCodexRunnerHeartbeat,
} from "./codex-task-queue.js";

export interface CodexTaskRunnerConfig {
  enabled: boolean;
  path?: string;
  runnerId: string;
  command?: string;
  args: string[];
  cwd?: string;
  pollIntervalMs: number;
  timeoutMs: number;
  outputTailBytes: number;
}

export interface CodexTaskRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  summary?: string;
}

export type CodexTaskExecutor = (
  task: CodexTask,
  config: CodexTaskRunnerConfig
) => Promise<CodexTaskRunResult>;

export type CodexTaskRunnerOnceResult =
  | { status: "disabled" }
  | { status: "misconfigured"; reason: string }
  | { status: "idle" }
  | { status: "completed"; task: CodexTask }
  | { status: "failed"; task: CodexTask; reason: string };

export function parseCodexTaskRunnerConfig(env: NodeJS.ProcessEnv = process.env): CodexTaskRunnerConfig {
  const runnerId = env.CODEX_TASK_RUNNER_ID
    || `${hostname()}-${process.pid}`;
  return {
    enabled: env.CODEX_TASK_RUNNER_ENABLED === "1" || env.CODEX_TASK_RUNNER_ENABLED === "true",
    ...(env.AVERRAY_CODEX_TASKS_PATH ? { path: env.AVERRAY_CODEX_TASKS_PATH } : {}),
    runnerId,
    ...(env.CODEX_TASK_RUNNER_COMMAND ? { command: env.CODEX_TASK_RUNNER_COMMAND } : {}),
    args: parseArgs(env.CODEX_TASK_RUNNER_ARGS),
    ...(env.CODEX_TASK_RUNNER_CWD ? { cwd: env.CODEX_TASK_RUNNER_CWD } : {}),
    pollIntervalMs: positiveInt(env.CODEX_TASK_RUNNER_POLL_INTERVAL_MS, 10_000),
    timeoutMs: positiveInt(env.CODEX_TASK_RUNNER_TIMEOUT_MS, 30 * 60_000),
    outputTailBytes: positiveInt(env.CODEX_TASK_RUNNER_OUTPUT_TAIL_BYTES, 12_000),
  };
}

export async function runCodexTaskRunnerOnce(
  config: CodexTaskRunnerConfig,
  deps: { executor?: CodexTaskExecutor; now?: Date } = {}
): Promise<CodexTaskRunnerOnceResult> {
  if (!config.enabled) {
    await updateRunnerHeartbeat(config, "disabled", "Codex task runner is disabled.", deps.now);
    return { status: "disabled" };
  }
  const executor = deps.executor ?? executeCodexTaskCommand;
  if (!config.command && executor === executeCodexTaskCommand) {
    await updateRunnerHeartbeat(
      config,
      "misconfigured",
      "CODEX_TASK_RUNNER_COMMAND is required when the Codex task runner is enabled.",
      deps.now
    );
    return {
      status: "misconfigured",
      reason: "CODEX_TASK_RUNNER_COMMAND is required when the Codex task runner is enabled.",
    };
  }

  const claimed = await claimNextApprovedCodexTask({
    path: config.path,
    runnerId: config.runnerId,
    now: deps.now,
  });
  if (!claimed) {
    await updateRunnerHeartbeat(config, "idle", "Codex runner is online; no approved task is waiting.", deps.now);
    return { status: "idle" };
  }

  await updateRunnerHeartbeat(
    config,
    "running",
    `Codex runner claimed ${claimed.repo}#${claimed.pullRequestNumber}.`,
    deps.now,
    claimed.id
  );

  try {
    const result = await executor(claimed, config);
    if (result.exitCode === 0) {
      const summary = sanitizeOutput(result.summary ?? summarizeCommandResult(result.stdout));
      const task = await completeCodexTask(claimed.id, {
        path: config.path,
        completionSummary: summary,
        exitCode: result.exitCode,
        stdoutTail: sanitizeTail(result.stdout, config.outputTailBytes),
        stderrTail: sanitizeTail(result.stderr, config.outputTailBytes),
      });
      await updateRunnerHeartbeat(
        config,
        "completed",
        summary || `Codex runner completed ${claimed.repo}#${claimed.pullRequestNumber}.`,
        undefined,
        claimed.id
      );
      return { status: "completed", task: task ?? claimed };
    }
    const reason = summarizeFailure(result);
    const task = await failCodexTask(claimed.id, {
      path: config.path,
      failureReason: reason,
      exitCode: result.exitCode,
      stdoutTail: sanitizeTail(result.stdout, config.outputTailBytes),
      stderrTail: sanitizeTail(result.stderr, config.outputTailBytes),
    });
    await updateRunnerHeartbeat(config, "failed", reason, undefined, claimed.id);
    return { status: "failed", task: task ?? claimed, reason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const task = await failCodexTask(claimed.id, {
      path: config.path,
      failureReason: reason,
    });
    await updateRunnerHeartbeat(config, "error", reason, undefined, claimed.id);
    return { status: "failed", task: task ?? claimed, reason };
  }
}

export async function runCodexTaskRunnerForever(
  config: CodexTaskRunnerConfig,
  deps: { executor?: CodexTaskExecutor; signal?: AbortSignal } = {}
): Promise<void> {
  while (!deps.signal?.aborted) {
    const result = await runCodexTaskRunnerOnce(config, { executor: deps.executor });
    if (result.status === "misconfigured") {
      console.warn(`[codex-task-runner] ${result.reason}`);
    } else if (result.status === "completed") {
      console.info(`[codex-task-runner] completed ${result.task.id}`);
    } else if (result.status === "failed") {
      console.warn(`[codex-task-runner] failed ${result.task.id}: ${result.reason}`);
    }
    await sleep(config.pollIntervalMs, deps.signal);
  }
}

export async function executeCodexTaskCommand(
  task: CodexTask,
  config: CodexTaskRunnerConfig
): Promise<CodexTaskRunResult> {
  if (!config.command) {
    throw new Error("CODEX_TASK_RUNNER_COMMAND is not configured.");
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(config.command as string, renderCodexTaskRunnerArgs(config.args, task), {
      cwd: config.cwd,
      env: taskEnvironment(task),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let lastProgressWrite = 0;
    let progressWrites: Promise<unknown> = Promise.resolve();
    const publishProgress = (message: string) => {
      const now = Date.now();
      if (now - lastProgressWrite < 2_000) return;
      lastProgressWrite = now;
      progressWrites = progressWrites
        .then(() => updateCodexTaskProgress(task.id, {
          path: config.path,
          progressMessage: message,
          stdoutTail: sanitizeTail(stdout, config.outputTailBytes),
          stderrTail: sanitizeTail(stderr, config.outputTailBytes),
        }))
        .catch(() => undefined);
    };
    const timeout = setTimeout(() => {
      if (finished) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 5_000).unref();
      reject(new Error(`Codex task command timed out after ${config.timeoutMs}ms.`));
    }, config.timeoutMs);
    timeout.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = tail(stdout + chunk.toString("utf8"), config.outputTailBytes);
      publishProgress(lastMeaningfulLine(stdout) || "Codex runner emitted output.");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString("utf8"), config.outputTailBytes);
      publishProgress(lastMeaningfulLine(stderr) || "Codex runner emitted stderr.");
    });
    child.on("error", (error) => {
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      finished = true;
      clearTimeout(timeout);
      progressWrites.finally(() => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          summary: summarizeCommandResult(stdout) || summarizeCommandResult(stderr),
        });
      });
    });
  });
}

function taskEnvironment(task: CodexTask): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CODEX_TASK_ID: task.id,
    CODEX_TASK_REPO: task.repo,
    CODEX_TASK_PR: String(task.pullRequestNumber),
    CODEX_TASK_TITLE: task.title ?? "",
    CODEX_TASK_CORRELATION_ID: task.correlationId ?? "",
    CODEX_TASK_REASON: task.reason ?? "",
    CODEX_TASK_REQUESTER: task.requester ?? "",
    CODEX_TASK_PROMPT: task.prompt,
  };
}

async function updateRunnerHeartbeat(
  config: CodexTaskRunnerConfig,
  status: Parameters<typeof updateCodexRunnerHeartbeat>[0]["status"],
  message: string,
  now?: Date,
  activeTaskId?: string
): Promise<void> {
  await updateCodexRunnerHeartbeat({
    path: config.path,
    runnerId: config.runnerId,
    status,
    message,
    ...(activeTaskId ? { activeTaskId } : {}),
    ...(now ? { now } : {}),
  }).catch(() => undefined);
}

function summarizeFailure(result: CodexTaskRunResult): string {
  const stderr = sanitizeOutput(summarizeCommandResult(result.stderr));
  const stdout = sanitizeOutput(summarizeCommandResult(result.stdout));
  return stderr || stdout || `Codex task command exited with ${result.exitCode}.`;
}

function summarizeCommandResult(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("\n").trim();
}

function lastMeaningfulLine(value: string): string {
  return value.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.trim() ?? "";
}

function parseArgs(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("CODEX_TASK_RUNNER_ARGS must be a JSON string array when it starts with '['.");
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
}

export function renderCodexTaskRunnerArgs(args: string[], task: CodexTask): string[] {
  const replacements: Record<string, string> = {
    "{taskId}": task.id,
    "{repo}": task.repo,
    "{pr}": String(task.pullRequestNumber),
    "{title}": task.title ?? "",
    "{correlationId}": task.correlationId ?? "",
    "{prompt}": task.prompt,
    "{CODEX_TASK_ID}": task.id,
    "{CODEX_TASK_REPO}": task.repo,
    "{CODEX_TASK_PR}": String(task.pullRequestNumber),
    "{CODEX_TASK_TITLE}": task.title ?? "",
    "{CODEX_TASK_CORRELATION_ID}": task.correlationId ?? "",
    "{CODEX_TASK_PROMPT}": task.prompt,
  };
  return args.map((arg) => {
    let value = arg;
    for (const [token, replacement] of Object.entries(replacements)) {
      value = value.split(token).join(replacement);
    }
    return value;
  });
}

function sanitizeTail(value: string, maxBytes: number): string | undefined {
  const output = sanitizeOutput(tail(value, maxBytes));
  return output ? output : undefined;
}

function sanitizeOutput(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[redacted private key]")
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted jwt]")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g, "[redacted github token]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[redacted api key]");
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function tail(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(-maxBytes).toString("utf8");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref();
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  runCodexTaskRunnerForever(parseCodexTaskRunnerConfig(), { signal: controller.signal })
    .catch((error) => {
      console.error("[codex-task-runner] fatal", error);
      process.exitCode = 1;
    });
}
