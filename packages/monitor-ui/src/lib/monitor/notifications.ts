// Hermes Handoff Monitor — notification + mute pure logic (M9', §17/§21).
//
// The three notification tiers (in-app audio+visual, tab badge+title,
// desktop notification) all fire on the same trigger: the action-needed
// count crossing 0 → >0. This module owns the framework-free decisions —
// when to alert, the title string, and the mute schedule — so the React
// orchestrator (useActionAlerts) stays thin and the contract is tested.

import type { StorageLike } from "./snapshot-store.js";

export const DEFAULT_TITLE = "Hermes — Averray";
export const MUTE_STORAGE_KEY = "monitor.mute.until";

/** Tab title: "(N) Hermes — Averray" when action is needed, else the base. */
export function documentTitleFor(actionCount: number, base: string = DEFAULT_TITLE): string {
  const n = Number.isFinite(actionCount) && actionCount > 0 ? Math.floor(actionCount) : 0;
  return n > 0 ? `(${n}) ${base}` : base;
}

/** Alert only on the 0 → >0 edge (the moment the operator newly must act). */
export function shouldAlert(prev: number, next: number): boolean {
  const p = Number.isFinite(prev) ? prev : 0;
  const n = Number.isFinite(next) ? next : 0;
  return p <= 0 && n > 0;
}

export type ParsedMute = { ok: true; untilMs: number } | { ok: false; error: string };

/**
 * Parse a mute argument into an absolute expiry timestamp.
 *   ""              → 1 hour (the bare /mute default)
 *   "30m" / "2h"    → relative duration
 *   "9am" / "until 9am" / "14:30" → the next occurrence of that clock time
 */
export function parseMuteArg(arg: string, now: () => number = Date.now): ParsedMute {
  const text = (arg ?? "").trim().toLowerCase();
  if (!text) return { ok: true, untilMs: now() + 60 * 60 * 1000 };

  const dur = /^(\d+)\s*(m|min|mins|h|hr|hrs|hour|hours)$/.exec(text);
  if (dur) {
    const n = Number.parseInt(dur[1] as string, 10);
    if (n <= 0) return { ok: false, error: `"${arg}" must be a positive duration.` };
    const ms = (dur[2] as string).startsWith("m") ? n * 60_000 : n * 3_600_000;
    return { ok: true, untilMs: now() + ms };
  }

  const clock = /^(?:until\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (clock) {
    let hour = Number.parseInt(clock[1] as string, 10);
    const min = clock[2] ? Number.parseInt(clock[2], 10) : 0;
    const ap = clock[3];
    if (ap === "pm" && hour < 12) hour += 12;
    if (ap === "am" && hour === 12) hour = 0;
    if (hour > 23 || min > 59) return { ok: false, error: `"${arg}" is not a valid time.` };
    const nowMs = now();
    const d = new Date(nowMs);
    d.setHours(hour, min, 0, 0);
    let untilMs = d.getTime();
    if (untilMs <= nowMs) untilMs += 24 * 60 * 60 * 1000;
    return { ok: true, untilMs };
  }

  return { ok: false, error: `Couldn't parse mute "${arg}". Try "/mute 1h" or "/mute until 9am".` };
}

/** Is the operator currently muted? */
export function isMuted(untilMs: number | null | undefined, now: () => number = Date.now): boolean {
  return typeof untilMs === "number" && untilMs > now();
}

/** Read the persisted mute expiry (ms), or null. */
export function readMuteUntil(storage: StorageLike): number | null {
  const raw = storage.getItem(MUTE_STORAGE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Persist (or clear, with null) the mute expiry. */
export function writeMuteUntil(storage: StorageLike, untilMs: number | null): void {
  try {
    if (untilMs == null) storage.removeItem(MUTE_STORAGE_KEY);
    else storage.setItem(MUTE_STORAGE_KEY, String(untilMs));
  } catch {
    /* best-effort persistence */
  }
}
