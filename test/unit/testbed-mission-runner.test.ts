import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetTestbedMissionRunsForTests,
  listTestbedMissionRuns,
  recordTestbedMissionRunFromOperatorResult,
  readTestbedMissionRunnerHeartbeat,
} from "../../services/slack-operator/src/monitor-testbed-missions.js";
import {
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
    process.env.AVERRAY_TESTBED_MISSIONS_PATH = path;
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-24T10:00:00.000Z"));
    expect(run).toBeDefined();

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
      {
        executor: async (mission) => ({
          exitCode: 0,
          stdout: "mission complete",
          stderr: "",
          reportText: JSON.stringify({
            verdict: "pass",
            confidence: 0.86,
            stoppedBeforeMutation: true,
            completedPath: ["opened page", "verified first-run onboarding"],
            blockers: [],
            evidence: [{ type: "visible_text", value: "Welcome to the testbed" }],
            scores: { orientation: 5, mutationSafety: 5 },
            missionId: mission.id,
          }),
        }),
      }
    );

    expect(result.status).toBe("completed");
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
    });

    expect(config).toMatchObject({
      enabled: true,
      runnerId: "runner-a",
      command: "hermes",
      args: ["run", "{prompt}"],
      pollIntervalMs: 500,
    });
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
