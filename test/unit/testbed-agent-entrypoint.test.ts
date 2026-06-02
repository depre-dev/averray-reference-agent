import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTestbedMissionRunsForTests,
  acceptTestbedMissionFailure,
  recordTestbedMissionReportFromMessage,
  recordTestbedMissionIssueOpened,
  updateTestbedMissionRunnerHeartbeat,
} from "../../services/slack-operator/src/monitor-testbed-missions.js";
import {
  createTestbedMissionFromAgent,
  createMonitorTestbedMissionFromPayload,
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

  it("ignores client mutation flags on monitor mission posts", () => {
    const result = createMonitorTestbedMissionFromPayload(
      {
        path,
        targetUrl: "https://app.averray.com",
        mode: "surface_sweep",
        initialStatus: "ready",
        freshMemory: true,
        allowTestMutations: true,
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    expect(result.run).toMatchObject({
      targetUrl: "https://app.averray.com/",
      mode: "surface_sweep",
      status: "ready",
      requestedAllowTestMutations: false,
      allowTestMutations: false,
      environment: "mainnet",
      mutationMode: "read_only",
      mutationBindingReason: "surface_sweep missions are read-only by contract.",
    });
  });

  it("derives testnet gold-path mutation posture from mode and target, not a client flag", () => {
    const result = createMonitorTestbedMissionFromPayload(
      {
        path,
        targetUrl: "https://testnet.averray.example/gold-path",
        mode: "gold_path",
        initialStatus: "ready",
        freshMemory: true,
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    expect(result.run).toMatchObject({
      targetUrl: "https://testnet.averray.example/gold-path",
      mode: "gold_path",
      status: "ready",
      requestedAllowTestMutations: true,
      allowTestMutations: true,
      environment: "testnet",
      mutationMode: "testbed_mutation_allowed",
    });
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

  it("returns a requester-safe status envelope before mission completion", () => {
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
      kind: "hermes_testbed_agent_mission_report",
      id: created.run.id,
      status: "ready",
    });
    expect(detail).not.toHaveProperty("report");
    expect(detail).not.toHaveProperty("run");
    expect(detail).not.toHaveProperty("mission");
    expect(detail).not.toHaveProperty("result");
    expect(detail).not.toHaveProperty("targetUrl");
    expect(detail).not.toHaveProperty("goal");
    expect(detail?.nextStep).toContain("Mission is ready");
    expect(getTestbedMissionForAgent("missing", { path })).toBeUndefined();
  });

  it("returns the requester MissionBody report after completion", () => {
    const created = createTestbedMissionFromAgent(
      {
        path,
        requester: "codex",
        targetUrl: "https://testbed.example/app",
        goal: "verify the app is understandable to a fresh tester",
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    recordTestbedMissionReportFromMessage(
      {
        path,
        relatedCorrelationId: created.run.id,
        text: JSON.stringify({
          verdict: "pass",
          confidence: 0.91,
          stoppedBeforeMutation: true,
          summary: "pass: the fresh tester completed the happy path",
          completedPath: [
            { desc: "Opened the app shell", status: "ok" },
            { desc: "Followed the primary CTA", status: "ok" },
          ],
          blockers: [],
          confusingMoments: [],
          evidence: [
            "what_i_tried: opened the page and followed the primary path",
            "screenshot: https://example.test/screen.png",
            "console: no errors",
          ],
          mutationBoundaryNotes: ["No mutation was attempted."],
          recommendations: ["Keep the sandbox label visible."],
          scores: { orientation: 5, trustBoundary: 4 },
        }),
      },
      Date.parse("2026-05-25T10:07:00.000Z")
    );

    const detail = getTestbedMissionForAgent(created.run.id, { path });

    expect(detail).toMatchObject({
      kind: "hermes_testbed_agent_mission_report",
      id: created.run.id,
      status: "completed",
      completedAt: "2026-05-25T10:07:00.000Z",
      report: {
        verdict: "OK",
        verdictTone: "ok",
        confidence: 0.91,
        target: "https://testbed.example/app",
        goal: "verify the app is understandable to a fresh tester",
        narrative: "opened the page and followed the primary path",
        conclusion: "OK — the fresh tester completed the happy path",
        seed: "fresh · no memory",
        path: [
          { n: 1, status: "ok", desc: "Opened the app shell" },
          { n: 2, status: "ok", desc: "Followed the primary CTA" },
        ],
        blockers: [],
        evidence: [
          { kind: "screenshot", label: "https://example.test/screen.png", href: "https://example.test/screen.png" },
          { kind: "console", label: "no errors", href: "#" },
        ],
        mutationBoundary: "Read-only mission — the agent stopped before any mutation. No mutation was attempted.",
        recommendations: ["Keep the sandbox label visible."],
      },
    });
    expect(detail?.report?.scores).toEqual([
      { label: "Orientation", value: 10 },
      { label: "Trust Boundary", value: 8 },
    ]);
  });

  it("does not leak operator-private mission fields to requesters", () => {
    const created = createTestbedMissionFromAgent(
      {
        path,
        requester: "claude",
        targetUrl: "https://testbed.example/app",
        goal: "find the confusing part of the app",
      },
      Date.parse("2026-05-25T10:01:00.000Z")
    );

    recordTestbedMissionReportFromMessage(
      {
        path,
        relatedCorrelationId: created.run.id,
        text: JSON.stringify({
          verdict: "fail",
          confidence: 0.8,
          stoppedBeforeMutation: true,
          completedPath: ["Opened the app"],
          blockers: ["The tester could not find the next action."],
          evidence: ["trace: https://example.test/trace.zip"],
          mutationBoundaryNotes: ["No mutation was attempted."],
          recommendations: ["Clarify the primary next action."],
          scores: { completion: 1 },
        }),
      },
      Date.parse("2026-05-25T10:07:00.000Z")
    );
    acceptTestbedMissionFailure(created.run.id, {
      path,
      acceptedBy: "operator",
      now: new Date("2026-05-25T10:08:00.000Z"),
    });
    recordTestbedMissionIssueOpened(created.run.id, {
      path,
      issueUrl: "https://github.com/depre-dev/averray-reference-agent/issues/999",
      issueNumber: 999,
      openedBy: "operator",
    });

    const detail = getTestbedMissionForAgent(created.run.id, { path });
    const serialized = JSON.stringify(detail);

    expect(detail).not.toHaveProperty("run");
    expect(detail).not.toHaveProperty("mission");
    expect(detail).not.toHaveProperty("result");
    expect(serialized).not.toContain("operatorAccepted");
    expect(serialized).not.toContain("operatorIssue");
    expect(serialized).not.toContain("missionPrompt");
    expect(serialized).not.toContain("issues/999");
    expect(detail).toMatchObject({
      status: "failed",
      report: {
        verdict: "FAILED",
        blockers: [{ head: "The tester could not find the next action." }],
      },
    });
  });
});
