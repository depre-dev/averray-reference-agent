import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTestbedMissionRunsForTests,
  updateTestbedMissionRunnerHeartbeat,
} from "../../services/slack-operator/src/monitor-testbed-missions.js";
import {
  createTestbedMissionFromAgent,
  getTestbedMissionForAgent,
  listTestbedMissionsForAgent,
} from "../../services/slack-operator/src/testbed-agent-entrypoint.js";

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

describe("testbed agent entrypoint", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    __resetTestbedMissionRunsForTests();
    dir = mkdtempSync(join(tmpdir(), "averray-testbed-agent-entrypoint-"));
    path = join(dir, "missions.json");
  });

  afterEach(() => {
    __resetTestbedMissionRunsForTests();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("lets another agent queue a Hermes browser mission", () => {
    updateTestbedMissionRunnerHeartbeat({
      path,
      runnerId: "test-runner",
      status: "idle",
      now: new Date(),
    });

    const result = createTestbedMissionFromAgent(
      {
        path,
        requester: "claude",
        targetUrl: "https://testbed.example/onboarding",
        goal: "try the onboarding flow like a new external agent",
        allowTestMutations: true,
        maxBrowserSteps: 40,
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    expect(result).toMatchObject({
      kind: "hermes_testbed_agent_entrypoint",
      requester: "claude",
      run: {
        status: "ready",
        targetUrl: "https://testbed.example/onboarding",
        goal: "try the onboarding flow like a new external agent",
        allowTestMutations: true,
      },
      runner: {
        runnerId: "test-runner",
        status: "idle",
        stale: false,
      },
    });
    expect(result.nextStep).toContain("Hermes testbed runner can claim this mission");
    expect(String(result.mission.missionPrompt)).toContain("try the onboarding flow");
  });

  it("keeps agent-requested mutations read-only when the target is production", () => {
    const result = createTestbedMissionFromAgent(
      {
        path,
        requester: "claude",
        targetUrl: "https://averray.com",
        goal: "try the main flow",
        allowTestMutations: true,
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    expect(result.run).toMatchObject({
      targetUrl: "https://averray.com",
      requestedAllowTestMutations: true,
      allowTestMutations: false,
      environment: "mainnet",
      mutationMode: "read_only",
    });
    expect(String(result.mission.missionPrompt)).toContain("Mutation profile override: mainnet / read_only");
  });

  it("allows explicit testnet mutation binding for test-mode missions", () => {
    const result = createTestbedMissionFromAgent(
      {
        path,
        requester: "operator",
        targetUrl: "https://example.internal/gold-path",
        environment: "testnet",
        allowTestMutations: true,
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    expect(result.run).toMatchObject({
      allowTestMutations: true,
      environment: "testnet",
      mutationMode: "testbed_mutation_allowed",
      mutationScope: "testbed-only page actions that are visibly fake, sandbox, or non-production",
    });
  });

  it("lists missions and runner state for polling agents", () => {
    createTestbedMissionFromAgent(
      {
        path,
        requester: "codex",
        targetUrl: "https://testbed.example/app",
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    const list = listTestbedMissionsForAgent({ path, limit: 10 });

    expect(list).toMatchObject({
      kind: "hermes_testbed_agent_mission_list",
      counts: {
        total: 1,
        ready: 1,
        running: 0,
        completed: 0,
        failed: 0,
      },
      items: [
        {
          targetUrl: "https://testbed.example/app",
          status: "ready",
        },
      ],
    });
  });

  it("returns one mission with the next useful agent action", () => {
    const created = createTestbedMissionFromAgent(
      {
        path,
        requester: "codex",
        targetUrl: "https://testbed.example/app",
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    const detail = getTestbedMissionForAgent(created.run.id, { path });

    expect(detail).toMatchObject({
      kind: "hermes_testbed_agent_mission",
      run: {
        id: created.run.id,
        status: "ready",
        targetUrl: "https://testbed.example/app",
      },
      mission: {
        kind: "testbed_agent_browser_mission",
      },
    });
    expect(detail?.nextStep).toContain("Mission is ready");
    expect(getTestbedMissionForAgent("missing", { path })).toBeUndefined();
  });
});
