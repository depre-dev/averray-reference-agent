import { describe, expect, it, beforeEach } from "vitest";

import {
  __resetTestbedMissionRunsForTests,
  diagnoseTestbedMissionReportFromMessage,
  failedTestbedMissionsForSelfHealing,
  failTestbedMissionRun,
  listTestbedMissionRuns,
  recordTestbedMissionReportFromMessage,
  recordTestbedMissionRunFromOperatorResult,
  testbedMissionBaselinePrompt,
  testbedMissionComparisonBrief,
  testbedMissionCodexFollowupPrompt,
  testbedMissionFixBrief,
  testbedMissionReportValidationCoaching,
  testbedMissionRerunPrompt,
  testbedMissionResultCoaching,
  testbedMissionRunToMonitorItem,
  testbedMissionStructuredReport,
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
      allowTestMutations: false,
      history: [
        {
          event: "mission_packet_ready",
          status: "ready",
          message: "Mission packet generated for testnet; waiting for a clean browser-only agent run.",
        },
      ],
    });
    expect(run?.id).toMatch(/^testbed-mission-/);
    expect(listTestbedMissionRuns()).toHaveLength(1);
  });

  it("records a SIWE auth mission as a mission-native run", () => {
    const run = recordTestbedMissionRunFromOperatorResult(
      missionResult({ mode: "siwe_auth" }),
      Date.parse("2026-05-22T10:00:00.000Z")
    );

    expect(run).toMatchObject({
      title: "SIWE auth role-gating mission",
      mode: "siwe_auth",
      statusReason: "SIWE auth mission is ready; waiting for signer-sidecar role sessions and structured role-gating evidence.",
      history: [
        {
          message: "SIWE auth mission generated; waiting for the signer-sidecar role sessions and read-only role-gating checks.",
        },
      ],
    });
  });

  it("accepts a passing test-mode report that crossed an allowed sandbox mutation", () => {
    const run = recordTestbedMissionRunFromOperatorResult(
      missionResult({ allowTestMutations: true }),
      Date.parse("2026-05-22T10:00:00.000Z")
    );
    expect(run).toMatchObject({
      allowTestMutations: true,
      statusReason: "Mission packet is ready with testnet testbed mutations allowed; waiting for a browser-only test-mode run and structured report.",
    });

    const updated = recordTestbedMissionReportFromMessage(
      {
        relatedCorrelationId: run!.id,
        text: JSON.stringify({
          verdict: "pass",
          confidence: 0.88,
          mutationMode: "testbed_mutation_allowed",
          mutationsAttempted: ["submitted fake onboarding form"],
          stoppedBeforeMutation: false,
          mutationBoundaryNotes: ["Submitted only the visibly fake onboarding form."],
          completedPath: ["opened page", "submitted fake onboarding form", "saw sandbox success"],
          blockers: [],
          evidence: [{ type: "visible_text", value: "Sandbox submission complete" }],
          scores: { taskCompletion: 5 },
        }),
      },
      Date.parse("2026-05-22T10:05:00.000Z")
    );

    expect(updated).toMatchObject({
      status: "completed",
      statusReason: "Browser-agent report passed after permitted testbed-only page mutation: Submitted only the visibly fake onboarding form.",
      result: {
        mutationMode: "testbed_mutation_allowed",
        mutationsAttempted: ["submitted fake onboarding form"],
        stoppedBeforeMutation: false,
        structuredReport: {
          verdict: "pass",
          mutationBoundaryNotes: ["Submitted only the visibly fake onboarding form."],
          mutationsAttempted: ["submitted fake onboarding form"],
          summary: "pass: usable path found; Submitted only the visibly fake onboarding form.",
        },
      },
    });
    const item = testbedMissionRunToMonitorItem(updated!);
    expect(item).toMatchObject({
      summary: {
        reviewSignals: {
          testSignals: [
            "mission packet ready",
            "mission environment: testnet",
            "mutation profile: testbed_mutation_allowed",
            "test-mode page mutation allowed",
            "browser agent report attached",
          ],
        },
      },
      safety: {
        browserMissionShouldMutate: true,
        mutationMode: "testbed_mutation_allowed",
      },
    });
  });

  it("rebounds requested mutations to read-only outside a testbed environment", () => {
    const run = recordTestbedMissionRunFromOperatorResult(
      missionResult({ allowTestMutations: true, targetUrl: "https://averray.com" }),
      Date.parse("2026-05-22T10:00:00.000Z")
    );

    expect(run).toMatchObject({
      targetUrl: "https://averray.com",
      requestedAllowTestMutations: true,
      allowTestMutations: false,
      environment: "mainnet",
      mutationMode: "read_only",
      mutationScope: "none; stop at mutation boundary",
      mutationBindingReason: "testbed mutations denied for mainnet environment.",
      statusReason: "Mission packet is ready, but env→mutation binding forced read-only: testbed mutations denied for mainnet environment.",
    });
    expect(String(run?.mission.missionPrompt)).toContain("Mutation profile override: mainnet / read_only");
    expect(testbedMissionRunToMonitorItem(run!)).toMatchObject({
      safety: {
        browserMissionShouldMutate: false,
        requestedBrowserMissionShouldMutate: true,
        missionEnvironment: "mainnet",
      },
    });
  });

  it("turns active mission runs into mission-native board items", () => {
    const run = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-22T10:00:00.000Z"));
    expect(run).toBeDefined();

    const item = testbedMissionRunToMonitorItem(run!);

    expect(item).toMatchObject({
      correlationId: run!.id,
      intent: "testbed_agent_mission",
      repo: "testbed/mission",
      status: "running",
      active: true,
      activeState: "running",
      summary: {
        kind: "testbed_mission_run",
        finalVerdict: "running",
        reviewSignals: {
          touchedAreas: ["testbed"],
          testSignals: [
            "mission packet ready",
            "mission environment: testnet",
            "mutation profile: read_only",
          ],
          missingTestSignals: ["browser-agent report"],
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
          mutationBoundaryNotes: ["Stopped before account creation; no real mutation was needed."],
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
        structuredReport: {
          verdict: "pass",
          confidence: 0.91,
          stoppedBeforeMutation: true,
          mutationBoundaryNotes: ["Stopped before account creation; no real mutation was needed."],
          summary: "pass: usable path found; Stopped before account creation; no real mutation was needed.",
        },
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
        structuredReport: {
          verdict: "pass",
          scores: { orientation: 5 },
          blockers: [],
          confusingMoments: [],
          mutationBoundaryNotes: ["Stopped before account creation; no real mutation was needed."],
        },
        reviewSignals: {
          testSignals: [
            "mission packet ready",
            "mission environment: testnet",
            "mutation profile: read_only",
            "browser agent report attached",
          ],
          missingTestSignals: [],
        },
      },
    });

    const baselinePrompt = testbedMissionBaselinePrompt(updated!);
    expect(baselinePrompt).toContain("Use testbed mission");
    expect(baselinePrompt).toContain("as the baseline for future page checks");
    expect(baselinePrompt).toContain("Known-good path:");
    expect(baselinePrompt).toContain("opened page");
    expect(baselinePrompt).toContain("Baseline confidence: 91%");
    expect(baselinePrompt).toContain("When the page changes, run this mission again");

    const comparisonBrief = testbedMissionComparisonBrief(updated!);
    expect(comparisonBrief).toContain("pass baseline");
    expect(comparisonBrief).toContain('Known-good path starts with "opened page".');
    expect(comparisonBrief).toContain("preserve the same visible path");

    expect(testbedMissionStructuredReport(updated!)).toMatchObject({
      verdict: "pass",
      confidence: 0.91,
      scores: { orientation: 5 },
      blockers: [],
      confusingMoments: [],
      mutationBoundaryNotes: ["Stopped before account creation; no real mutation was needed."],
      stoppedBeforeMutation: true,
      summary: "pass: usable path found; Stopped before account creation; no real mutation was needed.",
    });
  });

  it("attaches a comparison against the previous completed mission baseline", () => {
    const first = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-22T10:00:00.000Z"));
    recordTestbedMissionReportFromMessage(
      {
        relatedCorrelationId: first!.id,
        text: JSON.stringify({
          verdict: "pass",
          confidence: 0.9,
          stoppedBeforeMutation: true,
          mutationBoundaryNotes: ["Stayed read-only."],
          completedPath: ["opened page"],
          blockers: [],
          evidence: [{ type: "screenshot", value: "/tmp/first.png" }],
          scores: { orientation: 5, navigation: 4 },
        }),
      },
      Date.parse("2026-05-22T10:05:00.000Z")
    );

    const second = recordTestbedMissionRunFromOperatorResult(missionResult(), Date.parse("2026-05-22T11:00:00.000Z"));
    const updated = recordTestbedMissionReportFromMessage(
      {
        relatedCorrelationId: second!.id,
        text: JSON.stringify({
          verdict: "pass",
          confidence: 0.92,
          stoppedBeforeMutation: true,
          mutationBoundaryNotes: ["Stayed read-only."],
          completedPath: ["opened page", "clicked docs"],
          blockers: [],
          evidence: [{ type: "trace", value: "/tmp/trace.zip" }],
          scores: { orientation: 5, navigation: 5 },
        }),
      },
      Date.parse("2026-05-22T11:05:00.000Z")
    );

    expect(updated?.result).toMatchObject({
      baselineComparison: {
        baselineRunId: first!.id,
        verdictChanged: false,
        blockerChanged: false,
        scoreDeltas: { navigation: 1 },
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
            mutationBoundaryNotes: ["Stopped at the wallet prompt before signing."],
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
        structuredReport: {
          verdict: "partial",
          blockers: ["Could not find the submit boundary."],
          confusingMoments: [],
          mutationBoundaryNotes: ["Stopped at the wallet prompt before signing."],
          summary: "partial: Could not find the submit boundary.; Stopped at the wallet prompt before signing.",
        },
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
        finalVerdict: "partial",
        structuredReport: {
          verdict: "partial",
          scores: { trustAndSafety: 2 },
          blockers: ["Could not find the submit boundary."],
        },
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
    expect(coaching).toContain("Suspected UX gap");
    expect(coaching).toContain("Suggested product fix");
    expect(coaching).toContain("Smallest Codex task");
    expect(coaching).toContain("run this same testbed mission again");

    const fixBrief = testbedMissionFixBrief(updated!);
    expect(fixBrief.primaryBlocker).toBe("Could not find the submit boundary.");
    expect(fixBrief.smallestProductMove).toContain("make the mutation boundary explicit");
    expect(fixBrief.suspectedUxGap).toContain("irreversible action boundary");
    expect(fixBrief.rerunProof).toContain("gone, unchanged, or replaced");
    expect(fixBrief.evidence).toContain("weak score: trustAndSafety:2");

    const prompt = testbedMissionCodexFollowupPrompt(updated!);
    expect(prompt).toContain("Fix the testbed page for mission");
    expect(prompt).toContain("Primary blocker: Could not find the submit boundary.");
    expect(prompt).toContain("Suspected UX gap");
    expect(prompt).toContain("Smallest product move: make the mutation boundary explicit");
    expect(prompt).toContain("Proof after fix: run this same testbed mission again");
    expect(prompt).toContain("After the change, run the same testbed mission again");
    expect(prompt).toContain("observation: The browser agent stopped at the wallet prompt.");

    const rerunPrompt = testbedMissionRerunPrompt(updated!);
    expect(rerunPrompt).toContain("Rerun testbed mission");
    expect(rerunPrompt).toContain("Memory mode: fresh browser agent");
    expect(rerunPrompt).toContain("Previous blocker to compare against: Could not find the submit boundary.");
    expect(rerunPrompt).toContain("Original mission prompt:");
    expect(rerunPrompt).toContain("Open the app and complete onboarding.");

    const comparisonBrief = testbedMissionComparisonBrief(updated!);
    expect(comparisonBrief).toContain("verdict partial");
    expect(comparisonBrief).toContain("Could not find the submit boundary");
    expect(comparisonBrief).toContain("gone, unchanged, or replaced");
    expect(comparisonBrief).toContain("trustAndSafety:2");
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
        "Add mutationBoundaryNotes explaining where the agent stopped, or which test-only mutation boundary it crossed.",
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

  it("feeds B2 only the latest failed mission per target", () => {
    const stale = recordTestbedMissionRunFromOperatorResult(
      missionResult({ targetUrl: "https://testbed.example/app?run=old" }),
      Date.parse("2026-05-22T10:00:00.000Z"),
    )!;
    failTestbedMissionRun(stale.id, {
      now: new Date("2026-05-22T10:05:00.000Z"),
      failureReason: "fetch failed",
    });

    const latestPass = recordTestbedMissionRunFromOperatorResult(
      missionResult({ targetUrl: "https://testbed.example/app?run=new" }),
      Date.parse("2026-05-22T11:00:00.000Z"),
    )!;
    recordTestbedMissionReportFromMessage(
      {
        relatedCorrelationId: latestPass.id,
        text: JSON.stringify({
          verdict: "pass",
          confidence: 0.8,
          stoppedBeforeMutation: true,
          mutationBoundaryNotes: [],
          completedPath: ["opened app"],
          blockers: [],
          evidence: ["200 OK"],
          scores: { orientation: 5 },
        }),
      },
      Date.parse("2026-05-22T11:05:00.000Z"),
    );

    expect(failedTestbedMissionsForSelfHealing(listTestbedMissionRuns(), {
      now: new Date("2026-05-22T12:00:00.000Z"),
    })).toEqual([]);
  });

  it("expires old failed missions from the B2 self-healing input", () => {
    const old = recordTestbedMissionRunFromOperatorResult(
      missionResult({ targetUrl: "https://testbed.example/old" }),
      Date.parse("2026-05-22T10:00:00.000Z"),
    )!;
    failTestbedMissionRun(old.id, {
      now: new Date("2026-05-22T10:05:00.000Z"),
      failureReason: "pre-wiring runner failed",
    });

    const fresh = recordTestbedMissionRunFromOperatorResult(
      missionResult({ targetUrl: "https://testbed.example/fresh" }),
      Date.parse("2026-05-25T10:00:00.000Z"),
    )!;
    failTestbedMissionRun(fresh.id, {
      now: new Date("2026-05-25T10:05:00.000Z"),
      failureReason: "fresh product blocker",
    });

    expect(failedTestbedMissionsForSelfHealing(listTestbedMissionRuns(), {
      now: new Date("2026-05-25T12:00:00.000Z"),
      maxAgeHours: 24,
    }).map((run) => run.id)).toEqual([fresh.id]);
  });
});

function missionResult(options: {
  allowTestMutations?: boolean;
  mode?: "surface_sweep" | "siwe_auth";
  targetUrl?: string;
} = {}) {
  return {
    kind: "testbed_agent_mission",
    mission: {
      kind: "testbed_agent_browser_mission",
      target: {
        url: options.targetUrl ?? "https://testbed.example/app",
        goal: "complete onboarding",
        agentName: "Hermes",
        freshMemory: true,
        ...(options.mode ? { mode: options.mode } : {}),
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
        browserMissionShouldMutate: options.allowTestMutations === true,
      },
    },
  };
}
