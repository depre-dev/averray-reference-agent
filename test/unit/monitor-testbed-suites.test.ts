import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTestbedSuitesForTests,
  appendTestbedSuiteRun,
  approveRequestedTestbedSuite,
  createTestbedSuite,
  dismissRequestedTestbedSuite,
  listTestbedSuites,
  requestTestbedSuite,
} from "../../services/slack-operator/src/monitor-testbed-suites.js";
import {
  __resetTestbedMissionRunsForTests,
  listTestbedMissionRuns,
  recordTestbedMissionReportFromMessage,
} from "../../services/slack-operator/src/monitor-testbed-missions.js";
import { createMonitorTestbedMissionFromPayload } from "../../services/slack-operator/src/testbed-agent-entrypoint.js";

vi.mock("@avg/averray-mcp/operator-testbed", () => ({
  getTestbedAgentMission: (input: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    kind: "testbed_agent_browser_mission",
    target: {
      url: input.targetUrl ?? "[TESTBED_URL]",
      goal: input.goal ?? "test the page",
      agentName: input.agentName ?? "Hermes",
      freshMemory: input.freshMemory !== false,
    },
    missionPrompt: `Goal: ${input.goal ?? "test the page"}`,
    safety: {
      browserMissionShouldMutate: input.allowTestMutations === true,
    },
  }),
}));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "averray-testbed-suites-"));
  __resetTestbedMissionRunsForTests();
  __resetTestbedSuitesForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __resetTestbedMissionRunsForTests();
  __resetTestbedSuitesForTests();
});

describe("monitor testbed suites", () => {
  it("persists named suites and reloads them from the durable store", () => {
    const path = join(dir, "suites.json");
    const suite = createTestbedSuite(
      {
        name: "Daily surface sweep",
        target: "https://app.averray.com",
        mode: "surface_sweep",
        author: "operator",
      },
      { path, now: new Date("2026-06-02T08:00:00.000Z") },
    );

    __resetTestbedSuitesForTests();

    expect(listTestbedSuites({ path }).suites).toEqual([suite]);
  });

  it("preserves role metadata but never stores or honors raw mutation flags from saved suites", () => {
    const path = join(dir, "suites.json");
    const suite = createTestbedSuite(
      {
        name: "Production gold path",
        target: "https://app.averray.com",
        mode: "gold_path",
        goal: "Exercise the signed-in loop only if the server allows it.",
        role: "agent",
        author: "operator",
        allowTestMutations: true,
      } as Parameters<typeof createTestbedSuite>[0] & { allowTestMutations: boolean },
      { path, now: new Date("2026-06-02T08:00:00.000Z") },
    );

    expect(suite).toMatchObject({
      role: "agent",
      target: "https://app.averray.com/",
      mode: "gold_path",
    });
    expect(suite).not.toHaveProperty("allowTestMutations");
    expect(JSON.stringify(listTestbedSuites({ path }))).not.toContain("allowTestMutations");

    const created = createMonitorTestbedMissionFromPayload(
      {
        path: join(dir, "missions.json"),
        targetUrl: suite.target,
        mode: suite.mode,
        goal: suite.goal,
        initialStatus: "ready",
        freshMemory: true,
        allowTestMutations: true,
      },
      Date.parse("2026-06-02T08:05:00.000Z"),
    );

    expect(created.run).toMatchObject({
      targetUrl: "https://app.averray.com/",
      mode: "gold_path",
      requestedAllowTestMutations: true,
      allowTestMutations: false,
      environment: "mainnet",
      mutationMode: "read_only",
    });
  });

  it("appends each run to suite history with the mission verdict", () => {
    const path = join(dir, "suites.json");
    const suite = createTestbedSuite(
      {
        name: "Gold-path smoke",
        target: "https://app.testnet.averray.com",
        mode: "gold_path",
        goal: "Prove the testnet worker loop.",
        author: "predefined",
      },
      { path, now: new Date("2026-06-02T08:00:00.000Z") },
    );
    const { run } = createMonitorTestbedMissionFromPayload({
      targetUrl: suite.target,
      mode: suite.mode,
      goal: suite.goal,
    }, Date.parse("2026-06-02T08:05:00.000Z"));

    const updated = appendTestbedSuiteRun(suite.id, run, {
      path,
      now: new Date("2026-06-02T08:06:00.000Z"),
    });

    expect(updated?.history).toEqual([{
      runId: run.id,
      verdict: "ready",
      ts: "2026-06-02T08:05:00.000Z",
    }]);
    expect(listTestbedSuites({ path }).suites[0]?.lastRun).toEqual({
      runId: run.id,
      verdict: "ready",
      ts: "2026-06-02T08:05:00.000Z",
    });
  });

  it("refreshes the last-run verdict from the completed mission report", () => {
    const path = join(dir, "suites.json");
    const missionPath = join(dir, "missions.json");
    const suite = createTestbedSuite(
      {
        name: "Daily surface sweep",
        target: "https://app.averray.com",
        mode: "surface_sweep",
        author: "operator",
      },
      { path, now: new Date("2026-06-02T08:00:00.000Z") },
    );
    const { run } = createMonitorTestbedMissionFromPayload({
      path: missionPath,
      targetUrl: suite.target,
      mode: suite.mode,
    }, Date.parse("2026-06-02T08:05:00.000Z"));
    appendTestbedSuiteRun(suite.id, run, {
      path,
      now: new Date("2026-06-02T08:06:00.000Z"),
    });

    recordTestbedMissionReportFromMessage(
      {
        path: missionPath,
        relatedCorrelationId: run.id,
        text: JSON.stringify({
          verdict: "fail",
          confidence: 0.9,
          stoppedBeforeMutation: true,
          summary: "fail: the primary button was hidden",
          completedPath: [
            { desc: "Opened the target", status: "ok" },
            { desc: "Looked for the primary action", status: "blocked" },
          ],
          blockers: ["primary button was hidden"],
          confusingMoments: ["primary action was not visible above the fold"],
          evidence: ["what_i_tried: opened the target and inspected the primary path"],
          scores: { orientation: 2, trustBoundary: 5 },
          mutationBoundaryNotes: ["No mutation was attempted."],
          recommendations: ["Move the primary action into the first viewport."],
        }),
      },
      Date.parse("2026-06-02T08:09:00.000Z"),
    );

    expect(listTestbedSuites({ path, missionRuns: listTestbedMissionRuns({ path: missionPath }) }).suites[0]?.lastRun).toEqual({
      runId: run.id,
      verdict: "fail",
      ts: "2026-06-02T08:09:00.000Z",
    });
  });

  it("parks test-writer suite proposals as requested until the operator approves", () => {
    const path = join(dir, "suites.json");
    const requested = requestTestbedSuite(
      {
        name: "Settings coverage gap",
        target: "https://app.averray.com/settings",
        mode: "surface_sweep",
        goal: "Check settings affordances after the profile PR.",
        author: "test-writer",
        requesterAgent: "test-writer",
        reason: "Changed surface has no saved regression suite.",
      },
      { path, now: new Date("2026-06-02T09:00:00.000Z") },
    );

    expect(requested).toMatchObject({
      status: "requested",
      author: "test-writer",
      requesterAgent: "test-writer",
      requestReason: "Changed surface has no saved regression suite.",
      requestedAt: "2026-06-02T09:00:00.000Z",
      history: [],
    });

    const approved = approveRequestedTestbedSuite(requested.id, {
      path,
      approvedBy: "operator",
      now: new Date("2026-06-02T09:05:00.000Z"),
    });

    expect(approved).toMatchObject({
      ok: true,
      suite: {
        id: requested.id,
        status: "saved",
        approvedAt: "2026-06-02T09:05:00.000Z",
        approvedBy: "operator",
        history: [],
      },
    });
    expect(listTestbedSuites({ path }).suites[0]).toMatchObject({ id: requested.id, status: "saved" });
  });

  it("parks platform-agent suite requests and lets the operator dismiss them without saving", () => {
    const path = join(dir, "suites.json");
    const requested = requestTestbedSuite(
      {
        name: "Feature smoke",
        target: "https://app.averray.com/new-feature",
        mode: "siwe_auth",
        goal: "Verify role-gated feature entry.",
        author: "platform",
        requesterAgent: "codex",
        reason: "Product repo agent requested reusable coverage.",
      },
      { path, now: new Date("2026-06-02T09:00:00.000Z") },
    );

    const dismissed = dismissRequestedTestbedSuite(requested.id, {
      path,
      now: new Date("2026-06-02T09:03:00.000Z"),
    });

    expect(dismissed).toMatchObject({
      ok: true,
      suite: {
        id: requested.id,
        status: "requested",
        author: "platform",
        requesterAgent: "codex",
      },
    });
    expect(listTestbedSuites({ path }).suites).toEqual([]);
  });
});
