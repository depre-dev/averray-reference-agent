import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetTestbedMissionRunsForTests,
  listTestbedMissionRuns,
} from "../../services/slack-operator/src/monitor-testbed-missions.js";
import { createMonitorTestbedMissionFromPayload } from "../../services/slack-operator/src/testbed-agent-entrypoint.js";
import { buildV2BoardSnapshot, diffBoardSnapshots } from "../../services/slack-operator/src/monitor-v2.js";

// Mirror testbed-agent-entrypoint.test.ts: the averray-mcp packet generator is
// stubbed to a minimal browser-mission packet so the store records a run.
vi.mock("@avg/averray-mcp/operator-testbed", () => ({
  getTestbedAgentMission: (input: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    kind: "testbed_agent_browser_mission",
    target: {
      url: input.targetUrl ?? "[TESTBED_URL]",
      goal: input.goal ?? "test the page",
      agentName: input.agentName ?? "Hermes",
      freshMemory: input.freshMemory !== false,
      maxBrowserSteps: input.maxBrowserSteps ?? 80,
      maxMinutes: input.maxMinutes ?? 20,
    },
    missionPrompt: `Goal: ${input.goal ?? "test the page"}`,
    safety: {
      browserMissionShouldMutate: input.allowTestMutations === true,
    },
  }),
}));

// Regression coverage for the backend defect where a successful (HTTP 200)
// testbed-mission launch produced no visible card on the v2 board: a created
// mission must (a) appear in the /monitor/v2/board snapshot, and (b) generate a
// board.card.added stream event the first time it shows up.
describe("testbed mission → v2 board", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    __resetTestbedMissionRunsForTests();
    dir = mkdtempSync(join(tmpdir(), "averray-mission-board-"));
    path = join(dir, "missions.json");
  });

  afterEach(() => {
    __resetTestbedMissionRunsForTests();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function boardRaw() {
    return { active: [], recent: [], testbedMissions: listTestbedMissionRuns({ limit: 20, path }) };
  }

  it("surfaces a launched surface_sweep mission as a hermes-checking mission card", () => {
    const created = createMonitorTestbedMissionFromPayload({
      targetUrl: "https://app.averray.com",
      mode: "surface_sweep",
      freshMemory: "true",
      path,
    });

    const snap = buildV2BoardSnapshot(boardRaw(), { repo: "depre-dev/agent" });
    const missionCard = snap.cards.find((card) => card.type === "mission");

    expect(missionCard, "a mission card should appear on the v2 board snapshot").toBeDefined();
    expect(missionCard?.lane).toBe("hermes-checking");
    expect(missionCard?.agentType).toBe("hermes");
    // The card must correspond to the run we actually created (no faked card):
    // it carries the run's real title, not a synthetic placeholder.
    expect(missionCard?.title).toBe(created.run.title);
  });

  it("keeps the mission visible even when the board is busy with ≥10 PR cards", () => {
    // monitor.averray.com is a live, busy board: many active PR/handoff items
    // are in flight. The classifier caps the board, so a mission appended after
    // a full slate of PR cards must not be the one that falls off.
    const active = Array.from({ length: 12 }, (_unused, i) => ({
      title: `Active PR ${i}`,
      status: "running",
      intent: "pr_review",
      active: true,
      summary: { pullRequest: { repo: "depre-dev/agent", number: 600 + i, state: "open" } },
      ageLabel: "3m",
    }));

    const created = createMonitorTestbedMissionFromPayload({
      targetUrl: "https://app.averray.com",
      mode: "surface_sweep",
      path,
    });

    const raw = { active, recent: [], testbedMissions: listTestbedMissionRuns({ limit: 20, path }) };
    const snap = buildV2BoardSnapshot(raw, { repo: "depre-dev/agent" });
    const missionCard = snap.cards.find((card) => card.type === "mission");

    expect(missionCard, "the mission must survive the board cap on a busy board").toBeDefined();
    expect(missionCard?.lane).toBe("hermes-checking");
    expect(missionCard?.title).toBe(created.run.title);
  });

  it("emits board.card.added the first time the mission appears in the stream diff", () => {
    const empty = buildV2BoardSnapshot(
      { active: [], recent: [], testbedMissions: [] },
      { repo: "depre-dev/agent" },
    );

    createMonitorTestbedMissionFromPayload({
      targetUrl: "https://app.averray.com",
      mode: "surface_sweep",
      path,
    });

    const next = buildV2BoardSnapshot(boardRaw(), { repo: "depre-dev/agent" });
    const events = diffBoardSnapshots(empty, next);
    const added = events.find(
      (event) => event.type === "board.card.added" && event.card.type === "mission",
    );

    expect(added, "the new mission should produce a board.card.added stream event").toBeDefined();
  });
});
