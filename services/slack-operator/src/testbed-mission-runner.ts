import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordLlmUsageFromResult } from "@avg/averray-mcp/llm-usage";

import type { BrowserContext, Locator, Page } from "playwright-core";

import type { TestbedMissionRun } from "./monitor-testbed-missions.js";
import {
  claimNextReadyTestbedMission,
  failTestbedMissionRun,
  recordTestbedMissionReportFromMessage,
  updateTestbedMissionProgress,
  updateTestbedMissionRunnerHeartbeat,
} from "./monitor-testbed-missions.js";
import { executeSiweAuthMission, type SiweAuthMissionDeps } from "./testbed-auth-mission.js";
import { executeSurfaceSweep, type SurfaceSweepDeps } from "./testbed-surface-sweep.js";
import {
  parseSweepSessionConfig,
  resolveSweepSession,
  type SweepSession,
  type SweepSessionConfig,
} from "./testbed-session.js";

export interface TestbedMissionRunnerConfig {
  enabled: boolean;
  path?: string;
  runnerId: string;
  executor?: "playwright" | "command";
  command?: string;
  args: string[];
  cwd?: string;
  pollIntervalMs: number;
  timeoutMs: number;
  outputTailBytes: number;
  browserExecutablePath?: string;
  artifactsDir?: string;
  maxBrowserSteps?: number;
  /** Base URL the surface sweep (T1) joins relative routes to. */
  appBaseUrl?: string;
  /** Base URL for platform API role-gating probes (T3 SIWE mission). */
  apiBaseUrl?: string;
  /** Local signer sidecar URL for T3 SIWE mission sessions. */
  signerBaseUrl?: string;
  authAdminJobsPath?: string;
  authVerifierRunPath?: string;
  authProtectedPath?: string;
  /** The env's truth boundary the sweep asserts surfaces label (demo/testnet/local-simulation/production). */
  expectedBoundary?: string;
  /** T5: env name bound to mutation policy (testnet/local/staging may mutate; mainnet is read-only). */
  missionEnvironment?: string;
  /** T5 evidence capture toggles. Defaults on for the Playwright executor. */
  captureTrace?: boolean;
  captureVideo?: boolean;
  /** T2 pre-seeded session source (sidecar URL and/or manual storageState path/token). */
  session?: SweepSessionConfig;
}

/** Injected session resolution for tests (defaults to the env-config resolver). */
export interface BrowserMissionDeps extends SurfaceSweepDeps {
  resolveSession?: (config: TestbedMissionRunnerConfig) => Promise<SweepSession | undefined>;
}

export interface TestbedMissionRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  reportText?: string;
  summary?: string;
  usage?: unknown;
  model?: string;
  costUsd?: number;
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
    executor: parseExecutor(env.TESTBED_MISSION_RUNNER_EXECUTOR, env.TESTBED_MISSION_RUNNER_COMMAND),
    ...(env.TESTBED_MISSION_RUNNER_COMMAND ? { command: env.TESTBED_MISSION_RUNNER_COMMAND } : {}),
    args: parseArgs(env.TESTBED_MISSION_RUNNER_ARGS),
    ...(env.TESTBED_MISSION_RUNNER_CWD ? { cwd: env.TESTBED_MISSION_RUNNER_CWD } : {}),
    pollIntervalMs: positiveInt(env.TESTBED_MISSION_RUNNER_POLL_INTERVAL_MS, 10_000),
    timeoutMs: positiveInt(env.TESTBED_MISSION_RUNNER_TIMEOUT_MS, 20 * 60_000),
    outputTailBytes: positiveInt(env.TESTBED_MISSION_RUNNER_OUTPUT_TAIL_BYTES, 12_000),
    ...(env.TESTBED_MISSION_BROWSER_EXECUTABLE_PATH ? { browserExecutablePath: env.TESTBED_MISSION_BROWSER_EXECUTABLE_PATH } : {}),
    artifactsDir: env.TESTBED_MISSION_ARTIFACTS_DIR || "/data/testbed-mission-artifacts",
    maxBrowserSteps: positiveInt(env.TESTBED_MISSION_MAX_BROWSER_STEPS, 8),
    ...(env.AVERRAY_APP_BASE_URL || env.AVERRAY_API_BASE_URL
      ? { appBaseUrl: env.AVERRAY_APP_BASE_URL || env.AVERRAY_API_BASE_URL }
      : {}),
    ...(env.AVERRAY_API_BASE_URL ? { apiBaseUrl: env.AVERRAY_API_BASE_URL } : {}),
    signerBaseUrl: env.TEST_WALLET_SIGNER_BASE_URL || "http://127.0.0.1:8791",
    authAdminJobsPath: env.TESTBED_AUTH_ADMIN_JOBS_PATH || "/admin/jobs",
    authVerifierRunPath: env.TESTBED_AUTH_VERIFIER_RUN_PATH || "/verifier/run",
    authProtectedPath: env.TESTBED_AUTH_PROTECTED_PATH || env.TESTBED_AUTH_ADMIN_JOBS_PATH || "/admin/jobs",
    ...(env.AVERRAY_TESTBED_EXPECTED_BOUNDARY ? { expectedBoundary: env.AVERRAY_TESTBED_EXPECTED_BOUNDARY } : {}),
    ...(env.TESTBED_MISSION_ENVIRONMENT || env.AVERRAY_TESTBED_ENVIRONMENT
      ? { missionEnvironment: env.TESTBED_MISSION_ENVIRONMENT || env.AVERRAY_TESTBED_ENVIRONMENT }
      : {}),
    captureTrace: env.TESTBED_MISSION_CAPTURE_TRACE !== "0" && env.TESTBED_MISSION_CAPTURE_TRACE !== "false",
    captureVideo: env.TESTBED_MISSION_CAPTURE_VIDEO !== "0" && env.TESTBED_MISSION_CAPTURE_VIDEO !== "false",
    session: parseSweepSessionConfig(env),
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
  const executorMode = config.executor ?? (config.command ? "command" : "playwright");
  const executor = deps.executor ?? (executorMode === "command" ? executeTestbedMissionCommand : executeBrowserTestbedMission);
  if (executorMode === "command" && !config.command && executor === executeTestbedMissionCommand) {
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
    await recordLlmUsageFromResult({
      agent: "hermes",
      taskId: mission.id,
      runId: mission.id,
      result,
    }).catch(() => undefined);
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

/**
 * Default browser executor: dispatch by mission mode. A `surface_sweep`
 * mission (T1) walks a route list read-only and runs the boundary-honesty
 * check; any other mission keeps the existing single-URL "explore" heuristic.
 */
export async function executeBrowserTestbedMission(
  mission: TestbedMissionRun,
  config: TestbedMissionRunnerConfig,
  deps: BrowserMissionDeps & SiweAuthMissionDeps = {}
): Promise<TestbedMissionRunResult> {
  if (mission.mode === "surface_sweep") {
    // T2: resolve the pre-seeded session (sidecar or manual) so the sweep can
    // reach authed routes. No session → public-only (graceful fallback).
    const resolveSession = deps.resolveSession ?? defaultResolveSweepSession;
    const session = await resolveSession(config);
    // Drop the SweepSessionConfig (env source) and pass the RESOLVED session.
    const { session: _sessionConfig, ...sweepConfig } = config;
    return executeSurfaceSweep(mission, { ...sweepConfig, ...(session ? { session } : {}) }, deps);
  }
  if (mission.mode === "siwe_auth") {
    return executeSiweAuthMission(mission, config, deps);
  }
  return executePlaywrightTestbedMission(mission, config);
}

/** Default session resolver: pull from the env-configured sidecar or manual
 *  storageState path/token. Never throws — degrades to undefined (public-only). */
async function defaultResolveSweepSession(
  config: TestbedMissionRunnerConfig,
): Promise<SweepSession | undefined> {
  if (!config.session) return undefined;
  return resolveSweepSession(config.session, {
    readFileImpl: async (path) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(path, "utf8");
    },
  });
}

export async function executePlaywrightTestbedMission(
  mission: TestbedMissionRun,
  config: TestbedMissionRunnerConfig
): Promise<TestbedMissionRunResult> {
  const { chromium } = await import("playwright-core");
  const artifactsDir = join(config.artifactsDir || "/tmp/averray-testbed-mission-artifacts", mission.id);
  await mkdir(artifactsDir, { recursive: true });
  const completedPath: string[] = [];
  const blockers: string[] = [];
  const confusingMoments: string[] = [];
  const evidence: Array<{ type: string; value: string }> = [
    { type: "executor", value: "playwright_browser" },
  ];
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];
  const networkResponses: string[] = [];
  const urlPath: string[] = [];
  const whatITried: string[] = [];
  const screenshotArtifacts: string[] = [];
  const traceArtifacts: string[] = [];
  const videoArtifacts: string[] = [];
  const mutationBoundaryNotes: string[] = [];
  const recommendations: string[] = [];
  const mutationAttempted = false;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let tracePath: string | undefined;
  let traceRunning = false;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(config.browserExecutablePath ? { executablePath: config.browserExecutablePath } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const videoDir = join(artifactsDir, "videos");
    if (config.captureVideo !== false) await mkdir(videoDir, { recursive: true });
    context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      userAgent: "Averray-Hermes-Testbed-Playwright/1.0",
      ...(config.captureVideo !== false ? { recordVideo: { dir: videoDir, size: { width: 1365, height: 900 } } } : {}),
    });
    if (config.captureTrace !== false) {
      tracePath = join(artifactsDir, "trace.zip");
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      traceRunning = true;
    }
    page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => {
      consoleErrors.push(error.message);
    });
    page.on("requestfailed", (request) => {
      networkFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "request failed"}`);
    });
    page.on("response", (response) => {
      const status = response.status();
      if (status >= 400) {
        networkResponses.push(`${status} ${response.request().method()} ${response.url()}`);
      }
    });
    page.on("framenavigated", (frame) => {
      if (frame === page?.mainFrame()) recordUrlStep(urlPath, `navigated ${frame.url()}`);
    });

    whatITried.push(`Opened a clean Chromium context at ${mission.targetUrl}.`);
    updateTestbedMissionProgress(mission.id, {
      path: config.path,
      progressMessage: `Opening ${mission.targetUrl} in a clean Chromium context.`,
    });
    await page.goto(mission.targetUrl, { waitUntil: "domcontentloaded", timeout: Math.min(config.timeoutMs, 45_000) });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    completedPath.push(`opened ${mission.targetUrl}`);

    const firstUrl = page.url();
    recordUrlStep(urlPath, `first screen ${firstUrl}`);
    const title = await page.title().catch(() => "");
    const firstText = await visiblePageText(page);
    evidence.push({ type: "url", value: firstUrl });
    if (title) evidence.push({ type: "title", value: title });
    evidence.push({ type: "visible_text", value: clip(firstText, 900) || "[no visible text detected]" });
    await captureScreenshot(page, artifactsDir, "first-screen.png", evidence, screenshotArtifacts);

    const orientationScore = scoreOrientation(firstText, mission.goal);
    const maxBrowserSteps = config.maxBrowserSteps || 8;
    whatITried.push(`Scanned up to ${maxBrowserSteps} visible controls for a clearly safe next action.`);
    const safeAction = await findFirstSafeAction(page, Boolean(mission.allowTestMutations), maxBrowserSteps);
    if (safeAction) {
      whatITried.push(`Clicked the safe visible control "${safeAction.label}".`);
      updateTestbedMissionProgress(mission.id, {
        path: config.path,
        progressMessage: `Clicking safe visible control: ${safeAction.label}`,
      });
      await safeAction.locator.click({ timeout: 7_000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 7_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      const afterUrl = page.url();
      recordUrlStep(urlPath, `after safe click ${afterUrl}`);
      const afterText = await visiblePageText(page);
      completedPath.push(`clicked safe visible control: ${safeAction.label}`);
      evidence.push({ type: "interaction", value: `clicked "${safeAction.label}"` });
      evidence.push({ type: "url_after_click", value: afterUrl });
      evidence.push({ type: "visible_text_after_click", value: clip(afterText, 900) || "[no visible text detected after click]" });
      await captureScreenshot(page, artifactsDir, "after-safe-click.png", evidence, screenshotArtifacts);
    } else {
      whatITried.push("Stopped before interaction because no clearly safe visible control was found.");
      mutationBoundaryNotes.push("No clearly safe next action was found, so the agent stopped before interacting further.");
      confusingMoments.push("I could load the page, but I did not find a safe obvious visible control to click without risking a real mutation.");
      recommendations.push("Expose one clearly labeled sandbox-safe primary action for outside agents to continue the mission.");
    }

    const riskyControl = await findFirstRiskyAction(page, maxBrowserSteps);
    if (riskyControl) {
      whatITried.push(`Noted mutation boundary at risky control "${riskyControl}" and did not click it.`);
      completedPath.push(`stopped before risky control: ${riskyControl}`);
      mutationBoundaryNotes.push(`Stopped before risky control "${riskyControl}".`);
      evidence.push({ type: "mutation_boundary", value: `stopped before "${riskyControl}"` });
    }
    if (!mutationBoundaryNotes.length) {
      mutationBoundaryNotes.push(mission.allowTestMutations
        ? "No real mutation boundary was crossed; only visibly safe testbed actions were allowed."
        : "No real mutation boundary was crossed; the run stayed browser-visible and read-only.");
    }
    ({ traceRunning } = await finalizePlaywrightArtifacts({
      context,
      page,
      tracePath,
      traceRunning,
      evidence,
      traceArtifacts,
      videoArtifacts,
    }));
    context = undefined;
    appendPlaywrightEvidenceTrail(evidence, {
      whatITried,
      urlPath,
      consoleErrors,
      networkFailures,
      networkResponses,
      screenshotArtifacts,
      traceArtifacts,
      videoArtifacts,
    });
    const manifestPath = await writeEvidenceManifest(artifactsDir, {
      missionId: mission.id,
      targetUrl: mission.targetUrl,
      environment: mission.environment ?? config.missionEnvironment ?? "unknown",
      mutationMode: mission.mutationMode ?? (mission.allowTestMutations ? "testbed_mutation_allowed" : "read_only"),
      mutationScope: mission.mutationScope ?? "none; stop at mutation boundary",
      whatITried,
      urlPath,
      screenshots: screenshotArtifacts,
      traces: traceArtifacts,
      videos: videoArtifacts,
      consoleErrors,
      networkFailures,
      networkResponses,
    });
    evidence.push({ type: "artifact_manifest", value: manifestPath });

    const navigationScore = safeAction ? 4 : 2;
    const taskCompletionScore = safeAction ? 3 : 2;
    const evidenceQuality = evidence.some((entry) => entry.type === "screenshot") ? 5 : 3;
    const verdict = blockers.length ? "fail" : safeAction || orientationScore >= 3 ? "pass" : "partial";
    const report = {
      missionId: mission.id,
      verdict,
      confidence: verdict === "pass" ? 0.78 : 0.52,
      executor: "playwright_browser",
      runnerMode: "real_browser",
      targetUrl: mission.targetUrl,
      goal: mission.goal,
      environment: mission.environment ?? config.missionEnvironment ?? "unknown",
      memoryMode: mission.freshMemory ? "fresh_or_ignored" : "returning_agent_memory_allowed",
      stoppedBeforeMutation: !mutationAttempted,
      completedPath,
      whatITried,
      urlPath,
      blockers,
      confusingMoments,
      mutationBoundaryNotes,
      evidence,
      consoleErrors,
      networkFailures,
      networkResponses,
      artifacts: {
        screenshots: screenshotArtifacts,
        traces: traceArtifacts,
        videos: videoArtifacts,
        manifest: manifestPath,
      },
      scores: {
        orientation: orientationScore,
        navigation: navigationScore,
        taskCompletion: taskCompletionScore,
        trustAndSafety: riskyControl ? 5 : 4,
        recoverability: consoleErrors.length || networkFailures.length || networkResponses.length ? 3 : 4,
        evidenceQuality,
      },
      recommendations,
      mutationMode: mission.mutationMode ?? (mission.allowTestMutations ? "testbed_mutation_allowed" : "read_only"),
      mutationScope: mission.mutationScope ?? "none; stop at mutation boundary",
      mutationBindingReason: mission.mutationBindingReason ?? "mission used legacy mutation binding.",
      mutationsAttempted: mutationAttempted ? ["testbed-only page action"] : [],
    };

    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    return {
      exitCode: 0,
      stdout: `Playwright browser mission completed for ${mission.id}\n`,
      stderr: "",
      reportText,
      summary: `${verdict}: ${completedPath.join(" -> ")}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    whatITried.push(`Runner stopped with error: ${detail}`);
    mutationBoundaryNotes.push("Runner failed before crossing any page mutation boundary.");
    if (page) {
      recordUrlStep(urlPath, `failure screen ${page.url()}`);
      await captureScreenshot(page, artifactsDir, "failure.png", evidence, screenshotArtifacts);
      const failureText = await visiblePageText(page).catch(() => "");
      if (failureText) evidence.push({ type: "visible_text_failure", value: clip(failureText, 900) });
    }
    ({ traceRunning } = await finalizePlaywrightArtifacts({
      context,
      page,
      tracePath,
      traceRunning,
      evidence,
      traceArtifacts,
      videoArtifacts,
    }).catch(async () => ({ traceRunning: false })));
    context = undefined;
    appendPlaywrightEvidenceTrail(evidence, {
      whatITried,
      urlPath,
      consoleErrors,
      networkFailures,
      networkResponses,
      screenshotArtifacts,
      traceArtifacts,
      videoArtifacts,
    });
    const manifestPath = await writeEvidenceManifest(artifactsDir, {
      missionId: mission.id,
      targetUrl: mission.targetUrl,
      environment: mission.environment ?? config.missionEnvironment ?? "unknown",
      mutationMode: mission.mutationMode ?? (mission.allowTestMutations ? "testbed_mutation_allowed" : "read_only"),
      mutationScope: mission.mutationScope ?? "none; stop at mutation boundary",
      error: detail,
      whatITried,
      urlPath,
      screenshots: screenshotArtifacts,
      traces: traceArtifacts,
      videos: videoArtifacts,
      consoleErrors,
      networkFailures,
      networkResponses,
    }).catch(() => undefined);
    if (manifestPath) evidence.push({ type: "artifact_manifest", value: manifestPath });
    const report = {
      missionId: mission.id,
      verdict: "fail",
      confidence: 0,
      executor: "playwright_browser",
      runnerMode: "real_browser",
      targetUrl: mission.targetUrl,
      goal: mission.goal,
      environment: mission.environment ?? config.missionEnvironment ?? "unknown",
      stoppedBeforeMutation: true,
      completedPath,
      whatITried,
      urlPath,
      blockers: [`Playwright browser mission failed: ${detail}`],
      confusingMoments,
      mutationBoundaryNotes,
      evidence: [
        ...evidence,
        { type: "runner_error", value: detail },
      ],
      consoleErrors,
      networkFailures,
      networkResponses,
      artifacts: {
        screenshots: screenshotArtifacts,
        traces: traceArtifacts,
        videos: videoArtifacts,
        ...(manifestPath ? { manifest: manifestPath } : {}),
      },
      scores: {
        orientation: 0,
        navigation: 0,
        taskCompletion: 0,
        trustAndSafety: 5,
        recoverability: 1,
        evidenceQuality: screenshotArtifacts.length ? 3 : evidence.length ? 2 : 1,
      },
      recommendations: ["Inspect runner browser dependencies, target reachability, and page load errors, then rerun the mission."],
      mutationMode: mission.mutationMode ?? (mission.allowTestMutations ? "testbed_mutation_allowed" : "read_only"),
      mutationScope: mission.mutationScope ?? "none; stop at mutation boundary",
      mutationBindingReason: mission.mutationBindingReason ?? "mission used legacy mutation binding.",
      mutationsAttempted: [],
    };
    return {
      exitCode: 0,
      stdout: `Playwright browser mission failed for ${mission.id}: ${detail}\n`,
      stderr: "",
      reportText: `${JSON.stringify(report, null, 2)}\n`,
      summary: detail,
    };
  } finally {
    if (traceRunning && context && tracePath) await context.tracing.stop({ path: tracePath }).catch(() => undefined);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}

export function appendPlaywrightEvidenceTrail(
  evidence: Array<{ type: string; value: string }>,
  trail: {
    whatITried: string[];
    urlPath: string[];
    consoleErrors: string[];
    networkFailures: string[];
    networkResponses: string[];
    screenshotArtifacts: string[];
    traceArtifacts?: string[];
    videoArtifacts?: string[];
  }
): void {
  if (trail.whatITried.length) {
    evidence.push({ type: "what_i_tried", value: clip(trail.whatITried.join("\n"), 1800) });
  }
  if (trail.urlPath.length) {
    evidence.push({ type: "url_path", value: clip(trail.urlPath.join("\n"), 1800) });
  }
  if (trail.consoleErrors.length) {
    evidence.push({ type: "console_errors", value: clip(trail.consoleErrors.join("\n"), 1600) });
  }
  if (trail.networkFailures.length) {
    evidence.push({ type: "network_failures", value: clip(trail.networkFailures.join("\n"), 1600) });
  }
  if (trail.networkResponses.length) {
    evidence.push({ type: "network_responses", value: clip(trail.networkResponses.join("\n"), 1600) });
  }
  if (trail.screenshotArtifacts.length) {
    evidence.push({ type: "screenshots", value: clip(trail.screenshotArtifacts.join("\n"), 1600) });
  }
  if (trail.traceArtifacts?.length) {
    evidence.push({ type: "trace", value: clip(trail.traceArtifacts.join("\n"), 1600) });
  }
  if (trail.videoArtifacts?.length) {
    evidence.push({ type: "video", value: clip(trail.videoArtifacts.join("\n"), 1600) });
  }
}

async function finalizePlaywrightArtifacts(input: {
  context: BrowserContext | undefined;
  page: Page | undefined;
  tracePath: string | undefined;
  traceRunning: boolean;
  evidence: Array<{ type: string; value: string }>;
  traceArtifacts: string[];
  videoArtifacts: string[];
}): Promise<{ traceRunning: boolean }> {
  const video = input.page?.video();
  let traceRunning = input.traceRunning;
  if (input.context && traceRunning && input.tracePath) {
    await input.context.tracing.stop({ path: input.tracePath });
    traceRunning = false;
    input.traceArtifacts.push(input.tracePath);
    input.evidence.push({ type: "trace", value: input.tracePath });
  }
  if (input.context) await input.context.close();
  const videoPath = await video?.path().catch(() => undefined);
  if (videoPath) {
    input.videoArtifacts.push(videoPath);
    input.evidence.push({ type: "video", value: videoPath });
  }
  return { traceRunning };
}

async function captureScreenshot(
  page: Page,
  artifactsDir: string,
  fileName: string,
  evidence: Array<{ type: string; value: string }>,
  screenshotArtifacts: string[]
): Promise<string | undefined> {
  const path = join(artifactsDir, fileName);
  try {
    await page.screenshot({ path, fullPage: false });
    screenshotArtifacts.push(path);
    evidence.push({ type: "screenshot", value: path });
    return path;
  } catch {
    return undefined;
  }
}

async function writeEvidenceManifest(
  artifactsDir: string,
  manifest: Record<string, unknown>
): Promise<string> {
  const path = join(artifactsDir, "evidence-manifest.json");
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return path;
}

function recordUrlStep(urlPath: string[], value: string): void {
  if (urlPath[urlPath.length - 1] !== value) urlPath.push(value);
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
    TESTBED_REQUESTED_TEST_MUTATIONS: String(mission.requestedAllowTestMutations === true),
    TESTBED_MISSION_ENVIRONMENT: mission.environment ?? "",
    TESTBED_MUTATION_MODE: mission.mutationMode ?? (mission.allowTestMutations ? "testbed_mutation_allowed" : "read_only"),
    TESTBED_MUTATION_SCOPE: mission.mutationScope ?? "none; stop at mutation boundary",
    TESTBED_MUTATION_BINDING_REASON: mission.mutationBindingReason ?? "",
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

function parseExecutor(value: string | undefined, command: string | undefined): "playwright" | "command" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "command" || normalized === "external") return "command";
  if (normalized === "playwright" || normalized === "browser" || normalized === "real-browser") return "playwright";
  return command?.trim() ? "command" : "playwright";
}

async function visiblePageText(page: Page): Promise<string> {
  return (await page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""))
    .replace(/\s+/g, " ")
    .trim();
}

async function findFirstSafeAction(
  page: Page,
  allowTestMutations: boolean,
  maxControls: number
): Promise<{ locator: Locator; label: string } | undefined> {
  const controls = page.locator("a[href], button, [role='button'], input[type='submit']");
  const count = Math.min(await controls.count().catch(() => 0), Math.max(1, maxControls));
  for (let index = 0; index < count; index += 1) {
    const locator = controls.nth(index);
    if (!(await locator.isVisible().catch(() => false))) continue;
    const label = await controlLabel(locator);
    if (!label || isRiskyActionLabel(label, allowTestMutations)) continue;
    return { locator, label };
  }
  return undefined;
}

async function findFirstRiskyAction(page: Page, maxControls: number): Promise<string | undefined> {
  const controls = page.locator("a[href], button, [role='button'], input[type='submit']");
  const count = Math.min(await controls.count().catch(() => 0), Math.max(1, maxControls));
  for (let index = 0; index < count; index += 1) {
    const locator = controls.nth(index);
    if (!(await locator.isVisible().catch(() => false))) continue;
    const label = await controlLabel(locator);
    if (label && isRiskyActionLabel(label, false)) return label;
  }
  return undefined;
}

async function controlLabel(locator: Locator): Promise<string> {
  const label = await locator.getAttribute("aria-label").catch(() => null)
    || await locator.getAttribute("value").catch(() => null)
    || await locator.innerText({ timeout: 1_500 }).catch(() => "");
  return label.replace(/\s+/g, " ").trim().slice(0, 120);
}

function isRiskyActionLabel(label: string, allowTestMutations: boolean): boolean {
  const normalized = label.toLowerCase();
  if (allowTestMutations && /\b(test|sandbox|fake|demo|preview|simulate|try)\b/.test(normalized)) return false;
  return /\b(connect wallet|sign|signature|pay|payment|checkout|buy|transfer|stake|mint|deploy|merge|delete|approve|confirm|submit|send)\b/.test(normalized);
}

function scoreOrientation(text: string, goal: string): number {
  const normalized = text.toLowerCase();
  if (!normalized) return 0;
  const goalMatches = goalWords(goal).filter((word) => normalized.includes(word)).length;
  if (goalMatches >= 3) return 5;
  if (goalMatches >= 1) return 4;
  if (normalized.length >= 400) return 3;
  if (normalized.length >= 80) return 2;
  return 1;
}

function goalWords(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4)
    .slice(0, 8);
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
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
