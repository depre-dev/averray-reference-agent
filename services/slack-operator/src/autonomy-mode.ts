// O4-PR3a — autonomy mode: the master control for autopilot.
//
// Default is "supervised": Hermes proposes, the operator approves. Setting
// "autopilot" is an explicit operator action (board switch or NL command) that
// delegates approval to Hermes WITHIN the guardrail — and only until a stated
// time, else a `now + 4h` safety cap so a forgotten autopilot can't run forever.
//
// This module owns the mode STATE + the expiry. It is harmless on its own: the
// auto-approval that READS this state ships in PR3b (isAutopilotEngaged is the
// gate). Persisted on the shared /data volume so the mode SURVIVES a restart —
// a restart must not silently drop the operator into (or out of) autopilot
// without the expiry being honored.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { optionalEnv } from "@avg/mcp-common";

export type AutonomyMode = "supervised" | "autopilot";

export interface AutonomyState {
  mode: AutonomyMode;
  /** ISO; autopilot reverts to supervised at/after this. Always set in autopilot. */
  until?: string;
  /** Who set the mode (operator id / "monitor" / NL author), for the audit. */
  setBy?: string;
  /** ISO timestamp the mode was set. */
  setAt?: string;
}

/** A forgotten autopilot can't run forever: the default end-of-autopilot cap. */
export const AUTOPILOT_SAFETY_CAP_MS = 4 * 60 * 60 * 1000;

const SUPERVISED: AutonomyState = { mode: "supervised" };

function statePath(path?: string): string {
  return (
    path ??
    optionalEnv("AVERRAY_AUTONOMY_MODE_PATH", "/data/autonomy-mode.json") ??
    "/data/autonomy-mode.json"
  );
}

/**
 * Pure: resolve the stored state against the clock. Autopilot is ACTIVE only
 * while it has a valid future `until`; an expired or missing `until` resolves
 * to supervised (fail-safe — autopilot never lingers past its window).
 */
export function resolveAutonomyState(raw: AutonomyState | undefined, nowMs: number): AutonomyState {
  if (!raw || raw.mode !== "autopilot") return SUPERVISED;
  const untilMs = raw.until ? Date.parse(raw.until) : NaN;
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return SUPERVISED;
  return raw;
}

function readRawState(path?: string): AutonomyState | undefined {
  const p = statePath(path);
  try {
    if (!existsSync(p)) return undefined;
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<AutonomyState>;
    const mode: AutonomyMode = raw.mode === "autopilot" ? "autopilot" : "supervised";
    return {
      mode,
      ...(raw.until ? { until: raw.until } : {}),
      ...(raw.setBy ? { setBy: raw.setBy } : {}),
      ...(raw.setAt ? { setAt: raw.setAt } : {}),
    };
  } catch {
    // Unreadable state: fail safe to supervised (autopilot never engages on a
    // corrupt file). Never throw from a read.
    return undefined;
  }
}

/** The current, clock-resolved mode. Lazy-expires autopilot to supervised. */
export function readAutonomyState(now: () => Date = () => new Date(), path?: string): AutonomyState {
  return resolveAutonomyState(readRawState(path), now().getTime());
}

/** The gate PR3b's auto-approval reads: is autopilot engaged right now? */
export function isAutopilotEngaged(now: () => Date = () => new Date(), path?: string): boolean {
  return readAutonomyState(now, path).mode === "autopilot";
}

function writeState(state: AutonomyState, path?: string): void {
  const p = statePath(path);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Set the mode. Supervised clears any window. Autopilot ALWAYS gets a bounded
 * `until`: a stated time is honored; an absent/past time falls back to the
 * `now + 4h` safety cap. Returns the persisted state.
 */
export function setAutonomyMode(
  input: { mode: AutonomyMode; untilMs?: number; setBy?: string },
  now: () => Date = () => new Date(),
  path?: string,
): AutonomyState {
  const nowMs = now().getTime();
  const setAt = new Date(nowMs).toISOString();
  if (input.mode !== "autopilot") {
    const state: AutonomyState = { mode: "supervised", setAt, ...(input.setBy ? { setBy: input.setBy } : {}) };
    writeState(state, path);
    return state;
  }
  const requested = typeof input.untilMs === "number" && Number.isFinite(input.untilMs) ? input.untilMs : NaN;
  // Honor a stated future time; otherwise (absent or already-past) cap at now+4h.
  const untilMs = Number.isFinite(requested) && requested > nowMs ? requested : nowMs + AUTOPILOT_SAFETY_CAP_MS;
  const state: AutonomyState = {
    mode: "autopilot",
    until: new Date(untilMs).toISOString(),
    setAt,
    ...(input.setBy ? { setBy: input.setBy } : {}),
  };
  writeState(state, path);
  return state;
}

/**
 * Expire autopilot if its window has passed. Idempotent: returns
 * `{ expired: true, previous }` exactly on the transition (stored autopilot →
 * resolves supervised), persisting supervised so the caller can alert ONCE.
 * Returns `{ expired: false }` otherwise.
 */
export function expireAutonomyIfDue(
  now: () => Date = () => new Date(),
  path?: string,
): { expired: boolean; previous?: AutonomyState } {
  const raw = readRawState(path);
  if (!raw || raw.mode !== "autopilot") return { expired: false };
  const resolved = resolveAutonomyState(raw, now().getTime());
  if (resolved.mode === "autopilot") return { expired: false };
  // Stored autopilot has lapsed: persist the revert so this fires only once.
  writeState({ mode: "supervised", setAt: now().toISOString(), setBy: "autopilot-expiry" }, path);
  return { expired: true, previous: raw };
}
