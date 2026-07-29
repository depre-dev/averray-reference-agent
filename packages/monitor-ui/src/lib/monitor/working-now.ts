// What a running agent is actually attempting — the readable half of
// `workingNow`.
//
// `label` ("Claude fixing") only ever said that SOME agent was busy. The task
// record already carried what it was asked to do and what the runner last
// reported; this turns those into something an operator can read at a glance,
// and — the part that matters — ages the progress line instead of letting a
// forty-minute-old step sit on the board looking live.
//
// Truth boundary: every field here is passed through from the payload. When a
// signal is missing this says so rather than filling the gap. "No step reported
// yet" is a real state; inventing activity to fill the line would be the same
// fake-green as a full meter on an empty pool.

import type { CardWorkingNow } from "./card-types.js";

/**
 * How long a running agent may go without reporting a step before the board
 * stops presenting that step as current.
 *
 * The runner throttles progress writes to one per 2s and emits on every
 * assistant event (including each tool call), so healthy gaps are seconds.
 * Ten minutes is well clear of a slow test run or a long edit while still
 * catching a runner that died without updating its task status.
 */
export const WORKING_NOW_STALE_MS = 10 * 60 * 1000;

export interface WorkingNowView {
  /** What it was asked to do. Absent when the task carried no title or prompt. */
  intent?: string;
  /** The last reported step, verbatim. Absent when nothing has been reported. */
  progress?: string;
  /** Age of that step, e.g. "14m ago". Absent when it carried no timestamp. */
  progressAge?: string;
  /**
   * True when the last step is older than WORKING_NOW_STALE_MS. A statement of
   * fact about the data, NOT a diagnosis — the agent may be mid-way through
   * something long. The UI tones it down; it must not claim the agent is stuck.
   */
  stale: boolean;
  /** Copy for when the runner has reported nothing yet. */
  emptyNote?: string;
}

/**
 * Project the readable view. Pure: takes `nowMs` rather than reading the clock,
 * so the staleness boundary is testable.
 */
export function describeWorkingNow(
  workingNow: CardWorkingNow | undefined,
  nowMs: number,
): WorkingNowView | undefined {
  if (!workingNow) return undefined;
  const intent = nonEmpty(workingNow.intent);
  const progress = nonEmpty(workingNow.progress);
  if (!progress) {
    return {
      ...(intent ? { intent } : {}),
      stale: false,
      emptyNote: "No step reported yet.",
    };
  }
  const at = parseTime(workingNow.progressAt);
  // No timestamp ⇒ we cannot age it, so we must not imply it is current. Show
  // the step without an age and leave it untoned rather than guessing.
  if (at === undefined) {
    return { ...(intent ? { intent } : {}), progress, stale: false };
  }
  const elapsed = Math.max(0, nowMs - at);
  return {
    ...(intent ? { intent } : {}),
    progress,
    progressAge: formatAge(elapsed),
    stale: elapsed >= WORKING_NOW_STALE_MS,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Coarse, glanceable ages — "just now", "4m ago", "2h ago", "3d ago". */
function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
