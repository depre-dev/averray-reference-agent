import { describe, expect, it } from "vitest";

import type { TestbedMissionRun } from "../../services/slack-operator/src/monitor-testbed-missions.js";
import { buildTesterCapabilitiesManifest } from "../../services/slack-operator/src/tester-capabilities.js";

describe("tester capabilities manifest", () => {
  it("publishes the monitor-native request contract and honest available mission types", () => {
    const manifest = buildTesterCapabilitiesManifest({
      now: new Date("2026-05-31T12:00:00.000Z"),
      env: {
        TESTBED_MISSION_RUNNER_ENABLED: "1",
        TESTBED_MISSION_RUNNER_EXECUTOR: "playwright",
      },
      runner: {
        schemaVersion: 1,
        kind: "testbed_mission_runner_heartbeat",
        runnerId: "runner-1",
        status: "idle",
        message: "ready",
        updatedAt: "2026-05-31T11:59:55.000Z",
      },
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "hermes_tester_capabilities",
      generatedAt: "2026-05-31T12:00:00.000Z",
      endpoints: {
        capabilities: { method: "GET", path: "/monitor/tester/capabilities" },
        requestMission: { method: "POST", path: "/monitor/testbed-missions" },
        requestBoardGatedMission: { method: "POST", path: "/monitor/testbed-missions/request" },
        approveRequestedMission: { method: "POST", path: "/monitor/testbed-missions/{id}/approve" },
        listSuites: { method: "GET", path: "/monitor/suites" },
        createSuite: { method: "POST", path: "/monitor/suites" },
        runSuite: { method: "POST", path: "/monitor/suites/{id}/run" },
        requestSuite: { method: "POST", path: "/monitor/suites/request" },
        approveRequestedSuite: { method: "POST", path: "/monitor/suites/{id}/approve" },
      },
      runtime: {
        runnerEnabled: true,
        runnerExecutor: "playwright",
        signerSidecarEnabled: false,
      },
    });

    const surfaceSweep = manifest.missionTypes.find((mission) => mission.id === "surface_sweep");
    expect(surfaceSweep).toMatchObject({
      status: "available",
      scope: "read_only",
      mutation: "never",
    });
    const targeted = manifest.missionTypes.find((mission) => mission.id === "targeted_read_only");
    expect(targeted).toMatchObject({
      status: "available",
      scope: "read_only",
      mutation: "stop_before_mutation",
    });
    const goldPath = manifest.missionTypes.find((mission) => mission.id === "gold_path");
    expect(goldPath).toMatchObject({
      status: "ready_needs_live_driver",
      scope: "testbed_mutation_only",
    });
    const siweAuth = manifest.missionTypes.find((mission) => mission.id === "siwe_auth_role_gating");
    expect(siweAuth).toMatchObject({
      status: "planned",
      scope: "read_only",
      mutation: "never",
      request: {
        body: {
          mode: "siwe_auth",
        },
      },
    });
  });

  it("authed sweep is ready-but-needs-session until a session SOURCE is configured (T2)", () => {
    // No runner session source -> ready_needs_session, even with the sidecar up.
    const noSource = buildTesterCapabilitiesManifest({
      env: {
        TESTBED_MISSION_RUNNER_ENABLED: "1",
        TEST_WALLET_SIGNER_ENABLED: "1",
      },
    });
    expect(noSource.runtime.signerSidecarEnabled).toBe(true);
    expect(noSource.runtime.authedSessionConfigured).toBe(false);
    expect(noSource.missionTypes.find((m) => m.id === "authed_surface_sweep")).toMatchObject({
      status: "ready_needs_session",
    });

    // Sidecar URL on the runner -> available, sourced from the sidecar.
    const viaSidecar = buildTesterCapabilitiesManifest({
      env: {
        TESTBED_MISSION_RUNNER_ENABLED: "1",
        TESTBED_SESSION_SIGNER_URL: "http://test-wallet-signer:8791",
      },
    });
    expect(viaSidecar.runtime.authedSessionConfigured).toBe(true);
    expect(viaSidecar.runtime.authedSessionSource).toBe("test-wallet-signer sidecar");
    expect(viaSidecar.missionTypes.find((m) => m.id === "authed_surface_sweep")).toMatchObject({
      status: "available",
    });

    // Manual storageState path -> available, sourced manually (decoupled landing).
    const viaManual = buildTesterCapabilitiesManifest({
      env: {
        TESTBED_MISSION_RUNNER_ENABLED: "1",
        TESTBED_SESSION_STORAGE_STATE_PATH: "/data/agent-storage-state.json",
      },
    });
    expect(viaManual.runtime.authedSessionConfigured).toBe(true);
    expect(viaManual.runtime.authedSessionSource).toBe("manual storageState/token");
    expect(viaManual.missionTypes.find((m) => m.id === "authed_surface_sweep")).toMatchObject({
      status: "available",
    });
  });

  it("does not advertise runnable flows when the runner or required driver/session is not wired", () => {
    const disabled = buildTesterCapabilitiesManifest({
      env: {
        TESTBED_MISSION_RUNNER_ENABLED: "0",
        TEST_WALLET_SIGNER_ENABLED: "1",
        TESTBED_SESSION_SIGNER_URL: "http://test-wallet-signer:8791",
        TESTBED_GOLDPATH_LIVE: "1",
      },
    });
    expect(disabled.inventory.status).toBe("not_ready");
    expect(disabled.missionTypes.find((m) => m.id === "surface_sweep")).toMatchObject({
      status: "unavailable_runner_disabled",
    });
    expect(disabled.missionTypes.find((m) => m.id === "gold_path")).toMatchObject({
      status: "unavailable_runner_disabled",
    });

    const commandMissing = buildTesterCapabilitiesManifest({
      env: {
        TESTBED_MISSION_RUNNER_ENABLED: "1",
        TESTBED_MISSION_RUNNER_EXECUTOR: "command",
      },
    });
    expect(commandMissing.runtime.runnerConfigured).toBe(false);
    expect(commandMissing.missionTypes.find((m) => m.id === "targeted_read_only")).toMatchObject({
      status: "unavailable_runner_misconfigured",
    });

    const liveNoSession = buildTesterCapabilitiesManifest({
      env: {
        TESTBED_MISSION_RUNNER_ENABLED: "1",
        TESTBED_GOLDPATH_LIVE: "1",
      },
    });
    expect(liveNoSession.missionTypes.find((m) => m.id === "gold_path")).toMatchObject({
      status: "ready_needs_session",
    });
  });

  it("publishes ready-to-test inventory from saved suites, targets, and recent mission evidence", () => {
    const run = missionRun({
      id: "mission-1",
      title: "Gold path smoke",
      mode: "gold_path",
      targetUrl: "https://app.testnet.example/gold",
      status: "completed",
      allowTestMutations: true,
      requestedAllowTestMutations: true,
      updatedAt: "2026-06-01T11:58:00.000Z",
      completedAt: "2026-06-01T11:58:00.000Z",
      result: { structuredReport: { verdict: "pass" } },
    });
    const failedRun = missionRun({
      id: "mission-2",
      title: "Settings inspection",
      targetUrl: "https://preview.example/settings",
      status: "failed",
      updatedAt: "2026-06-01T11:59:00.000Z",
      failedAt: "2026-06-01T11:59:00.000Z",
      result: { verdict: "fail" },
    });

    const manifest = buildTesterCapabilitiesManifest({
      now: new Date("2026-06-01T12:00:00.000Z"),
      env: {
        TESTBED_MISSION_RUNNER_ENABLED: "1",
        TESTBED_GOLDPATH_LIVE: "1",
        TESTBED_SESSION_SIGNER_URL: "http://test-wallet-signer:8791",
        TESTBED_SURFACE_SWEEP_BASE_URL: "https://averray.com",
        AVERRAY_APP_BASE_URL: "https://app.testnet.example",
        AVERRAY_API_BASE_URL: "https://api.testnet.example",
        AVERRAY_TESTBED_ENVIRONMENT: "testnet",
      },
      missionRuns: [run, failedRun],
      savedSuites: [
        {
          id: "suite-gold",
          name: "Gold path smoke",
          flow: "gold_path",
          target: "https://app.testnet.example/gold",
        },
      ],
    });

    expect(manifest.inventory).toMatchObject({
      status: "ready",
      savedSuitesAvailable: true,
      savedSuitesStore: "provided",
    });
    expect(manifest.inventory.savedSuites[0]).toMatchObject({
      id: "suite-gold",
      name: "Gold path smoke",
      flow: "gold_path",
      target: "https://app.testnet.example/gold",
      status: "available",
      flowStatus: "available_live_driver",
      lastRun: {
        missionId: "mission-1",
        verdict: "pass",
        at: "2026-06-01T11:58:00.000Z",
      },
    });
    expect(manifest.inventory.recentRuns.map((entry) => entry.id)).toEqual(["mission-2", "mission-1"]);
    expect(manifest.inventory.recentRuns[0]).toMatchObject({
      flow: "targeted_read_only",
      target: "https://preview.example/settings",
      lastRun: { verdict: "fail" },
    });
    expect(manifest.inventory.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "public_surface",
        url: "https://averray.com",
        reachability: expect.objectContaining({ status: "not_checked_by_manifest" }),
        mutationProfile: expect.objectContaining({ mode: "read_only", allowTestMutations: false }),
      }),
      expect.objectContaining({
        id: "operator_app",
        url: "https://app.testnet.example",
        environment: "testnet",
      }),
      expect.objectContaining({
        id: "recent:https-app-testnet-example-gold",
        reachability: expect.objectContaining({
          status: "reachable_last_run_passed",
          missionId: "mission-1",
          verdict: "pass",
        }),
        mutationProfile: expect.objectContaining({
          mode: "testbed_mutation_allowed",
          allowTestMutations: true,
        }),
      }),
    ]));
  });
});

function missionRun(overrides: Partial<TestbedMissionRun>): TestbedMissionRun {
  const now = "2026-06-01T12:00:00.000Z";
  return {
    schemaVersion: 1,
    kind: "testbed_mission_run",
    id: "mission",
    status: "ready",
    title: "Mission",
    targetUrl: "https://example.test",
    goal: "Inspect the target.",
    agentName: "Hermes",
    freshMemory: true,
    allowTestMutations: false,
    requestedAllowTestMutations: false,
    mutationMode: "read_only",
    mutationScope: "none; stop at mutation boundary",
    mutationBindingReason: "mission did not request testbed mutations.",
    mission: {},
    history: [],
    createdAt: now,
    updatedAt: now,
    statusReason: "ready",
    ...overrides,
  };
}
