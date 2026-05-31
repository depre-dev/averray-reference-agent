import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveAutonomyState,
  readAutonomyState,
  isAutopilotEngaged,
  setAutonomyMode,
  expireAutonomyIfDue,
  AUTOPILOT_SAFETY_CAP_MS,
  type AutonomyState,
} from "../../services/slack-operator/src/autonomy-mode.js";

const T0 = Date.parse("2026-05-31T09:00:00.000Z");
const HOUR = 3_600_000;
const clock = (ms: number) => () => new Date(ms);

describe("resolveAutonomyState — pure clock resolution (fail-safe to supervised)", () => {
  it("supervised stays supervised", () => {
    expect(resolveAutonomyState({ mode: "supervised" }, T0)).toEqual({ mode: "supervised" });
  });
  it("undefined → supervised", () => {
    expect(resolveAutonomyState(undefined, T0).mode).toBe("supervised");
  });
  it("autopilot with a future until is active", () => {
    const s: AutonomyState = { mode: "autopilot", until: new Date(T0 + HOUR).toISOString() };
    expect(resolveAutonomyState(s, T0)).toEqual(s);
  });
  it("autopilot with an expired until → supervised", () => {
    const s: AutonomyState = { mode: "autopilot", until: new Date(T0 - 1).toISOString() };
    expect(resolveAutonomyState(s, T0).mode).toBe("supervised");
  });
  it("autopilot WITHOUT until → supervised (never lingers open-ended in storage)", () => {
    expect(resolveAutonomyState({ mode: "autopilot" }, T0).mode).toBe("supervised");
  });
});

describe("autonomy-mode — file-backed state (temp dir, injected clock)", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "averray-autonomy-"));
    path = join(dir, "autonomy-mode.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults to supervised when no file exists", () => {
    expect(readAutonomyState(clock(T0), path)).toEqual({ mode: "supervised" });
    expect(isAutopilotEngaged(clock(T0), path)).toBe(false);
  });

  it("setting autopilot with a stated time persists + engages, and survives a re-read", () => {
    const untilMs = T0 + 2 * HOUR;
    const state = setAutonomyMode({ mode: "autopilot", untilMs, setBy: "operator" }, clock(T0), path);
    expect(state.mode).toBe("autopilot");
    expect(state.until).toBe(new Date(untilMs).toISOString());
    expect(existsSync(path)).toBe(true);
    expect(isAutopilotEngaged(clock(T0 + HOUR), path)).toBe(true); // still within window
  });

  it("open-ended autopilot gets the now+4h safety cap", () => {
    const state = setAutonomyMode({ mode: "autopilot", setBy: "operator" }, clock(T0), path);
    expect(state.until).toBe(new Date(T0 + AUTOPILOT_SAFETY_CAP_MS).toISOString());
  });

  it("a past untilMs is rejected in favor of the 4h cap (no instantly-expired autopilot)", () => {
    const state = setAutonomyMode({ mode: "autopilot", untilMs: T0 - HOUR }, clock(T0), path);
    expect(state.until).toBe(new Date(T0 + AUTOPILOT_SAFETY_CAP_MS).toISOString());
  });

  it("a stated time beyond 4h is honored (the operator's explicit window)", () => {
    const untilMs = T0 + 8 * HOUR;
    const state = setAutonomyMode({ mode: "autopilot", untilMs }, clock(T0), path);
    expect(state.until).toBe(new Date(untilMs).toISOString());
  });

  it("lazy-expires: autopilot reads as supervised once the window passes", () => {
    setAutonomyMode({ mode: "autopilot", untilMs: T0 + HOUR }, clock(T0), path);
    expect(isAutopilotEngaged(clock(T0 + 30 * 60_000), path)).toBe(true);  // 30m in
    expect(isAutopilotEngaged(clock(T0 + 2 * HOUR), path)).toBe(false);    // past window
  });

  it("setting supervised clears the window", () => {
    setAutonomyMode({ mode: "autopilot", untilMs: T0 + HOUR }, clock(T0), path);
    const state = setAutonomyMode({ mode: "supervised", setBy: "operator" }, clock(T0 + 5 * 60_000), path);
    expect(state.mode).toBe("supervised");
    expect(state.until).toBeUndefined();
    expect(isAutopilotEngaged(clock(T0 + 5 * 60_000), path)).toBe(false);
  });

  it("a corrupt state file reads as supervised (never throws, never auto-engages)", async () => {
    await writeFile(path, "{ not json");
    expect(isAutopilotEngaged(clock(T0), path)).toBe(false);
  });
});

describe("expireAutonomyIfDue — one-shot revert + alert hook", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "averray-autonomy-exp-"));
    path = join(dir, "autonomy-mode.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("no-op while autopilot is still within its window", () => {
    setAutonomyMode({ mode: "autopilot", untilMs: T0 + HOUR }, clock(T0), path);
    expect(expireAutonomyIfDue(clock(T0 + 30 * 60_000), path)).toEqual({ expired: false });
  });

  it("no-op when already supervised", () => {
    expect(expireAutonomyIfDue(clock(T0), path)).toEqual({ expired: false });
  });

  it("fires exactly once on the transition, then persists supervised", async () => {
    setAutonomyMode({ mode: "autopilot", untilMs: T0 + HOUR }, clock(T0), path);
    const first = expireAutonomyIfDue(clock(T0 + 2 * HOUR), path);
    expect(first.expired).toBe(true);
    expect(first.previous?.mode).toBe("autopilot");
    // Second call after the revert is a no-op (the alert won't double-fire).
    expect(expireAutonomyIfDue(clock(T0 + 3 * HOUR), path)).toEqual({ expired: false });
    const persisted = JSON.parse(await readFile(path, "utf8")) as AutonomyState;
    expect(persisted.mode).toBe("supervised");
  });
});
