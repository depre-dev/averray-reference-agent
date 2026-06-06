// Hermes-4 rail digest (PR-D3d).
//
// The "Hermes digest" at the top of the rail — a glanceable summary of board
// state. Only the figures we can compute from REAL board cards are emitted as
// numbers; session-relative deltas (since-you-last-looked, prod changes) need a
// backend session signal we don't have, so they're surfaced as honest
// awaiting-data, never a fabricated count. Pure + deterministic.

import type { BoardCard } from "./card-types.js";
import { isWaitingOnOperator } from "./lane-rules.js";

export interface RailDigestCounts {
  /** Cards awaiting the operator's decision (the DECIDE inbox). */
  needsYou: number;
  /** Cards with real in-flight work right now. */
  running: number;
}

function isRunning(card: BoardCard): boolean {
  if (card.state === "running") return true;
  const missionStatus = (card as { missionStatus?: string }).missionStatus;
  if (missionStatus === "running") return true;
  return Boolean(card.workingNow);
}

export function railDigestCounts(cards: readonly BoardCard[]): RailDigestCounts {
  let needsYou = 0;
  let running = 0;
  for (const card of cards) {
    if (isWaitingOnOperator(card)) needsYou += 1;
    if (isRunning(card)) running += 1;
  }
  return { needsYou, running };
}
