import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright-core";

vi.mock("@avg/averray-mcp/operator-testbed", () => ({
  getTestbedAgentMission: (input: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    kind: "testbed_agent_browser_mission",
    target: {
      url: input.targetUrl ?? "[TESTBED_URL]",
      goal: input.goal ?? "test the page",
      agentName: input.agentName ?? "Hermes",
      freshMemory: input.freshMemory !== false,
      maxBrowserSteps: input.maxBrowserSteps ?? 80,
      maxMinutes: input.maxMinutes ?? 20,
    },
    missionPrompt: `Goal: ${input.goal ?? "test the page"}`,
    safety: {
      browserMissionShouldMutate: input.allowTestMutations === true,
    },
  }),
}));

import {
  __resetTestbedMissionRunsForTests,
  listTestbedMissionRuns,
  recordTestbedMissionRunFromOperatorResult,
  readTestbedMissionRunnerHeartbeat,
} from "../../services/slack-operator/src/monitor-testbed-missions.js";
import { requestTestbedMissionFromAgent } from "../../services/slack-operator/src/testbed-agent-entrypoint.js";
import {
  appendPlaywrightEvidenceTrail,
  createPlaywrightContextPageWithVideoFallback,
  isPlaywrightFfmpegMissing,
  parseTestbedMissionRunnerConfig,
  renderTestbedMissionRunnerArgs,
  runTestbedMissionRunnerOnce,
} from "../../services/slack-operator/src/testbed-mission-runner.js";

describe("testbed mission runner", () => {
  beforeEach(() => {
    delete process.env.AVERRAY_TESTBED_MISSIONS_PATH;
    __resetTestbedMissionRunsForTests();
  });

  it("claims a ready mission and completes it from a structured report", async () => {
    const path = tempMissionStorePath();
    const usagePath = join(path.replace(/missions\.json$/, ""), "llm-usage.jsonl");
    const previousUsagePath = process.env.LLM_USAGE_LOG_PATH;
    process.env.LLM_USAGE_LOG_PATH = usagePath;
    process.env.AVERRAY_TESTBED_MISSIONS_PATH = path;
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-24T10:00:00.000Z"));
    expect(run).toBeDefined();

    let result: Awaited<ReturnType<typeof runTestbedMissionRunnerOnce>>;
    try {
      result = await runTestbedMissionRunnerOnce(
        {
          enabled: true,
          path,
          runnerId: "test-runner",
          command: "fake",
          args: [],
          pollIntervalMs: 1000,
          timeoutMs: 1000,
          outputTailBytes: 4000,
        },
        {
          executor: async (mission) => ({
            exitCode: 0,
            stdout: "mission complete",
            stderr: "",
            reportText: JSON.stringify({
              verdict: "pass",
              confidence: 0.86,
              stoppedBeforeMutation: true,
              mutationBoundaryNotes: ["Stopped before any real mutation boundary."],
              completedPath: ["opened page", "verified first-run onboarding"],
              blockers: [],
              evidence: [{ type: "visible_text", value: "Welcome to the testbed" }],
              scores: { orientation: 5, mutationSafety: 5 },
              missionId: mission.id,
            }),
            usage: {
              model: "browser-agent",
              inputTokens: 50,
              outputTokens: 11,
            },
          }),
        }
      );
    } finally {
      if (previousUsagePath === undefined) delete process.env.LLM_USAGE_LOG_PATH;
      else process.env.LLM_USAGE_LOG_PATH = previousUsagePath;
    }

    expect(result.status).toBe("completed");
    expect(JSON.parse(readFileSync(usagePath, "utf8").trim())).toMatchObject({
      agent: "hermes",
      model: "browser-agent",
      taskId: run!.id,
      runId: run!.id,
      inputTokens: 50,
      outputTokens: 11,
    });
    const [updated] = listTestbedMissionRuns({ path });
    expect(updated).toMatchObject({
      id: run!.id,
      status: "completed",
      runnerId: "test-runner",
      result: {
        verdict: "pass",
        confidence: 0.86,
      },
      history: expect.arrayContaining([
        expect.objectContaining({ event: "mission_runner_claimed", status: "running" }),
        expect.objectContaining({ event: "mission_report_passed", status: "completed" }),
      ]),
    });
    expect(readTestbedMissionRunnerHeartbeat({ path })).toMatchObject({
      runnerId: "test-runner",
      status: "completed",
      activeMissionId: run!.id,
    });
  });

  it("reloads externally-created ready missions before each claim attempt", async () => {
    const path = tempMissionStorePath();
    process.env.AVERRAY_TESTBED_MISSIONS_PATH = path;
    const config = {
      enabled: true,
      path,
      runnerId: "test-runner",
      command: "fake",
      args: [],
      pollIntervalMs: 1000,
      timeoutMs: 1000,
      outputTailBytes: 4000,
    };

    await expect(runTestbedMissionRunnerOnce(config, {
      executor: async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    })).resolves.toMatchObject({ status: "idle" });

    const externalRun = externalReadyMissionRun();
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      kind: "testbed_mission_store",
      missionSeq: 1,
      runs: [externalRun],
    }, null, 2)}\n`);

    const result = await runTestbedMissionRunnerOnce(config, {
      executor: async (mission) => ({
        exitCode: 0,
        stdout: "mission complete",
        stderr: "",
        reportText: JSON.stringify({
          missionId: mission.id,
          verdict: "pass",
          confidence: 0.91,
          stoppedBeforeMutation: true,
          mutationBoundaryNotes: ["Stayed read-only while checking the externally-created mission."],
          completedPath: ["opened externally-created mission"],
          blockers: [],
          evidence: [{ type: "visible_text", value: "Testbed ready" }],
          scores: { orientation: 5, navigation: 5 },
        }),
      }),
    });

    expect(result.status).toBe("completed");
    expect(listTestbedMissionRuns({ path })[0]).toMatchObject({
      id: externalRun.id,
      status: "completed",
      runnerId: "test-runner",
    });
  });

  it("ignores requested missions until the operator approves them", async () => {
    const path = tempMissionStorePath();
    process.env.AVERRAY_TESTBED_MISSIONS_PATH = path;
    requestTestbedMissionFromAgent(
      {
        path,
        requesterAgent: "codex",
        targetUrl: "https://testbed.example/app",
        goal: "check the app like a fresh browser agent",
        reason: "needs independent tester evidence",
        mode: "fresh",
      },
      Date.parse("2026-05-24T10:00:00.000Z")
    );
    const executor = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    const result = await runTestbedMissionRunnerOnce(
      {
        enabled: true,
        path,
        runnerId: "test-runner",
        command: "fake",
        args: [],
        pollIntervalMs: 1000,
        timeoutMs: 1000,
        outputTailBytes: 4000,
      },
      { executor }
    );

    expect(result.status).toBe("idle");
    expect(executor).not.toHaveBeenCalled();
    const [updated] = listTestbedMissionRuns({ path });
    expect(updated).toMatchObject({ status: "requested" });
    expect(updated?.runnerId).toBeUndefined();
  });

  it("auto-posts and preflights an internal testnet gold-path mission before claiming it", async () => {
    const path = tempMissionStorePath();
    const readyJobsPath = join(path.replace(/missions\.json$/, ""), "ready-to-post-jobs.json");
    writeFileSync(readyJobsPath, JSON.stringify([
      {
        id: "hermes-gold-path-smoke",
        category: "coding",
        tier: "starter",
        rewardAsset: "USDC",
        rewardAmount: 2,
        verifierMode: "benchmark",
        verifierTerms: ["complete", "verified", "output"],
        verifierMinimumMatches: 2,
        inputSchemaRef: "schema://jobs/coding-input",
        outputSchemaRef: "schema://jobs/coding-output",
        requiresSponsoredGas: true,
      },
    ]));
    const run = recordTestbedMissionRunFromOperatorResult(goldPathMissionResult(), Date.parse("2026-06-02T08:00:00.000Z"), path);
    const fetchCalls: Array<{ url: string; method: string; body?: string }> = [];
    const executor = vi.fn(async (mission) => ({
      exitCode: 0,
      stdout: "gold path complete",
      stderr: "",
      reportText: JSON.stringify({
        missionId: mission.id,
        verdict: "pass",
        confidence: 0.9,
        stoppedBeforeMutation: false,
        mutationMode: "testbed_mutation_allowed",
        mutationsAttempted: ["claim", "submit", "payout_sbt"],
        mutationBoundaryNotes: ["Testnet-only gold-path loop completed."],
        completedPath: ["posted job", "claimed job", "submitted work", "verified", "settled"],
        blockers: [],
        evidence: [{ type: "receipt", value: "session-123" }],
        scores: { success: 5 },
      }),
    }));

    const result = await runTestbedMissionRunnerOnce(
      {
        enabled: true,
        path,
        runnerId: "test-runner",
        command: "fake",
        args: [],
        pollIntervalMs: 1000,
        timeoutMs: 1000,
        outputTailBytes: 4000,
        apiBaseUrl: "https://api.testnet.example",
        appBaseUrl: "https://app.testnet.example",
        signerBaseUrl: "http://signer.test",
        goldPathAutonomy: {
          enabled: true,
          maxUsdcPerDay: 10,
          maxStakeUsdPerRun: 1,
          maxConcurrentRuns: 1,
          readyJobsPath,
        },
      },
      {
        executor,
        now: new Date("2026-06-02T08:01:00.000Z"),
        goldPathAutonomy: {
          isHaltPresent: () => false,
          isSuspended: () => false,
          resolveSession: async ({ role }) => ({ role, token: `${role}-token` }),
          fetchImpl: async (url, init) => {
            fetchCalls.push({ url: String(url), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
            if (String(url).endsWith("/admin/jobs")) return jsonResponse({ id: "posted" }, 200);
            if (String(url).includes("/jobs/definition")) return jsonResponse({ id: "posted" }, 200);
            return new Response("ok", { status: 200 });
          },
        },
      }
    );

    expect(result.status).toBe("completed");
    expect(executor).toHaveBeenCalledOnce();
    const [updated] = listTestbedMissionRuns({ path });
    expect(updated).toMatchObject({
      id: run!.id,
      status: "completed",
      runnerId: "test-runner",
      goldPathAutonomy: {
        budget: { estimatedRewardUsd: 2, maxUsdcPerDay: 10 },
        job: { templateId: "hermes-gold-path-smoke" },
        preflight: { status: "passed" },
      },
    });
    expect(updated?.goldPathAutonomy?.job?.jobId).toContain("hermes-gold-path-smoke-gp-");
    expect(fetchCalls.map((call) => call.method)).toEqual(["POST", "GET", "GET"]);
    expect(fetchCalls[0]?.url).toBe("https://api.testnet.example/admin/jobs");
    expect(fetchCalls[0]?.body).toContain(updated?.goldPathAutonomy?.job?.jobId ?? "");
  });

  it("aborts a gold-path mission before claim when preflight is red", async () => {
    const path = tempMissionStorePath();
    const readyJobsPath = join(path.replace(/missions\.json$/, ""), "ready-to-post-jobs.json");
    writeFileSync(readyJobsPath, JSON.stringify([readyGoldPathJobTemplate()]));
    const run = recordTestbedMissionRunFromOperatorResult(goldPathMissionResult(), Date.parse("2026-06-02T08:00:00.000Z"), path);
    const executor = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));

    const result = await runTestbedMissionRunnerOnce(
      goldPathRunnerConfig(path, readyJobsPath),
      {
        executor,
        now: new Date("2026-06-02T08:01:00.000Z"),
        goldPathAutonomy: {
          isHaltPresent: () => false,
          isSuspended: () => false,
          resolveSession: async ({ role }) => ({ role, token: `${role}-token` }),
          fetchImpl: async (url) => {
            if (String(url).endsWith("/admin/jobs")) return jsonResponse({ id: "posted" }, 200);
            if (String(url).includes("/jobs/definition")) return jsonResponse({ id: "posted" }, 200);
            return new Response("down", { status: 503 });
          },
        },
      }
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("Gold-path preflight failed"),
    });
    expect(executor).not.toHaveBeenCalled();
    const [updated] = listTestbedMissionRuns({ path });
    expect(updated).toMatchObject({
      id: run!.id,
      status: "failed",
      failureReason: expect.stringContaining("read_only_smoke: HTTP 503"),
    });
    expect(updated?.runnerId).toBeUndefined();
    expect(updated?.claimedAt).toBeUndefined();
  });

  it("blocks a gold-path mission before claim when the daily spend cap would be exceeded", async () => {
    const path = tempMissionStorePath();
    const readyJobsPath = join(path.replace(/missions\.json$/, ""), "ready-to-post-jobs.json");
    writeFileSync(readyJobsPath, JSON.stringify([readyGoldPathJobTemplate({ rewardAmount: 2 })]));
    const run = recordTestbedMissionRunFromOperatorResult(goldPathMissionResult(), Date.parse("2026-06-02T08:00:00.000Z"), path);
    const executor = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));

    const result = await runTestbedMissionRunnerOnce(
      {
        ...goldPathRunnerConfig(path, readyJobsPath),
        goldPathAutonomy: {
          enabled: true,
          maxUsdcPerDay: 1,
          maxStakeUsdPerRun: 1,
          maxConcurrentRuns: 1,
          readyJobsPath,
        },
      },
      {
        executor,
        now: new Date("2026-06-02T08:01:00.000Z"),
        goldPathAutonomy: {
          isHaltPresent: () => false,
          isSuspended: () => false,
        },
      }
    );

    expect(result).toMatchObject({
      status: "failed",
      reason: expect.stringContaining("daily USDC cap"),
    });
    expect(executor).not.toHaveBeenCalled();
    const [updated] = listTestbedMissionRuns({ path });
    expect(updated).toMatchObject({ id: run!.id, status: "failed" });
    expect(updated?.runnerId).toBeUndefined();
  });

  it("fails the mission when the runner output is not a valid report", async () => {
    const path = tempMissionStorePath();
    process.env.AVERRAY_TESTBED_MISSIONS_PATH = path;
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-24T10:00:00.000Z"));

    const result = await runTestbedMissionRunnerOnce(
      {
        enabled: true,
        path,
        runnerId: "test-runner",
        command: "fake",
        args: [],
        pollIntervalMs: 1000,
        timeoutMs: 1000,
        outputTailBytes: 200,
      },
      {
        executor: async () => ({
          exitCode: 0,
          stdout: "I opened the page but forgot to output JSON.",
          stderr: "",
        }),
      }
    );

    expect(result.status).toBe("failed");
    const [updated] = listTestbedMissionRuns({ path });
    expect(updated).toMatchObject({
      id: run!.id,
      status: "failed",
      failureReason: "Hermes testbed runner finished, but the output did not contain a valid structured mission report.",
      result: {
        verdict: "fail",
      },
    });
  });

  it("reports misconfigured instead of claiming a mission without a command", async () => {
    const path = tempMissionStorePath();
    process.env.AVERRAY_TESTBED_MISSIONS_PATH = path;
    recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-24T10:00:00.000Z"));

    const result = await runTestbedMissionRunnerOnce({
      enabled: true,
      path,
      runnerId: "test-runner",
      executor: "command",
      args: [],
      pollIntervalMs: 1000,
      timeoutMs: 1000,
      outputTailBytes: 200,
    });

    expect(result).toMatchObject({
      status: "misconfigured",
    });
    expect(listTestbedMissionRuns({ path })[0]).toMatchObject({
      status: "ready",
    });
  });

  it("renders command arguments with mission placeholders", () => {
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-24T10:00:00.000Z"));
    const args = renderTestbedMissionRunnerArgs(
      ["run", "{missionId}", "{targetUrl}", "{reportPath}", "{prompt}"],
      run!,
      "/tmp/report.json"
    );

    expect(args[0]).toBe("run");
    expect(args[1]).toBe(run!.id);
    expect(args[2]).toBe("https://testbed.example/app");
    expect(args[3]).toBe("/tmp/report.json");
    expect(args[4]).toContain("Open the app and complete onboarding.");
  });

  it("parses opt-in runner env", () => {
    const config = parseTestbedMissionRunnerConfig({
      TESTBED_MISSION_RUNNER_ENABLED: "1",
      TESTBED_MISSION_RUNNER_ID: "runner-a",
      TESTBED_MISSION_RUNNER_COMMAND: "hermes",
      TESTBED_MISSION_RUNNER_ARGS: "[\"run\",\"{prompt}\"]",
      TESTBED_MISSION_RUNNER_POLL_INTERVAL_MS: "500",
      TESTBED_MISSION_ENVIRONMENT: "testnet",
      TESTBED_MISSION_CAPTURE_TRACE: "0",
      TESTBED_MISSION_CAPTURE_VIDEO: "false",
    });

    expect(config).toMatchObject({
      enabled: true,
      runnerId: "runner-a",
      executor: "command",
      command: "hermes",
      args: ["run", "{prompt}"],
      pollIntervalMs: 500,
      missionEnvironment: "testnet",
      captureTrace: false,
      captureVideo: false,
    });
  });

  it("defaults to the built-in Playwright browser executor", () => {
    const config = parseTestbedMissionRunnerConfig({
      TESTBED_MISSION_RUNNER_ENABLED: "1",
    });

    expect(config).toMatchObject({
      enabled: true,
      executor: "playwright",
      artifactsDir: "/data/testbed-mission-artifacts",
    });
  });

  it("summarizes Playwright evidence trails for monitor review", () => {
    const evidence: Array<{ type: string; value: string }> = [];

    appendPlaywrightEvidenceTrail(evidence, {
      whatITried: ["opened the target", "clicked the safe sandbox action"],
      urlPath: ["first screen https://example.test/", "after safe click https://example.test/next"],
      consoleErrors: ["ReferenceError: demo is not defined"],
      networkFailures: ["GET https://example.test/api :: net::ERR_FAILED"],
      networkResponses: ["500 GET https://example.test/api/status"],
      screenshotArtifacts: ["/tmp/first-screen.png", "/tmp/after-safe-click.png"],
      traceArtifacts: ["/tmp/trace.zip"],
      videoArtifacts: ["/tmp/video.webm"],
    });

    expect(evidence).toEqual([
      expect.objectContaining({ type: "what_i_tried", value: expect.stringContaining("opened the target") }),
      expect.objectContaining({ type: "url_path", value: expect.stringContaining("after safe click") }),
      expect.objectContaining({ type: "console_errors", value: expect.stringContaining("ReferenceError") }),
      expect.objectContaining({ type: "network_failures", value: expect.stringContaining("ERR_FAILED") }),
      expect.objectContaining({ type: "network_responses", value: expect.stringContaining("500 GET") }),
      expect.objectContaining({ type: "screenshots", value: expect.stringContaining("first-screen.png") }),
      expect.objectContaining({ type: "trace", value: expect.stringContaining("trace.zip") }),
      expect.objectContaining({ type: "video", value: expect.stringContaining("video.webm") }),
    ]);
  });

  it("retries without video when Playwright ffmpeg is missing", async () => {
    const page = {} as Page;
    const videoContext = {
      newPage: vi.fn(async () => {
        throw new Error("Executable doesn't exist at /home/appuser/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux. Video rendering requires ffmpeg binary.");
      }),
      close: vi.fn(async () => undefined),
    } as unknown as BrowserContext;
    const fallbackContext = {
      newPage: vi.fn(async () => page),
    } as unknown as BrowserContext;
    const contexts = [videoContext, fallbackContext];
    const newContext = vi.fn(async () => contexts.shift() ?? fallbackContext);
    const browser = { newContext } as unknown as Browser;

    const result = await createPlaywrightContextPageWithVideoFallback({
      browser,
      captureVideo: true,
      videoDir: join(mkdtempSync(join(tmpdir(), "averray-testbed-video-")), "videos"),
      contextOptions: {
        viewport: { width: 1365, height: 900 },
        userAgent: "Averray-Hermes-Testbed-Playwright/1.0",
        extraHTTPHeaders: { "CF-Access-Client-Id": "cf-client-id" },
        httpCredentials: { username: "operator", password: "secret", origin: "https://app.averray.com" },
      },
    });

    expect(result).toMatchObject({
      context: fallbackContext,
      page,
      videoDisabledReason: expect.stringContaining("ffmpeg"),
    });
    expect(videoContext.close).toHaveBeenCalledOnce();
    expect(newContext).toHaveBeenCalledTimes(2);
    expect(newContext.mock.calls[0]?.[0]).toMatchObject({
      extraHTTPHeaders: { "CF-Access-Client-Id": "cf-client-id" },
      httpCredentials: { username: "operator", password: "secret", origin: "https://app.averray.com" },
      recordVideo: { size: { width: 1365, height: 900 } },
    });
    expect(newContext.mock.calls[1]?.[0]).toMatchObject({
      extraHTTPHeaders: { "CF-Access-Client-Id": "cf-client-id" },
      httpCredentials: { username: "operator", password: "secret", origin: "https://app.averray.com" },
    });
    expect(newContext.mock.calls[1]?.[0]).not.toHaveProperty("recordVideo");
  });

  it("passes Basic Auth credentials to a non-video browser context", async () => {
    const page = {} as Page;
    const context = {
      newPage: vi.fn(async () => page),
    } as unknown as BrowserContext;
    const newContext = vi.fn(async () => context);
    const browser = { newContext } as unknown as Browser;

    await createPlaywrightContextPageWithVideoFallback({
      browser,
      captureVideo: false,
      videoDir: join(mkdtempSync(join(tmpdir(), "averray-testbed-video-")), "videos"),
      contextOptions: {
        viewport: { width: 1365, height: 900 },
        userAgent: "Averray-Hermes-Testbed-Playwright/1.0",
        httpCredentials: { username: "operator", password: "secret", origin: "https://app.averray.com" },
      },
    });

    expect(newContext).toHaveBeenCalledWith(expect.objectContaining({
      httpCredentials: { username: "operator", password: "secret", origin: "https://app.averray.com" },
    }));
  });

  it("recognizes Playwright ffmpeg-missing errors", () => {
    expect(isPlaywrightFfmpegMissing(new Error("Video rendering requires ffmpeg binary"))).toBe(true);
    expect(isPlaywrightFfmpegMissing(new Error("net::ERR_NAME_NOT_RESOLVED"))).toBe(false);
  });
});

function tempMissionStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "averray-testbed-runner-test-")), "missions.json");
}

function missionResult() {
  return {
    kind: "testbed_agent_mission",
    mission: {
      kind: "testbed_agent_browser_mission",
      target: {
        url: "https://testbed.example/app",
        goal: "complete onboarding",
        agentName: "Hermes",
        freshMemory: true,
      },
      missionPrompt: "Open the app and complete onboarding.",
      reportSchema: {
        verdict: "pass | partial | fail",
      },
      safety: {
        missionGeneratorMutates: false,
        browserMissionShouldMutate: false,
      },
    },
  };
}

function goldPathMissionResult() {
  return {
    kind: "testbed_agent_mission",
    mission: {
      kind: "testbed_agent_browser_mission",
      target: {
        url: "https://app.testnet.example/gold-path",
        goal: "complete the gold path",
        agentName: "Hermes",
        freshMemory: true,
        mode: "gold_path",
        environment: "testnet",
      },
      missionPrompt: "Complete the sponsored testnet gold path.",
      reportSchema: {
        verdict: "pass | partial | fail",
      },
      safety: {
        missionGeneratorMutates: false,
        browserMissionShouldMutate: true,
        requestedBrowserMissionShouldMutate: true,
        mutationEnvironment: "testnet",
      },
    },
  };
}

function readyGoldPathJobTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: "hermes-gold-path-smoke",
    category: "coding",
    tier: "starter",
    rewardAsset: "USDC",
    rewardAmount: 2,
    verifierMode: "benchmark",
    verifierTerms: ["complete", "verified", "output"],
    verifierMinimumMatches: 2,
    inputSchemaRef: "schema://jobs/coding-input",
    outputSchemaRef: "schema://jobs/coding-output",
    requiresSponsoredGas: true,
    ...overrides,
  };
}

function goldPathRunnerConfig(path: string, readyJobsPath: string) {
  return {
    enabled: true,
    path,
    runnerId: "test-runner",
    command: "fake",
    args: [],
    pollIntervalMs: 1000,
    timeoutMs: 1000,
    outputTailBytes: 4000,
    apiBaseUrl: "https://api.testnet.example",
    appBaseUrl: "https://app.testnet.example",
    signerBaseUrl: "http://signer.test",
    goldPathAutonomy: {
      enabled: true,
      maxUsdcPerDay: 10,
      maxStakeUsdPerRun: 1,
      maxConcurrentRuns: 1,
      readyJobsPath,
    },
  };
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function externalReadyMissionRun() {
  const createdAt = "2026-05-24T10:05:00.000Z";
  return {
    schemaVersion: 1,
    kind: "testbed_mission_run",
    id: "testbed-mission-external-1",
    status: "ready",
    title: "Fresh-agent browser mission",
    targetUrl: "https://testbed.example/app",
    goal: "complete onboarding",
    agentName: "Hermes",
    freshMemory: true,
    allowTestMutations: false,
    mission: missionResult().mission,
    history: [
      {
        at: createdAt,
        status: "ready",
        event: "mission_packet_ready",
        message: "Mission packet generated by another process.",
      },
    ],
    createdAt,
    updatedAt: createdAt,
    statusReason: "Mission packet is ready.",
  };
}
