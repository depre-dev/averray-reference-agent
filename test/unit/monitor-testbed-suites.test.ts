import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __resetTestbedSuitesForTests,
  appendTestbedSuiteRun,
  createTestbedSuite,
  listTestbedSuites,
} from "../../services/slack-operator/src/monitor-testbed-suites.js";
import { createMonitorTestbedMissionFromPayload } from "../../services/slack-operator/src/testbed-agent-entrypoint.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "averray-testbed-suites-"));
  __resetTestbedSuitesForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
});
