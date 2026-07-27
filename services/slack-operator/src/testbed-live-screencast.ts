import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page } from "playwright-core";

import type { TestbedMissionRun } from "./monitor-testbed-missions.js";

export interface TestbedLiveScreencastConfig {
  enabled: boolean;
  intervalMs: number;
  maxFrames: number;
  jpegQuality: number;
}

export interface TestbedLiveScreencastState {
  status: "running" | "ended" | "unavailable";
  streamUrl?: string;
  latestFrameUrl?: string;
  frameCount?: number;
  startedAt?: string;
  updatedAt?: string;
  endedAt?: string;
  reason?: string;
}

export interface TestbedScreencastManifest {
  schemaVersion: 1;
  kind: "testbed_live_screencast";
  missionId: string;
  status: "running" | "ended";
  contentType: "image/jpeg";
  frameCount: number;
  latestFrame: string;
  updatedAt: string;
  endedAt?: string;
  reason?: string;
}

export interface TestbedLiveScreencastController {
  stop: (reason?: string) => Promise<void>;
}

let manifestWriteSequence = 0;

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_MAX_FRAMES = 240;
const DEFAULT_JPEG_QUALITY = 45;

export function parseTestbedLiveScreencastConfig(
  env: NodeJS.ProcessEnv = process.env
): TestbedLiveScreencastConfig {
  return {
    enabled: env.TESTBED_MISSION_LIVE_SCREENCAST_ENABLED === "1" || env.TESTBED_MISSION_LIVE_SCREENCAST_ENABLED === "true",
    intervalMs: boundedInt(env.TESTBED_MISSION_LIVE_SCREENCAST_INTERVAL_MS, DEFAULT_INTERVAL_MS, 250, 5_000),
    maxFrames: boundedInt(env.TESTBED_MISSION_LIVE_SCREENCAST_MAX_FRAMES, DEFAULT_MAX_FRAMES, 1, 1_000),
    jpegQuality: boundedInt(env.TESTBED_MISSION_LIVE_SCREENCAST_JPEG_QUALITY, DEFAULT_JPEG_QUALITY, 20, 80),
  };
}

export function liveScreencastAllowedForMission(
  mission: Pick<TestbedMissionRun, "environment" | "targetUrl">,
  config: TestbedLiveScreencastConfig,
): { ok: true } | { ok: false; reason: string } {
  if (!config.enabled) return { ok: false, reason: "live_screencast_disabled" };
  if (mission.environment !== "testnet") return { ok: false, reason: "live_screencast_testnet_only" };
  if (urlContainsCredential(mission.targetUrl)) return { ok: false, reason: "live_screencast_target_url_contains_credentials" };
  return { ok: true };
}

export function screencastArtifactsDir(artifactsRoot: string, missionId: string): string {
  return join(artifactsRoot, missionId, "live-screencast");
}

export function screencastManifestPath(artifactsRoot: string, missionId: string): string {
  return join(screencastArtifactsDir(artifactsRoot, missionId), "manifest.json");
}

export function screencastLatestFramePath(artifactsRoot: string, missionId: string): string {
  return join(screencastArtifactsDir(artifactsRoot, missionId), "latest.jpg");
}

export async function readTestbedScreencastManifest(
  artifactsRoot: string,
  missionId: string,
): Promise<TestbedScreencastManifest | undefined> {
  const text = await readFile(screencastManifestPath(artifactsRoot, missionId), "utf8").catch(() => undefined);
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isTestbedScreencastManifest(parsed) ? parsed : undefined;
}

export async function startPlaywrightLiveScreencast(input: {
  mission: TestbedMissionRun;
  page: Page;
  artifactsRoot: string;
  config: TestbedLiveScreencastConfig;
  update: (state: TestbedLiveScreencastState) => void;
  now?: () => Date;
}): Promise<TestbedLiveScreencastController | undefined> {
  const allowed = liveScreencastAllowedForMission(input.mission, input.config);
  if (!allowed.ok) {
    input.update({
      status: "unavailable",
      reason: allowed.reason,
      updatedAt: (input.now?.() ?? new Date()).toISOString(),
    });
    return undefined;
  }

  const dir = screencastArtifactsDir(input.artifactsRoot, input.mission.id);
  await mkdir(dir, { recursive: true });
  const latestFramePath = screencastLatestFramePath(input.artifactsRoot, input.mission.id);
  const startedAt = (input.now?.() ?? new Date()).toISOString();
  const streamUrl = `/monitor/testbed-missions/${encodeURIComponent(input.mission.id)}/screencast`;
  const latestFrameUrl = `${streamUrl}/latest.jpg`;
  /** No further frames will be captured or scheduled. */
  let stopped = false;
  /** A terminal ("ended") manifest has already been published. */
  let terminated = false;
  let frameCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Settles when the capture started by the last fired timer has finished writing. */
  let inFlightCapture: Promise<void> = Promise.resolve();
  let manifestWrites: Promise<void> = Promise.resolve();
  let stopRequest: Promise<void> | undefined;

  const publishState = (state: Omit<TestbedLiveScreencastState, "streamUrl" | "latestFrameUrl">) => {
    input.update({
      ...state,
      streamUrl,
      latestFrameUrl,
    });
  };

  // Manifest writes are serialized so the file on disk always ends up matching
  // the last state we published, in publish order.
  const queueManifestWrite = (state: {
    status: "running" | "ended";
    frameCount: number;
    updatedAt: string;
    endedAt?: string;
    reason?: string;
  }): Promise<void> => {
    const write = manifestWrites.then(() => writeManifest({
      ...state,
      missionId: input.mission.id,
      artifactsRoot: input.artifactsRoot,
    }));
    manifestWrites = write.catch(() => undefined);
    return write;
  };

  const capture = async () => {
    if (stopped) return;
    const now = (input.now?.() ?? new Date()).toISOString();
    if (frameCount >= input.config.maxFrames) {
      stopped = true;
      terminated = true;
      await queueManifestWrite({
        status: "ended",
        frameCount,
        updatedAt: now,
        endedAt: now,
        reason: "max_frames_reached",
      }).catch(() => undefined);
      publishState({ status: "ended", frameCount, updatedAt: now, endedAt: now, reason: "max_frames_reached" });
      return;
    }
    const url = input.page.url();
    if (urlContainsCredential(url) || !isCaptureablePageUrl(url)) {
      publishState({ status: "running", frameCount, startedAt, updatedAt: now, reason: "redacted_non_page_frame" });
      schedule();
      return;
    }
    try {
      await input.page.screenshot({
        path: latestFramePath,
        type: "jpeg",
        quality: input.config.jpegQuality,
        fullPage: false,
        animations: "disabled",
      });
      frameCount += 1;
      await queueManifestWrite({ status: "running", frameCount, updatedAt: now });
      publishState({ status: "running", frameCount, startedAt, updatedAt: now });
    } catch {
      publishState({ status: "running", frameCount, startedAt, updatedAt: now, reason: "frame_capture_failed" });
    }
    schedule();
  };

  const schedule = () => {
    if (stopped) return;
    // Captures are strictly sequential: the next one is only scheduled once the
    // previous has settled, so tracking the latest is enough for stop() to know
    // whether a capture is still writing.
    timer = setTimeout(() => {
      inFlightCapture = capture().catch(() => undefined);
    }, input.config.intervalMs);
    timer.unref?.();
  };

  const stopStream = async (reason: string): Promise<void> => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    // A capture that started before stop() can still be mid-write. Let it settle
    // first so the terminal manifest below is the last write to land on disk.
    await inFlightCapture;
    if (terminated) return;
    terminated = true;
    const now = (input.now?.() ?? new Date()).toISOString();
    await queueManifestWrite({ status: "ended", frameCount, updatedAt: now, endedAt: now, reason }).catch(() => undefined);
    publishState({ status: "ended", frameCount, startedAt, updatedAt: now, endedAt: now, reason });
  };

  publishState({ status: "running", frameCount: 0, startedAt, updatedAt: startedAt });
  schedule();

  return {
    stop(reason = "mission_finished") {
      // Repeat callers await the same shutdown rather than returning before the
      // terminal manifest has been written.
      stopRequest ??= stopStream(reason);
      return stopRequest;
    },
  };
}

async function writeManifest(input: {
  missionId: string;
  status: "running" | "ended";
  frameCount: number;
  updatedAt: string;
  endedAt?: string;
  reason?: string;
  artifactsRoot: string;
}): Promise<void> {
  const manifest: TestbedScreencastManifest = {
    schemaVersion: 1,
    kind: "testbed_live_screencast",
    missionId: input.missionId,
    status: input.status,
    contentType: "image/jpeg",
    frameCount: input.frameCount,
    latestFrame: "latest.jpg",
    updatedAt: input.updatedAt,
    ...(input.endedAt ? { endedAt: input.endedAt } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
  };
  // Publish atomically: readers (the monitor routes, tests) must never observe a
  // truncated manifest, which is what a plain overwrite exposes mid-write.
  const path = screencastManifestPath(input.artifactsRoot, input.missionId);
  manifestWriteSequence += 1;
  const tempPath = `${path}.${process.pid}.${manifestWriteSequence}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function isCaptureablePageUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function urlContainsCredential(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function isTestbedScreencastManifest(value: unknown): value is TestbedScreencastManifest {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as TestbedScreencastManifest).schemaVersion === 1 &&
    (value as TestbedScreencastManifest).kind === "testbed_live_screencast" &&
    typeof (value as TestbedScreencastManifest).missionId === "string" &&
    ((value as TestbedScreencastManifest).status === "running" || (value as TestbedScreencastManifest).status === "ended") &&
    typeof (value as TestbedScreencastManifest).frameCount === "number" &&
    typeof (value as TestbedScreencastManifest).latestFrame === "string" &&
    typeof (value as TestbedScreencastManifest).updatedAt === "string"
  );
}
