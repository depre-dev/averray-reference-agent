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
  requestTestbedMissionFromAgent,
  approveRequestedTestbedMission,
  TestbedMissionRequestValidationError,
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

  it("lets an agent request a board-gated tester run without making it claimable", () => {
    const result = requestTestbedMissionFromAgent(
      {
        path,
        requesterAgent: "codex",
        targetUrl: "https://testbed.example/onboarding",
        goal: "check whether the onboarding page is understandable to a fresh browser agent",
        reason: "Codex changed onboarding copy and wants independent browser evidence.",
        mode: "fresh",
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    expect(result).toMatchObject({
      kind: "hermes_testbed_agent_entrypoint",
      requester: "codex",
      run: {
        status: "requested",
        title: "Tester run requested",
        requesterAgent: "codex",
        requestReason: "Codex changed onboarding copy and wants independent browser evidence.",
        targetUrl: "https://testbed.example/onboarding",
        goal: "check whether the onboarding page is understandable to a fresh browser agent",
        freshMemory: true,
        allowTestMutations: false,
      },
    });
    expect(result.nextStep).toContain("board-gated");

    const list = listTestbedMissionsForAgent({ path, limit: 10 });
    expect(list.counts).toMatchObject({
      requested: 1,
      ready: 0,
      running: 0,
    });
  });

  it("rejects invalid requested tester run URLs and missing goals", () => {
    expect(() => requestTestbedMissionFromAgent({
      path,
      requesterAgent: "codex",
      targetUrl: "not-a-url",
      goal: "check onboarding",
      reason: "needs browser proof",
      mode: "fresh",
    })).toThrow(TestbedMissionRequestValidationError);

    try {
      requestTestbedMissionFromAgent({
        path,
        requesterAgent: "codex",
        targetUrl: "https://testbed.example/onboarding",
        reason: "needs browser proof",
        mode: "fresh",
      });
      throw new Error("expected missing goal rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TestbedMissionRequestValidationError);
      expect((error as TestbedMissionRequestValidationError).code).toBe("missing_goal");
    }
  });

  it("approves a requested tester run into the existing ready mission flow", () => {
    const created = requestTestbedMissionFromAgent(
      {
        path,
        requesterAgent: "claude",
        targetUrl: "https://testbed.example/onboarding",
        goal: "check onboarding",
        reason: "verify the changed page",
        mode: "memory",
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    const approved = approveRequestedTestbedMission(created.run.id, {
      path,
      approvedBy: "operator",
      now: new Date("2026-05-25T10:03:00.000Z"),
    });

    expect(approved).toMatchObject({
      ok: true,
      run: {
        id: created.run.id,
        status: "ready",
        title: "Fresh-agent browser mission",
        freshMemory: false,
        approvedAt: "2026-05-25T10:03:00.000Z",
        approvedBy: "operator",
      },
    });
    expect(listTestbedMissionsForAgent({ path, limit: 10 }).counts).toMatchObject({
      requested: 0,
      ready: 1,
    });
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

  it("creates operator-scheduled gold-path missions as ready so the budget gate, not a per-run approval, governs them", () => {
    const result = createTestbedMissionFromAgent(
      {
        path,
        requester: "operator",
        targetUrl: "https://app.testnet.example/gold-path",
        goal: "run the autonomous gold path",
        mode: "gold_path",
        environment: "testnet",
        allowTestMutations: true,
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    expect(result.run).toMatchObject({
      status: "ready",
      mode: "gold_path",
      allowTestMutations: true,
    });
    expect(result.run.requestedAt).toBeUndefined();
    expect(result.nextStep).not.toContain("board-gated");
  });

  it("still supports an explicit approval gate for external request paths", () => {
    const result = createTestbedMissionFromAgent(
      {
        path,
        requester: "codex",
        targetUrl: "https://app.testnet.example/gold-path",
        goal: "operator must approve this one",
        mode: "gold_path",
        environment: "testnet",
        allowTestMutations: true,
        requireApproval: true,
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    expect(result.run).toMatchObject({
      status: "requested",
      mode: "gold_path",
      allowTestMutations: true,
    });
    expect(result.nextStep).toContain("board-gated");
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
        requested: 0,
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
