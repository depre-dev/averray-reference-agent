import { describe, expect, it } from "vitest";

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
      status: "available_fake_default",
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
    // No runner session source → ready_needs_session, even with the sidecar up.
    const noSource = buildTesterCapabilitiesManifest({ env: { TEST_WALLET_SIGNER_ENABLED: "1" } });
    expect(noSource.runtime.signerSidecarEnabled).toBe(true);
    expect(noSource.runtime.authedSessionConfigured).toBe(false);
    expect(noSource.missionTypes.find((m) => m.id === "authed_surface_sweep")).toMatchObject({
      status: "ready_needs_session",
    });

    // Sidecar URL on the runner → available, sourced from the sidecar.
    const viaSidecar = buildTesterCapabilitiesManifest({
      env: { TESTBED_SESSION_SIGNER_URL: "http://test-wallet-signer:8791" },
    });
    expect(viaSidecar.runtime.authedSessionConfigured).toBe(true);
    expect(viaSidecar.runtime.authedSessionSource).toBe("test-wallet-signer sidecar");
    expect(viaSidecar.missionTypes.find((m) => m.id === "authed_surface_sweep")).toMatchObject({
      status: "available",
    });

    // Manual storageState path → available, sourced manually (decoupled landing).
    const viaManual = buildTesterCapabilitiesManifest({
      env: { TESTBED_SESSION_STORAGE_STATE_PATH: "/data/agent-storage-state.json" },
    });
    expect(viaManual.runtime.authedSessionConfigured).toBe(true);
    expect(viaManual.runtime.authedSessionSource).toBe("manual storageState/token");
    expect(viaManual.missionTypes.find((m) => m.id === "authed_surface_sweep")).toMatchObject({
      status: "available",
    });
  });
});
