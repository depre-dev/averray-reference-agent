// Claude task runner (O2/C3) — the per-agent runner that claims approved
// Claude-family tasks (default `agent: "claude"`, or a configured internal
// specialist such as `agent: "test-writer"`) and executes the worker. Mirrors
// codex-task-runner.ts (poll → claim → execute → heartbeat) and ADOPTS the
// auth/billing layer (claude-worker-auth.ts): the route-verification health
// check gates the loop so Claude work never runs on the wrong billing route.
//
// Load-bearing safety, in order, before any task is claimed:
//   1. Route gate — verifyAuthRoute(); on mismatch/misconfig, write a
//      "misconfigured" heartbeat and DO NOT CLAIM (never silently API-bill).
//   2. HALT_FILE — the kill switch; when present, don't claim.
//   3. Budget — in api mode, stop claiming past CLAUDE_WORKER_DAILY_BUDGET.
//   4. Claim — only approved tasks for this runner's configured agent (codex
//      tasks are left to the codex runner via the queue's agent filter).
//
// The executor is command-agnostic (like the codex runner): it spawns the
// configured CLAUDE_TASK_RUNNER_COMMAND (the claude-branch-worker, once it
// lands) with the auth-resolved env — buildClaudeInvocationEnv strips
// ANTHROPIC_API_KEY in sub mode so no key leaks into the child. Tests inject
// a fake executor; no real provider calls here.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { beginLlmUsageCall, recordLlmUsageFromResult, type LlmUsageEvent } from "@avg/averray-mcp/llm-usage";

import { parseBranchWorkerOutcome, type BranchWorkerOutcome } from "./branch-worker-outcome.js";
import {
  budgetGate,
  buildClaudeInvocationEnv,
  verifyAuthRoute,
  type ActiveAuthRoute,
  type ClaudeWorkerAuthEnv,
  type ClaudeWorkerAuthMode,
} from "./claude-worker-auth.js";
import type { CodexTask, CodexTaskRoutingTokenUsage, TaskAgent } from "./codex-task-queue.js";
import {
  claimNextApprovedCodexTask,
  completeCodexTask,
  failCodexTask,
  taskAgent,
  updateCodexTaskProgress,
  updateCodexRunnerHeartbeat,
} from "./codex-task-queue.js";
import { sanitizeOutput, sanitizeTail, tail } from "./codex-task-runner.js";
import { taskAgentLabel } from "./specialist-agents.js";

export interface ClaudeTaskRunnerConfig {
  enabled: boolean;
  /** Queue agent claimed by this runner. Defaults to "claude"; C3 specialists configure this. */
  agent: TaskAgent;
  path?: string;
  runnerId: string;
  command?: string;
  args: string[];
  cwd?: string;
  model?: string;
  pollIntervalMs: number;
  timeoutMs: number;
  outputTailBytes: number;
  /** CLAUDE_WORKER_* auth/billing vars the route gate + budget read. */
  authEnv: ClaudeWorkerAuthEnv;
  /** Kill-switch file; when present the runner refuses to claim. */
  haltFile?: string;
}

export interface ClaudeTaskRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  summary?: string;
  outcome?: BranchWorkerOutcome;
  usage?: unknown;
  model?: string;
  costUsd?: number;
}

export type ClaudeTaskExecutor = (
  task: CodexTask,
  config: ClaudeTaskRunnerConfig,
  ctx: { mode: ClaudeWorkerAuthMode }
) => Promise<ClaudeTaskRunResult>;

export type ClaudeTaskRunnerOnceResult =
  | { status: "disabled" }
  | { status: "misconfigured"; reason: string }
  | { status: "halted" }
  | { status: "budget_exhausted"; reason: string }
  | { status: "idle" }
  | { status: "completed"; task: CodexTask }
  | { status: "failed"; task: CodexTask; reason: string };

export interface ClaudeTaskRunnerDeps {
  /** Injected for tests; defaults to spawning config.command. */
  executor?: ClaudeTaskExecutor;
  /** Live route probe (`claude /status` equiv) for the silent-billing footgun. */
  probeRoute?: () => Promise<ActiveAuthRoute> | ActiveAuthRoute;
  /** Today's API spend (USD) for the budget gate; defaults to 0 until a real spend tracker is wired. */
  spentTodayUsd?: number;
  /** Override the HALT_FILE existence check (tests). */
  isHalted?: (haltFile: string) => boolean;
  now?: Date;
  log?: (message: string) => void;
}

export function parseClaudeTaskRunnerConfig(env: NodeJS.ProcessEnv = process.env): ClaudeTaskRunnerConfig {
  const agent = (env.CLAUDE_TASK_RUNNER_AGENT?.trim() || "claude") as TaskAgent;
  const runnerId = env.CLAUDE_TASK_RUNNER_ID || `${agent}-${hostname()}-${process.pid}`;
  return {
    enabled: env.CLAUDE_TASK_RUNNER_ENABLED === "1" || env.CLAUDE_TASK_RUNNER_ENABLED === "true",
    agent,
    ...(env.AVERRAY_CODEX_TASKS_PATH ? { path: env.AVERRAY_CODEX_TASKS_PATH } : {}),
    runnerId,
    ...(env.CLAUDE_TASK_RUNNER_COMMAND ? { command: env.CLAUDE_TASK_RUNNER_COMMAND } : {}),
    args: parseArgs(env.CLAUDE_TASK_RUNNER_ARGS),
    ...(env.CLAUDE_TASK_RUNNER_CWD ? { cwd: env.CLAUDE_TASK_RUNNER_CWD } : {}),
    ...(env.CLAUDE_TASK_RUNNER_MODEL ? { model: env.CLAUDE_TASK_RUNNER_MODEL } : {}),
    pollIntervalMs: positiveInt(env.CLAUDE_TASK_RUNNER_POLL_INTERVAL_MS, 10_000),
    timeoutMs: positiveInt(env.CLAUDE_TASK_RUNNER_TIMEOUT_MS, 90 * 60_000),
    outputTailBytes: positiveInt(env.CLAUDE_TASK_RUNNER_OUTPUT_TAIL_BYTES, 12_000),
    authEnv: {
      ...(env.CLAUDE_WORKER_AUTH_MODE !== undefined ? { CLAUDE_WORKER_AUTH_MODE: env.CLAUDE_WORKER_AUTH_MODE } : {}),
      ...(env.ANTHROPIC_API_KEY !== undefined ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.CLAUDE_CODE_OAUTH_TOKEN !== undefined ? { CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN } : {}),
      ...(env.CLAUDE_WORKER_DAILY_BUDGET !== undefined ? { CLAUDE_WORKER_DAILY_BUDGET: env.CLAUDE_WORKER_DAILY_BUDGET } : {}),
    },
    ...(env.HALT_FILE ? { haltFile: env.HALT_FILE } : {}),
  };
}

export async function runClaudeTaskRunnerOnce(
  config: ClaudeTaskRunnerConfig,
  deps: ClaudeTaskRunnerDeps = {}
): Promise<ClaudeTaskRunnerOnceResult> {
  const log = deps.log ?? ((m: string) => console.info(m));

  if (!config.enabled) {
    await heartbeat(config, "disabled", `${taskAgentLabel(config.agent)} task runner is disabled.`, deps.now);
    return { status: "disabled" };
  }

  // 1. ROUTE GATE — never claim/execute on the wrong billing route.
  const probedRoute = deps.probeRoute ? await deps.probeRoute() : undefined;
  const verification = verifyAuthRoute(config.authEnv, probedRoute ? { probedRoute } : {});
  if (!verification.ok) {
    const reason = `auth route check failed: ${verification.reason}`;
    log(`[claude-task-runner] REFUSING TO CLAIM (${config.runnerId}/${config.agent}): ${verification.reason}`);
    await heartbeat(config, "misconfigured", reason, deps.now);
    return { status: "misconfigured", reason: verification.reason };
  }
  const mode = verification.mode;
  log(`[claude-task-runner] ${config.runnerId}/${config.agent}: ${verification.message}`);

  // Executor must be configured (mirror codex: command required when live).
  const executor = deps.executor ?? executeClaudeTaskCommand;
  if (!config.command && executor === executeClaudeTaskCommand) {
    const reason = "CLAUDE_TASK_RUNNER_COMMAND is required when the Claude-family task runner is enabled.";
    await heartbeat(config, "misconfigured", reason, deps.now);
    return { status: "misconfigured", reason };
  }

  // 2. HALT_FILE — the kill switch.
  if (config.haltFile) {
    const halted = deps.isHalted ? deps.isHalted(config.haltFile) : existsSync(config.haltFile);
    if (halted) {
      await heartbeat(config, "idle", `HALT_FILE present — not claiming ${taskAgentLabel(config.agent)} tasks.`, deps.now);
      return { status: "halted" };
    }
  }

  // 3. BUDGET — in api mode, stop claiming past the daily cap.
  const gate = budgetGate(mode, deps.spentTodayUsd ?? 0, config.authEnv);
  if (!gate.allowClaim) {
    await heartbeat(config, "idle", gate.reason ?? "Daily budget reached — not claiming.", deps.now);
    return { status: "budget_exhausted", reason: gate.reason ?? "daily budget reached" };
  }

  // 4. CLAIM — only approved tasks for this runner's configured agent.
  const claimed = await claimNextApprovedCodexTask({
    path: config.path,
    runnerId: config.runnerId,
    agent: config.agent,
    now: deps.now,
  });
  if (!claimed) {
    await heartbeat(config, "idle", `${taskAgentLabel(config.agent)} runner is online; no approved ${config.agent} task is waiting.`, deps.now);
    return { status: "idle" };
  }

  await heartbeat(config, "running", `${taskAgentLabel(config.agent)} runner claimed ${taskLabel(claimed)}.`, deps.now, claimed.id);

  const endLlmUsageCall = beginLlmUsageCall({
    agent: config.agent,
    model: config.model,
    taskId: claimed.id,
    ...(claimed.correlationId ? { runId: claimed.correlationId } : {}),
  });
  try {
    const result = await executor(claimed, config, { mode });
    const usageEvent = await recordLlmUsageFromResult({
      agent: config.agent,
      ...(config.model ? { model: config.model } : {}),
      taskId: claimed.id,
      ...(claimed.correlationId ? { runId: claimed.correlationId } : {}),
      result,
    }).catch(() => undefined);
    const outcome = result.outcome ?? parseBranchWorkerOutcome(result.stdout);
    const tokenUsage = routingTokenUsage(usageEvent);
    if (result.exitCode === 0 && outcome?.opened) {
      const summary = openedPullRequestSummary(result, outcome, `${taskAgentLabel(config.agent)} runner opened a pull request.`);
      const task = await completeCodexTask(claimed.id, {
        path: config.path,
        completionSummary: summary,
        exitCode: result.exitCode,
        stdoutTail: sanitizeTail(result.stdout, config.outputTailBytes),
        stderrTail: sanitizeTail(result.stderr, config.outputTailBytes),
        routingOutcome: {
          outcome: "opened_pr",
          ...(tokenUsage ? { tokenUsage } : {}),
        },
      });
      await heartbeat(config, "completed", summary || `${taskAgentLabel(config.agent)} runner completed ${taskLabel(claimed)}.`, undefined, claimed.id);
      return { status: "completed", task: task ?? claimed };
    }
    const reason = outcome && !outcome.opened
      ? noPullRequestFailureReason(outcome)
      : result.exitCode === 0
        ? `${taskAgentLabel(config.agent)} task command exited successfully but did not report an opened pull request.`
        : summarizeFailure(result);
    const task = await failCodexTask(claimed.id, {
      path: config.path,
      failureReason: reason,
      exitCode: result.exitCode,
      stdoutTail: sanitizeTail(result.stdout, config.outputTailBytes),
      stderrTail: sanitizeTail(result.stderr, config.outputTailBytes),
      routingOutcome: {
        outcome: outcome && !outcome.opened ? "no_pr" : "failed",
        ...(tokenUsage ? { tokenUsage } : {}),
      },
    });
    await heartbeat(config, "failed", reason, undefined, claimed.id);
    return { status: "failed", task: task ?? claimed, reason };
  } catch (error) {
    const reason = sanitizeOutput(error instanceof Error ? error.message : String(error));
    const task = await failCodexTask(claimed.id, {
      path: config.path,
      failureReason: reason,
      routingOutcome: { outcome: "failed" },
    });
    await heartbeat(config, "error", reason, undefined, claimed.id);
    return { status: "failed", task: task ?? claimed, reason };
  } finally {
    endLlmUsageCall();
  }
}

export async function runClaudeTaskRunnerForever(
  config: ClaudeTaskRunnerConfig,
  deps: ClaudeTaskRunnerDeps & { signal?: AbortSignal } = {}
): Promise<void> {
  while (!deps.signal?.aborted) {
    const result = await runClaudeTaskRunnerOnce(config, deps);
    if (result.status === "misconfigured") {
      console.warn(`[claude-task-runner] ${result.reason}`);
    } else if (result.status === "completed") {
      console.info(`[claude-task-runner] completed ${result.task.id}`);
    } else if (result.status === "failed") {
      console.warn(`[claude-task-runner] failed ${result.task.id}: ${result.reason}`);
    }
    await sleep(config.pollIntervalMs, deps.signal);
  }
}

export async function executeClaudeTaskCommand(
  task: CodexTask,
  config: ClaudeTaskRunnerConfig,
  ctx: { mode: ClaudeWorkerAuthMode }
): Promise<ClaudeTaskRunResult> {
  if (!config.command) {
    throw new Error("CLAUDE_TASK_RUNNER_COMMAND is not configured.");
  }
  // Auth-resolved env: strip ANTHROPIC_API_KEY in sub mode so it cannot
  // silently win in the child invocation.
  const childEnv = buildClaudeInvocationEnv(taskEnvironment(task), ctx.mode);

  return await new Promise((resolve, reject) => {
    const child = spawn(config.command as string, renderArgs(config.args, task), {
      cwd: config.cwd,
      env: childEnv,
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
      reject(new Error(`Claude task command timed out after ${config.timeoutMs}ms.`));
    }, config.timeoutMs);
    timeout.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = tail(stdout + chunk.toString("utf8"), config.outputTailBytes);
      publishProgress(lastMeaningfulLine(stdout) || "Claude runner emitted output.");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString("utf8"), config.outputTailBytes);
      publishProgress(lastMeaningfulLine(stderr) || "Claude runner emitted stderr.");
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
        const outcome = parseBranchWorkerOutcome(stdout);
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          summary: (outcome?.summary ?? summarizeCommandResult(stdout)) || summarizeCommandResult(stderr),
          outcome,
        });
      });
    });
  });
}

function taskEnvironment(task: CodexTask): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_TASK_ID: task.id,
    CLAUDE_TASK_REPO: task.repo,
    CLAUDE_TASK_PR: task.pullRequestNumber != null ? String(task.pullRequestNumber) : "",
    CLAUDE_TASK_TITLE: task.title ?? "",
    CLAUDE_TASK_CORRELATION_ID: task.correlationId ?? "",
    CLAUDE_TASK_REASON: task.reason ?? "",
    CLAUDE_TASK_REQUESTER: task.requester ?? "",
    CLAUDE_TASK_AGENT: taskAgent(task),
    CLAUDE_TASK_PROMPT: task.prompt,
  };
}

function taskLabel(task: CodexTask): string {
  return task.pullRequestNumber != null ? `${task.repo}#${task.pullRequestNumber}` : `${task.repo} (greenfield)`;
}

async function heartbeat(
  config: ClaudeTaskRunnerConfig,
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

function summarizeFailure(result: ClaudeTaskRunResult): string {
  const stderr = sanitizeOutput(summarizeCommandResult(result.stderr));
  const stdout = sanitizeOutput(summarizeCommandResult(result.stdout));
  return stderr || stdout || `Claude task command exited with ${result.exitCode}.`;
}

function openedPullRequestSummary(result: ClaudeTaskRunResult, outcome: Extract<BranchWorkerOutcome, { opened: true }>, fallback: string): string {
  const summary = sanitizeOutput((result.summary ?? outcome.summary ?? summarizeCommandResult(result.stdout)) || fallback);
  const url = outcome.pullRequestUrl ? sanitizeOutput(outcome.pullRequestUrl) : "";
  if (!url || summary.includes(url)) return summary;
  return `${summary}\n${url}`.trim();
}

function noPullRequestFailureReason(outcome: Extract<BranchWorkerOutcome, { opened: false }>): string {
  return sanitizeOutput(outcome.reason || outcome.summary || "Worker finished without opening a pull request.");
}

function routingTokenUsage(event: LlmUsageEvent | undefined): CodexTaskRoutingTokenUsage | undefined {
  if (!event) return undefined;
  return {
    model: event.model,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    ...(event.cacheTokens !== undefined ? { cacheTokens: event.cacheTokens } : {}),
    totalTokens: event.inputTokens + event.outputTokens + (event.cacheTokens ?? 0),
    ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
  };
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
      throw new Error("CLAUDE_TASK_RUNNER_ARGS must be a JSON string array when it starts with '['.");
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
}

export function renderArgs(args: string[], task: CodexTask): string[] {
  const replacements: Record<string, string> = {
    "{taskId}": task.id,
    "{repo}": task.repo,
    "{pr}": task.pullRequestNumber != null ? String(task.pullRequestNumber) : "",
    "{title}": task.title ?? "",
    "{correlationId}": task.correlationId ?? "",
    "{prompt}": task.prompt,
  };
  return args.map((arg) => {
    let value = arg;
    for (const [token, replacement] of Object.entries(replacements)) {
      value = value.split(token).join(replacement);
    }
    return value;
  });
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
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
  runClaudeTaskRunnerForever(parseClaudeTaskRunnerConfig(), { signal: controller.signal })
    .catch((error) => {
      console.error("[claude-task-runner] fatal", error);
      process.exitCode = 1;
    });
}
