// Hermes Handoff Monitor — pure cache-patching for live updates.
//
// `applyEventToBoard(prev, event)` takes the current board snapshot +
// a single MonitorEvent and returns a NEW snapshot with the event
// applied. Used by the SWR hook to patch the cache without a full
// refetch when SSE events arrive. Never mutates the input.

import type { BoardCard, Lane } from "./card-types.js";

export interface MonitorBoard {
  cards: BoardCard[];
  /** ISO timestamp from the server */
  at: string;
}

export interface MonitorEvent {
  type: string;
  [key: string]: unknown;
}

export function applyEventToBoard(
  prev: MonitorBoard | undefined,
  event: MonitorEvent | null | undefined
): MonitorBoard | undefined {
  if (!event || typeof event.type !== "string") return prev;
  switch (event.type) {
    case "board.snapshot": {
      const cards = Array.isArray(event.cards) ? (event.cards as BoardCard[]) : [];
      const at = typeof event.at === "string" ? event.at : new Date().toISOString();
      return { cards, at };
    }
    case "board.card.added": {
      if (!prev) return prev;
      const card = event.card as BoardCard | undefined;
      if (!card?.id) return prev;
      const idx = prev.cards.findIndex((c) => c.id === card.id);
      if (idx >= 0) {
        const next = prev.cards.slice();
        next[idx] = card;
        return { cards: next, at: typeof event.at === "string" ? event.at : prev.at };
      }
      return { cards: [...prev.cards, card], at: typeof event.at === "string" ? event.at : prev.at };
    }
    case "board.card.updated": {
      if (!prev) return prev;
      const id = event.id as string | undefined;
      if (!id) return prev;
      const partial = (event.partial ?? {}) as Partial<BoardCard>;
      const idx = prev.cards.findIndex((c) => c.id === id);
      if (idx < 0) return prev;
      const next = prev.cards.slice();
      next[idx] = { ...next[idx], ...partial, id } as BoardCard;
      return { cards: next, at: typeof event.at === "string" ? event.at : prev.at };
    }
    case "board.card.moved": {
      if (!prev) return prev;
      const id = event.id as string | undefined;
      const toLane = event.toLane as Lane | undefined;
      if (!id || !toLane) return prev;
      const idx = prev.cards.findIndex((c) => c.id === id);
      if (idx < 0) return prev;
      const next = prev.cards.slice();
      next[idx] = { ...next[idx], lane: toLane } as BoardCard;
      return { cards: next, at: typeof event.at === "string" ? event.at : prev.at };
    }
    case "board.card.archived": {
      if (!prev) return prev;
      const id = event.id as string | undefined;
      if (!id) return prev;
      return {
        cards: prev.cards.filter((c) => c.id !== id),
        at: typeof event.at === "string" ? event.at : prev.at,
      };
    }
    case "stream.keepalive":
      // Keepalive doesn't change the cache; UI surfaces it via streamStatus.
      return prev;
    default:
      return prev;
  }
}
