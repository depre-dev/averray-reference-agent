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

  it("publishes the terminal manifest last when stop() lands mid-capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "averray-screencast-test-"));
    const mission = missionRun({
      id: "mission-live-stop-race",
      targetUrl: "https://app.testnet.example/gold",
      environment: "testnet",
    });
    let captureStarted!: () => void;
    let releaseCapture!: () => void;
    let framePublished!: () => void;
    const captureInFlight = new Promise<void>((resolve) => { captureStarted = resolve; });
    const captureReleased = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const framePersisted = new Promise<void>((resolve) => { framePublished = resolve; });
    const page = {
      url: () => "https://app.testnet.example/gold",
      screenshot: vi.fn(async ({ path }: { path: string }) => {
        captureStarted();
        await captureReleased;
        writeFileSync(path, Buffer.from("jpeg-frame"));
      }),
    } as unknown as Page;

    const controller = await startPlaywrightLiveScreencast({
      mission,
      page,
      artifactsRoot: root,
      config: { enabled: true, intervalMs: 1, maxFrames: 10, jpegQuality: 40 },
      update: (state) => {
        if (state.status === "running" && state.frameCount === 1) framePublished();
      },
    });

    await captureInFlight;
    const stopping = controller?.stop("test_finished");
    releaseCapture();
    await stopping;
    // The frame that was in flight has written its own "running" manifest by
    // now; stop() must still be the last writer to land on disk.
    await framePersisted;

    expect(await readTestbedScreencastManifest(root, mission.id)).toMatchObject({
      status: "ended",
      reason: "test_finished",
    });
  });

  it("never exposes a torn manifest to a concurrent reader", async () => {
    const root = mkdtempSync(join(tmpdir(), "averray-screencast-test-"));
    const mission = missionRun({
      id: "mission-live-torn-read",
      targetUrl: "https://app.testnet.example/gold",
      environment: "testnet",
    });
    const page = {
      url: () => "https://app.testnet.example/gold",
      screenshot: vi.fn(async ({ path }: { path: string }) => {
        writeFileSync(path, Buffer.from("jpeg-frame"));
      }),
    } as unknown as Page;

    const controller = await startPlaywrightLiveScreencast({
      mission,
      page,
      artifactsRoot: root,
      config: { enabled: true, intervalMs: 0, maxFrames: 1000, jpegQuality: 40 },
      update: () => {},
    });

    try {
      await vi.waitFor(async () => {
        expect(await readTestbedScreencastManifest(root, mission.id)).toBeDefined();
      });
      // The monitor SSE route polls this manifest while the runner rewrites it
      // on every frame; once written it must never read back as missing.
      for (let round = 0; round < 20; round += 1) {
        const reads = await Promise.all(
          Array.from({ length: 20 }, () => readTestbedScreencastManifest(root, mission.id)),
        );
        expect(reads.filter((manifest) => manifest === undefined)).toEqual([]);
      }
    } finally {
      await controller?.stop("test_finished");
    }
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
