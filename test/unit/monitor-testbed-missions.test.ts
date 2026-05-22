import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetTestbedMissionRunsForTests,
  listTestbedMissionRuns,
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
