// D3 — the autopilot-suspended flag.
//
// D3 OWNS this gate. It is set by the anomaly auto-pause (a soft or hard trip)
// and CLEARED only by the operator (POST /monitor/autopilot-resume). O4-PR3's
// autopilot auto-approval MUST check `!isAutopilotSuspended()` before approving
// anything — until PR3 lands the flag is simply inert.
//
// Persisted on the shared data volume so a trip SURVIVES a restart: a fail-safe
// that forgets it tripped is not a fail-safe. A hard trip also touches
// HALT_FILE (separate, also persistent).

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { optionalEnv } from "@avg/mcp-common";

export interface AutopilotSuspendState {
  suspended: boolean;
  /** Why it tripped (signal + threshold), for the board + audit. */
  reason?: string;
  signal?: string;
  tier?: "soft" | "hard";
  setAt?: string;
}

function suspendStatePath(path?: string): string {
  return (
    path ??
    optionalEnv("AVERRAY_AUTOPILOT_SUSPENDED_PATH", "/data/autopilot-suspended.json") ??
    "/data/autopilot-suspended.json"
  );
}

export function readAutopilotSuspendState(path?: string): AutopilotSuspendState {
  const p = suspendStatePath(path);
  try {
    if (!existsSync(p)) return { suspended: false };
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<AutopilotSuspendState>;
    return {
      suspended: raw.suspended === true,
      ...(raw.reason ? { reason: raw.reason } : {}),
      ...(raw.signal ? { signal: raw.signal } : {}),
      ...(raw.tier === "soft" || raw.tier === "hard" ? { tier: raw.tier } : {}),
      ...(raw.setAt ? { setAt: raw.setAt } : {}),
    };
  } catch {
    // Unreadable state: treat as not-suspended (the flag is inert until PR3, and
    // a hard trip's HALT_FILE is the real stop). Never throw from a read.
    return { suspended: false };
  }
}

/** The gate PR3's autopilot reads before auto-approving. */
export function isAutopilotSuspended(path?: string): boolean {
  return readAutopilotSuspendState(path).suspended;
}

export function setAutopilotSuspended(
  info: { reason?: string; signal?: string; tier?: "soft" | "hard"; setAt: string },
  path?: string,
): void {
  const p = suspendStatePath(path);
  mkdirSync(dirname(p), { recursive: true });
  const state: AutopilotSuspendState = { suspended: true, ...info };
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
}

/** Operator-only: clear the suspension (POST /monitor/autopilot-resume). */
export function clearAutopilotSuspended(path?: string): void {
  const p = suspendStatePath(path);
  try {
    if (existsSync(p)) rmSync(p);
  } catch {
    /* best-effort; an absent file is already "not suspended" */
  }
}
