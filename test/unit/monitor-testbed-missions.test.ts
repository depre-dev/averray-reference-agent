import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetTestbedMissionRunsForTests,
  listTestbedMissionRuns,
  recordTestbedMissionReportFromMessage,
  recordTestbedMissionRunFromOperatorResult,
  testbedMissionRunToMonitorItem,
} from "../../services/slack-operator/src/monitor-testbed-missions.js";

describe("monitor testbed mission runs", () => {
  beforeEach(() => {
    __resetTestbedMissionRunsForTests();
  });

  it("records a browser mission packet as a monitor-visible run", () => {
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-22T10:00:00.000Z"));

    expect(run).toMatchObject({
      kind: "testbed_mission_run",
      status: "ready",
      targetUrl: "https://testbed.example/app",
      goal: "complete onboarding",
      agentName: "Hermes",
      freshMemory: true,
    });
    expect(run?.id).toMatch(/^testbed-mission-/);
    expect(listTestbedMissionRuns()).toHaveLength(1);
  });

  it("turns active mission runs into Hermes Checking board items", () => {
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-22T10:00:00.000Z"));
    expect(run).toBeDefined();

    const item = testbedMissionRunToMonitorItem(run!);

    expect(item).toMatchObject({
      correlationId: run!.id,
      intent: "testbed_agent_mission",
      repo: "testbed/agent",
      status: "running",
      active: true,
      activeState: "running",
      summary: {
        kind: "testbed_mission_run",
        finalVerdict: "running",
        reviewSignals: {
          touchedAreas: ["testbed"],
          testSignals: ["browser mission packet ready"],
          missingTestSignals: ["browser agent report"],
        },
      },
      safety: {
        wouldMutate: false,
      },
    });
  });

  it("attaches a passing browser-agent report and completes the mission", () => {
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-22T10:00:00.000Z"));
    expect(run).toBeDefined();

    const updated = recordTestbedMissionReportFromMessage(
      {
        relatedCorrelationId: run!.id,
        text: JSON.stringify({
          verdict: "pass",
          confidence: 0.91,
          stoppedBeforeMutation: true,
          completedPath: ["opened page", "completed onboarding"],
          blockers: [],
          scores: { orientation: 5 },
        }),
      },
      Date.parse("2026-05-22T10:05:00.000Z")
    );

    expect(updated).toMatchObject({
      id: run!.id,
      status: "completed",
      result: {
        verdict: "pass",
        confidence: 0.91,
        ingestedAt: "2026-05-22T10:05:00.000Z",
      },
    });

    const item = testbedMissionRunToMonitorItem(updated!);
    expect(item).toMatchObject({
      status: "completed",
      active: false,
      summary: {
        finalVerdict: "pass",
        reviewSignals: {
          testSignals: ["browser mission packet ready", "browser agent report attached"],
          missingTestSignals: [],
        },
      },
    });
  });

  it("attaches a partial browser-agent report and keeps blockers visible", () => {
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-22T10:00:00.000Z"));
    expect(run).toBeDefined();

    const updated = recordTestbedMissionReportFromMessage(
      {
        text: [
          "mission report",
          run!.id,
          "```json",
          JSON.stringify({
            verdict: "partial",
            stoppedBeforeMutation: true,
            blockers: ["Could not find the submit boundary."],
            scores: { trustAndSafety: 2 },
          }),
          "```",
        ].join("\n"),
      },
      Date.parse("2026-05-22T10:05:00.000Z")
    );

    expect(updated).toMatchObject({
      id: run!.id,
      status: "failed",
      statusReason: "Browser-agent report returned partial; blocker: Could not find the submit boundary.",
      result: {
        verdict: "partial",
      },
    });

    const item = testbedMissionRunToMonitorItem(updated!);
    expect(item).toMatchObject({
      status: "failed",
      summary: {
        finalVerdict: "failed",
        reviewSignals: {
          missingTestSignals: [],
        },
        reviewReasons: [
          {
            code: "testbed_mission_failed",
          },
        ],
      },
    });
  });
});

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
      scoringRubric: [
        { id: "orientation", question: "Could the agent understand the page?" },
      ],
      safety: {
        missionGeneratorMutates: false,
      },
    },
  };
}
