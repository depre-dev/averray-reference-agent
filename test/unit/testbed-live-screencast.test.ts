import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";

import type { TestbedMissionRun } from "../../services/slack-operator/src/monitor-testbed-missions.js";
import {
  liveScreencastAllowedForMission,
  parseTestbedLiveScreencastConfig,
  readTestbedScreencastManifest,
  screencastLatestFramePath,
  startPlaywrightLiveScreencast,
} from "../../services/slack-operator/src/testbed-live-screencast.js";

describe("testbed live screencast", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses a bounded opt-in config", () => {
    expect(parseTestbedLiveScreencastConfig({
      TESTBED_MISSION_LIVE_SCREENCAST_ENABLED: "1",
      TESTBED_MISSION_LIVE_SCREENCAST_INTERVAL_MS: "10",
      TESTBED_MISSION_LIVE_SCREENCAST_MAX_FRAMES: "2000",
      TESTBED_MISSION_LIVE_SCREENCAST_JPEG_QUALITY: "99",
    } as NodeJS.ProcessEnv)).toEqual({
      enabled: true,
      intervalMs: 250,
      maxFrames: 1000,
      jpegQuality: 80,
    });
  });

  it("is testnet-only and rejects credential-bearing target URLs", () => {
    const enabled = { enabled: true, intervalMs: 500, maxFrames: 10, jpegQuality: 45 };
    expect(liveScreencastAllowedForMission(
      { environment: "mainnet", targetUrl: "https://app.averray.com" },
      enabled,
    )).toEqual({ ok: false, reason: "live_screencast_testnet_only" });
    expect(liveScreencastAllowedForMission(
      { environment: "testnet", targetUrl: "https://user:pass@app.testnet.example" },
      enabled,
    )).toEqual({ ok: false, reason: "live_screencast_target_url_contains_credentials" });
  });

  it("captures bounded latest-frame evidence and publishes monitor stream metadata", async () => {
    vi.useFakeTimers();
    const root = mkdtempSync(join(tmpdir(), "averray-screencast-test-"));
    const mission = missionRun({
      id: "mission-live-1",
      targetUrl: "https://app.testnet.example/gold",
      environment: "testnet",
    });
    const page = {
      url: () => "https://app.testnet.example/gold",
      screenshot: vi.fn(async ({ path }: { path: string }) => {
        writeFileSync(path, Buffer.from("jpeg-frame"));
      }),
    } as unknown as Page;
    const updates: unknown[] = [];

    const controller = await startPlaywrightLiveScreencast({
      mission,
      page,
      artifactsRoot: root,
      config: { enabled: true, intervalMs: 5, maxFrames: 2, jpegQuality: 40 },
      update: (state) => updates.push(state),
    });

    expect(controller).toBeDefined();
    await vi.advanceTimersByTimeAsync(5);
    expect(page.screenshot).toHaveBeenCalledOnce();
    expect(readFileSync(screencastLatestFramePath(root, mission.id), "utf8")).toBe("jpeg-frame");
    await vi.waitFor(() => {
      expect(updates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          status: "running",
          streamUrl: `/monitor/testbed-missions/${mission.id}/screencast`,
          latestFrameUrl: `/monitor/testbed-missions/${mission.id}/screencast/latest.jpg`,
          frameCount: 1,
        }),
      ]));
    });

    await controller?.stop("test_finished");
    const manifest = await readTestbedScreencastManifest(root, mission.id);
    expect(manifest).toMatchObject({
      status: "ended",
      reason: "test_finished",
    });
    expect(manifest?.frameCount).toBeGreaterThanOrEqual(1);
  });
});

function missionRun(overrides: Partial<TestbedMissionRun>): TestbedMissionRun {
  const now = "2026-06-02T10:00:00.000Z";
  return {
    schemaVersion: 1,
    kind: "testbed_mission_run",
    id: "mission",
    status: "running",
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
    statusReason: "running",
    ...overrides,
  };
}
