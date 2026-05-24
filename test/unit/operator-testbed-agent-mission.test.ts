import { describe, expect, it } from "vitest";

import { getTestbedAgentMission } from "../../packages/averray-mcp/src/operator-testbed.js";

describe("testbed agent mission", () => {
  it("builds a read-only fresh browser mission for a normal outside agent", () => {
    const mission = getTestbedAgentMission();

    expect(mission).toMatchObject({
      schemaVersion: 1,
      kind: "testbed_agent_browser_mission",
      mutates: false,
      agentMode: {
        identity: "normal_out_of_box_agent",
        memoryMode: "fresh_or_ignored",
        browserOnly: true,
        privilegedAverrayMcpAllowed: false,
        hiddenProjectContextAllowed: false,
        humanHelpAllowed: false,
        mutationMode: "stop_before_mutation",
      },
      safety: {
        missionGeneratorMutates: false,
        browserMissionShouldMutate: false,
        allowedMutationScope: "none; stop at mutation boundary",
        freshAgentDefault: true,
        requiresEvidence: true,
        comparesAcrossAgents: true,
      },
    });
    expect(mission.missionPrompt).toContain("normal out-of-the-box agent");
    expect(mission.missionPrompt).toContain("Do not use private repository knowledge");
    expect(mission.missionPrompt).toContain("Averray MCP tools");
    expect(mission.deniedShortcuts).toContain("Averray operator or workflow MCP tools after receiving this mission");
    expect(mission.reportSchema).toMatchObject({
      verdict: "pass | partial | fail",
      confidence: "0.0-1.0",
      mutationMode: "stop_before_mutation",
      mutationsAttempted: ["test-only actions submitted, or empty array"],
      stoppedBeforeMutation: "boolean",
    });
    expect(mission.reportSchema.completedPath).toEqual(["ordered browser actions the agent took"]);
    expect(mission.scoringRubric.map((entry) => entry.id)).toEqual([
      "orientation",
      "navigation",
      "taskCompletion",
      "trustAndSafety",
      "recoverability",
      "evidenceQuality",
    ]);
  });

  it("accepts a target URL, goal, returning-agent mode, and bounded run limits", () => {
    const mission = getTestbedAgentMission({
      targetUrl: "https://testbed.example/app",
      goal: "Complete onboarding",
      agentName: "Claude",
      freshMemory: false,
      maxBrowserSteps: 999,
      maxMinutes: 1,
    });

    expect(mission.target).toEqual({
      url: "https://testbed.example/app",
      goal: "Complete onboarding",
      agentName: "Claude",
      freshMemory: false,
      maxBrowserSteps: 200,
      maxMinutes: 5,
    });
    expect(mission.agentMode.memoryMode).toBe("returning_agent_memory_allowed");
    expect(mission.missionPrompt).toContain("You are Claude");
    expect(mission.missionPrompt).toContain("Open https://testbed.example/app.");
    expect(mission.missionPrompt).toContain("Goal: Complete onboarding");
  });

  it("can build a test-mode mission where sandbox page mutations are allowed", () => {
    const mission = getTestbedAgentMission({
      targetUrl: "https://testbed.example/app",
      goal: "Complete fake onboarding",
      allowTestMutations: true,
    });

    expect(mission.agentMode.mutationMode).toBe("testbed_mutation_allowed");
    expect(mission.safety).toMatchObject({
      missionGeneratorMutates: false,
      browserMissionShouldMutate: true,
      allowedMutationScope: "testbed-only page actions that are visibly fake, sandbox, or non-production",
    });
    expect(mission.missionPrompt).toContain("you may complete test-only submits");
    expect(mission.missionPrompt).toContain("Stop before real payment");
    expect(mission.deniedShortcuts).toContain("real wallet signatures, real payment, production submit, deploy, merge, or account mutation");
    expect(mission.reportSchema).toMatchObject({
      mutationMode: "testbed_mutation_allowed",
      stoppedBeforeMutation: "boolean",
    });
  });
});
