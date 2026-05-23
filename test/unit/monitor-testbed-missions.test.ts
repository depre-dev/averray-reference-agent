import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetTestbedMissionRunsForTests,
  diagnoseTestbedMissionReportFromMessage,
  listTestbedMissionRuns,
  recordTestbedMissionReportFromMessage,
  recordTestbedMissionRunFromOperatorResult,
  testbedMissionCodexFollowupPrompt,
  testbedMissionReportValidationCoaching,
  testbedMissionRerunPrompt,
  testbedMissionResultCoaching,
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
      history: [
        {
          event: "mission_packet_ready",
          status: "ready",
          message: "Mission packet generated; waiting for a clean browser-only agent run.",
        },
      ],
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
          evidence: [{ type: "observation", value: "The browser agent reached the final review step." }],
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
      history: [
        {
          event: "mission_packet_ready",
        },
        {
          event: "mission_report_passed",
          status: "completed",
          at: "2026-05-22T10:05:00.000Z",
        },
      ],
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
            confidence: 0.63,
            stoppedBeforeMutation: true,
            blockers: ["Could not find the submit boundary."],
            evidence: [{ type: "observation", value: "The browser agent stopped at the wallet prompt." }],
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
      history: [
        {
          event: "mission_packet_ready",
        },
        {
          event: "mission_report_needs_fix",
          status: "failed",
          message: "Browser-agent report returned partial; blocker: Could not find the submit boundary.",
        },
      ],
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
    const coaching = testbedMissionResultCoaching(updated!);
    expect(coaching).toContain("What I learned: verdict partial");
    expect(coaching).toContain("Could not find the submit boundary");
    expect(coaching).toContain("Suggested product fix");
    expect(coaching).toContain("Smallest Codex task");
    expect(coaching).toContain("run this same testbed mission again");

    const prompt = testbedMissionCodexFollowupPrompt(updated!);
    expect(prompt).toContain("Fix the testbed page for mission");
    expect(prompt).toContain("Primary blocker: Could not find the submit boundary.");
    expect(prompt).toContain("Suggested product fix: make the mutation boundary explicit");
    expect(prompt).toContain("After the change, run the same testbed mission again");
    expect(prompt).toContain("observation: The browser agent stopped at the wallet prompt.");

    const rerunPrompt = testbedMissionRerunPrompt(updated!);
    expect(rerunPrompt).toContain("Rerun testbed mission");
    expect(rerunPrompt).toContain("Memory mode: fresh browser agent");
    expect(rerunPrompt).toContain("Previous blocker to compare against: Could not find the submit boundary.");
    expect(rerunPrompt).toContain("Original mission prompt:");
    expect(rerunPrompt).toContain("Open the app and complete onboarding.");
  });

  it("rejects incomplete browser-agent reports before attaching them", () => {
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-22T10:00:00.000Z"));
    expect(run).toBeDefined();

    const diagnosis = diagnoseTestbedMissionReportFromMessage({
      relatedCorrelationId: run!.id,
      text: JSON.stringify({
        verdict: "pass",
        stoppedBeforeMutation: true,
        scores: { orientation: 5 },
      }),
    });

    expect(diagnosis).toMatchObject({
      candidate: true,
      valid: false,
      errors: expect.arrayContaining([
        "Set confidence to a number from 0 to 1.",
        "Add at least one evidence item or observation.",
        "For a pass, add the completedPath steps the browser agent actually took.",
      ]),
    });

    expect(recordTestbedMissionReportFromMessage({
      relatedCorrelationId: run!.id,
      text: JSON.stringify({
        verdict: "pass",
        stoppedBeforeMutation: true,
        scores: { orientation: 5 },
      }),
    })).toBeUndefined();
    const stillPending = listTestbedMissionRuns()[0];
    expect(stillPending).toMatchObject({
      id: run!.id,
      status: "ready",
    });
    expect(stillPending.result).toBeUndefined();

    const coaching = testbedMissionReportValidationCoaching(diagnosis.errors, diagnosis.warnings);
    expect(coaching).toContain("I saw a possible testbed mission report, but I did not ingest it yet.");
    expect(coaching).toContain("Set confidence to a number from 0 to 1.");
    expect(coaching).toContain("Smallest next move");
    expect(coaching).toContain("do not ask Codex to change the product until the evidence is attached");
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
