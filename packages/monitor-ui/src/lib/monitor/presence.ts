// Hermes-4 agent-room presence (PR-D3c).
//
// Derives who's "in the room" from REAL signals the board already carries —
// never a fabricated roster:
//   - active  ← a card's `workingNow` (an agent with real in-flight work)
//   - online  ← authored a collaboration message within the recency window
// An agent with no live signal simply isn't shown (honest empty over an
// always-on roster). Pure + deterministic so it unit-tests with no clock.

import type { BoardCard } from "./card-types.js";

export type PresenceState = "active" | "online";

export interface PresencePeer {
  agent: string;
  presence: PresenceState;
  /** Optional one-liner (e.g. the workingNow label) for the tile's title. */
  detail?: string;
}

export interface PresenceInput {
  messages: ReadonlyArray<{ author?: string; ts?: number }>;
  cards: readonly BoardCard[];
  nowMs: number;
  /** How recently an author must have posted to count as "online". Default 10m. */
  onlineWindowMs?: number;
}

const DEFAULT_ONLINE_WINDOW_MS = 10 * 60_000;

export function derivePresence(input: PresenceInput): PresencePeer[] {
  const window = input.onlineWindowMs ?? DEFAULT_ONLINE_WINDOW_MS;
  const peers = new Map<string, PresencePeer>();

  // Active: an agent with real in-flight work on a card (workingNow).
  for (const card of input.cards) {
    const wn = card.workingNow;
    const agent = wn?.agent;
    if (typeof agent === "string" && agent.length > 0) {
      peers.set(agent, { agent, presence: "active", ...(wn?.label ? { detail: wn.label } : {}) });
    }
  }

  // Online: authored a collaboration message within the window — unless they're
  // already shown as active (active is the stronger signal).
  for (const message of input.messages) {
    const author = message.author;
    if (typeof author !== "string" || author.length === 0 || author === "everyone") continue;
    const existing = peers.get(author);
    if (existing?.presence === "active") continue;
    if (typeof message.ts === "number" && input.nowMs - message.ts <= window && input.nowMs - message.ts >= 0) {
      if (!peers.has(author)) peers.set(author, { agent: author, presence: "online" });
    }
  }

  // Active first, then online; stable by agent name within a tier.
  return [...peers.values()].sort((a, b) => {
    if (a.presence !== b.presence) return a.presence === "active" ? -1 : 1;
    return a.agent.localeCompare(b.agent);
  });
}

/** Count of agents actively working — the glanceable "N active" figure. */
export function activeCount(peers: readonly PresencePeer[]): number {
  return peers.filter((peer) => peer.presence === "active").length;
}
