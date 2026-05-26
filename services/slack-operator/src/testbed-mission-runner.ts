import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TestbedMissionRun } from "./monitor-testbed-missions.js";
import {
  claimNextReadyTestbedMission,
  failTestbedMissionRun,
  recordTestbedMissionReportFromMessage,
  updateTestbedMissionProgress,
  updateTestbedMissionRunnerHeartbeat,
} from "./monitor-testbed-missions.js";

export interface TestbedMissionRunnerConfig {
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

export interface TestbedMissionRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  reportText?: string;
  summary?: string;
}

export type TestbedMissionExecutor = (
  mission: TestbedMissionRun,
  config: TestbedMissionRunnerConfig
) => Promise<TestbedMissionRunResult>;

export type TestbedMissionRunnerOnceResult =
  | { status: "disabled" }
  | { status: "misconfigured"; reason: string }
  | { status: "idle" }
  | { status: "completed"; mission: TestbedMissionRun }
  | { status: "failed"; mission: TestbedMissionRun; reason: string };

export function parseTestbedMissionRunnerConfig(
  env: NodeJS.ProcessEnv = process.env
): TestbedMissionRunnerConfig {
  return {
    enabled: env.TESTBED_MISSION_RUNNER_ENABLED === "1" || env.TESTBED_MISSION_RUNNER_ENABLED === "true",
    ...(env.AVERRAY_TESTBED_MISSIONS_PATH ? { path: env.AVERRAY_TESTBED_MISSIONS_PATH } : {}),
    runnerId: env.TESTBED_MISSION_RUNNER_ID || `testbed-mission-runner-${process.pid}`,
    ...(env.TESTBED_MISSION_RUNNER_COMMAND ? { command: env.TESTBED_MISSION_RUNNER_COMMAND } : {}),
    args: parseArgs(env.TESTBED_MISSION_RUNNER_ARGS),
    ...(env.TESTBED_MISSION_RUNNER_CWD ? { cwd: env.TESTBED_MISSION_RUNNER_CWD } : {}),
    pollIntervalMs: positiveInt(env.TESTBED_MISSION_RUNNER_POLL_INTERVAL_MS, 10_000),
    timeoutMs: positiveInt(env.TESTBED_MISSION_RUNNER_TIMEOUT_MS, 20 * 60_000),
    outputTailBytes: positiveInt(env.TESTBED_MISSION_RUNNER_OUTPUT_TAIL_BYTES, 12_000),
  };
}

export async function runTestbedMissionRunnerOnce(
  config: TestbedMissionRunnerConfig,
  deps: { executor?: TestbedMissionExecutor; now?: Date } = {}
): Promise<TestbedMissionRunnerOnceResult> {
  if (!config.enabled) {
    updateRunnerHeartbeat(config, "disabled", "Hermes testbed runner is disabled.", deps.now);
    return { status: "disabled" };
  }
  const executor = deps.executor ?? executeTestbedMissionCommand;
  if (!config.command && executor === executeTestbedMissionCommand) {
    const reason = "TESTBED_MISSION_RUNNER_COMMAND is required when the Hermes testbed runner is enabled.";
    updateRunnerHeartbeat(config, "misconfigured", reason, deps.now);
    return { status: "misconfigured", reason };
  }

  const mission = claimNextReadyTestbedMission({
    path: config.path,
    runnerId: config.runnerId,
    now: deps.now,
  });
  if (!mission) {
    updateRunnerHeartbeat(config, "idle", "Hermes testbed runner is online; no browser mission is waiting.", deps.now);
    return { status: "idle" };
  }

  updateRunnerHeartbeat(
    config,
    "running",
    `Hermes testbed runner claimed ${mission.id}.`,
    deps.now,
    mission.id
  );

  try {
    const result = await executor(mission, config);
    if (result.exitCode !== 0) {
      const reason = summarizeFailure(result);
      const failed = failTestbedMissionRun(mission.id, {
        path: config.path,
        failureReason: reason,
        stdoutTail: sanitizeTail(result.stdout, config.outputTailBytes),
        stderrTail: sanitizeTail(result.stderr, config.outputTailBytes),
      }) ?? mission;
      updateRunnerHeartbeat(config, "failed", reason, undefined, mission.id);
      return { status: "failed", mission: failed, reason };
    }

    const reportText = result.reportText ?? result.stdout;
    const updated = recordTestbedMissionReportFromMessage({
      relatedCorrelationId: mission.id,
      text: reportText,
      path: config.path,
    });
    if (!updated) {
      const reason = "Hermes testbed runner finished, but the output did not contain a valid structured mission report.";
      const failed = failTestbedMissionRun(mission.id, {
        path: config.path,
        failureReason: reason,
        stdoutTail: sanitizeTail(result.stdout, config.outputTailBytes),
        stderrTail: sanitizeTail(result.stderr, config.outputTailBytes),
      }) ?? mission;
      updateRunnerHeartbeat(config, "failed", reason, undefined, mission.id);
      return { status: "failed", mission: failed, reason };
    }

    const message = updated.status === "completed"
      ? `Hermes testbed runner completed ${mission.id}.`
      : `Hermes testbed runner attached a failing report for ${mission.id}.`;
    updateRunnerHeartbeat(
      config,
      updated.status === "completed" ? "completed" : "failed",
      message,
      undefined,
      mission.id
    );
    return updated.status === "completed"
      ? { status: "completed", mission: updated }
      : { status: "failed", mission: updated, reason: updated.statusReason };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = failTestbedMissionRun(mission.id, {
      path: config.path,
      failureReason: reason,
    }) ?? mission;
    updateRunnerHeartbeat(config, "error", reason, undefined, mission.id);
    return { status: "failed", mission: failed, reason };
  }
}

export async function runTestbedMissionRunnerForever(
  config: TestbedMissionRunnerConfig,
  deps: { executor?: TestbedMissionExecutor; signal?: AbortSignal } = {}
): Promise<void> {
  let idleLogged = false;
  while (!deps.signal?.aborted) {
    const result = await runTestbedMissionRunnerOnce(config, { executor: deps.executor });
    if (result.status === "misconfigured") {
      console.warn(`[testbed-mission-runner] ${result.reason}`);
      idleLogged = false;
    } else if (result.status === "disabled") {
      if (!idleLogged) console.info("[testbed-mission-runner] disabled; set TESTBED_MISSION_RUNNER_ENABLED=1 to claim missions");
      idleLogged = true;
    } else if (result.status === "idle") {
      if (!idleLogged) console.info("[testbed-mission-runner] idle; waiting for a browser mission");
      idleLogged = true;
    } else if (result.status === "completed") {
      console.info(`[testbed-mission-runner] completed ${result.mission.id}`);
      idleLogged = false;
    } else if (result.status === "failed") {
      console.warn(`[testbed-mission-runner] failed ${result.mission.id}: ${result.reason}`);
      idleLogged = false;
    }
    await sleep(config.pollIntervalMs, deps.signal);
  }
}

export async function executeTestbedMissionCommand(
  mission: TestbedMissionRun,
  config: TestbedMissionRunnerConfig
): Promise<TestbedMissionRunResult> {
  if (!config.command) {
    throw new Error("TESTBED_MISSION_RUNNER_COMMAND is not configured.");
  }

  const runDir = await mkdtemp(join(tmpdir(), "averray-testbed-mission-"));
  const reportPath = join(runDir, "report.json");
  return await new Promise((resolve, reject) => {
    const child = spawn(config.command as string, renderTestbedMissionRunnerArgs(config.args, mission, reportPath), {
      cwd: config.cwd,
      env: missionEnvironment(mission, reportPath),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    let lastProgressWrite = 0;

    const publishProgress = (message: string) => {
      const now = Date.now();
      if (now - lastProgressWrite < 2_000) return;
      lastProgressWrite = now;
      updateTestbedMissionProgress(mission.id, {
        path: config.path,
        progressMessage: message,
        stdoutTail: sanitizeTail(stdout, config.outputTailBytes),
        stderrTail: sanitizeTail(stderr, config.outputTailBytes),
      });
    };

    const timeout = setTimeout(() => {
      if (finished) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 5_000).unref();
      reject(new Error(`Hermes testbed runner command timed out after ${config.timeoutMs}ms.`));
    }, config.timeoutMs);
    timeout.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = tail(stdout + chunk.toString("utf8"), config.outputTailBytes);
      publishProgress(lastMeaningfulLine(stdout) || "Hermes testbed runner emitted output.");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = tail(stderr + chunk.toString("utf8"), config.outputTailBytes);
      publishProgress(lastMeaningfulLine(stderr) || "Hermes testbed runner emitted stderr.");
    });
    child.on("error", (error) => {
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      finished = true;
      clearTimeout(timeout);
      readFile(reportPath, "utf8")
        .catch(() => "")
        .then((reportText) => {
          resolve({
            exitCode: code ?? 1,
            stdout,
            stderr,
            ...(reportText.trim() ? { reportText } : {}),
            summary: summarizeCommandResult(stdout) || summarizeCommandResult(stderr),
          });
        });
    });
  });
}

export function renderTestbedMissionRunnerArgs(
  args: string[],
  mission: TestbedMissionRun,
  reportPath: string
): string[] {
  const prompt = missionPrompt(mission);
  const replacements: Record<string, string> = {
    "{missionId}": mission.id,
    "{targetUrl}": mission.targetUrl,
    "{goal}": mission.goal,
    "{agentName}": mission.agentName,
    "{prompt}": prompt,
    "{reportPath}": reportPath,
    "{TESTBED_MISSION_ID}": mission.id,
    "{TESTBED_TARGET_URL}": mission.targetUrl,
    "{TESTBED_MISSION_GOAL}": mission.goal,
    "{TESTBED_MISSION_PROMPT}": prompt,
    "{TESTBED_MISSION_REPORT_PATH}": reportPath,
  };
  return args.map((arg) => {
    let value = arg;
    for (const [token, replacement] of Object.entries(replacements)) {
      value = value.split(token).join(replacement);
    }
    return value;
  });
}

function missionEnvironment(mission: TestbedMissionRun, reportPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TESTBED_MISSION_ID: mission.id,
    TESTBED_TARGET_URL: mission.targetUrl,
    TESTBED_MISSION_GOAL: mission.goal,
    TESTBED_AGENT_NAME: mission.agentName,
    TESTBED_FRESH_MEMORY: String(mission.freshMemory),
    TESTBED_ALLOW_TEST_MUTATIONS: String(mission.allowTestMutations),
    TESTBED_MISSION_PROMPT: missionPrompt(mission),
    TESTBED_MISSION_JSON: JSON.stringify(mission.mission),
    TESTBED_MISSION_REPORT_PATH: reportPath,
  };
}

function missionPrompt(mission: TestbedMissionRun): string {
  const packetPrompt = mission.mission && typeof mission.mission.missionPrompt === "string"
    ? mission.mission.missionPrompt
    : "";
  return packetPrompt || [
    `Run testbed mission ${mission.id}.`,
    `Target: ${mission.targetUrl}`,
    `Goal: ${mission.goal}`,
    mission.allowTestMutations
      ? "Use a fresh browser context and complete only clearly fake/testbed page actions."
      : "Use a fresh browser context and stop before irreversible mutation.",
    "Return only the structured JSON report requested by the mission packet.",
  ].join("\n");
}

function updateRunnerHeartbeat(
  config: TestbedMissionRunnerConfig,
  status: Parameters<typeof updateTestbedMissionRunnerHeartbeat>[0]["status"],
  message: string,
  now?: Date,
  activeMissionId?: string
): void {
  try {
    updateTestbedMissionRunnerHeartbeat({
      path: config.path,
      runnerId: config.runnerId,
      status,
      message,
      ...(activeMissionId ? { activeMissionId } : {}),
      ...(now ? { now } : {}),
    });
  } catch {
    // Heartbeat writes are advisory; the mission claim/result remains authoritative.
  }
}

function summarizeFailure(result: TestbedMissionRunResult): string {
  const stderr = sanitizeOutput(summarizeCommandResult(result.stderr));
  const stdout = sanitizeOutput(summarizeCommandResult(result.stdout));
  return stderr || stdout || `Hermes testbed runner command exited with ${result.exitCode}.`;
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
      throw new Error("TESTBED_MISSION_RUNNER_ARGS must be a JSON string array when it starts with '['.");
    }
    return parsed;
  }
  return trimmed.split(/\s+/);
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
  runTestbedMissionRunnerForever(parseTestbedMissionRunnerConfig(), { signal: controller.signal })
    .catch((error) => {
      console.error("[testbed-mission-runner] fatal", error);
      process.exitCode = 1;
    });
}
