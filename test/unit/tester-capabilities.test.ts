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
      status: "operator_only_design",
      scope: "testbed_mutation_only",
    });
  });

  it("marks authed sweep as session-source available only when the signer sidecar is enabled", () => {
    const withoutSigner = buildTesterCapabilitiesManifest({
      env: { TEST_WALLET_SIGNER_ENABLED: "0" },
    });
    expect(withoutSigner.missionTypes.find((mission) => mission.id === "authed_surface_sweep")).toMatchObject({
      status: "planned",
    });

    const withSigner = buildTesterCapabilitiesManifest({
      env: { TEST_WALLET_SIGNER_ENABLED: "1" },
    });
    expect(withSigner.runtime.signerSidecarEnabled).toBe(true);
    expect(withSigner.missionTypes.find((mission) => mission.id === "authed_surface_sweep")).toMatchObject({
      status: "session_source_available",
    });
  });
});
