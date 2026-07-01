// Hermes Handoff Monitor — co-pilot live-token event bus (feature #3).
//
// A tiny in-process pub/sub that carries the co-pilot's live Hermes reply
// tokens from the reply handler to every open board SSE connection, mirroring
// the `onDebugCardSpawned` idiom in monitor-v2-debug.ts. The reply handler
// emits `hermes.delta` per streamed token and a terminal `hermes.turn.completed`
// when the turn resolves; `writeMonitorV2Stream` subscribes and forwards each
// event to the browser via the existing SSE writer.
//
// FLAG-GATED + DEGRADED-SAFE: the handler only emits when
// `HERMES_COPILOT_STREAMING` is truthy AND a gateway session config resolves.
// When streaming is off, or the stream fails, nothing is emitted here and the
// co-pilot behaves exactly as today (a single templated/sync reply lands on the
// next collaboration poll). No fake tokens are ever synthesized.

import type { CollaborationRelatedPr } from "./monitor-collab.js";

/** An incremental token for an in-progress co-pilot Hermes turn. */
export interface CopilotDeltaEvent {
  /** Stable id correlating every delta + the terminal event for one turn. */
  turnId: string;
  /** The token text to append to the in-progress turn. */
  delta: string;
  addressedTo: string;
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

/** The terminal event for a co-pilot Hermes turn: the authoritative full text. */
export interface CopilotTurnCompletedEvent {
  turnId: string;
  /** Full reply text (post-processed), authoritative over the accumulated deltas. */
  text: string;
  addressedTo: string;
  /**
   * The turn's authoritative provenance. Usually "live" (the streamed reply
   * completed), but "templated" when the gateway failed mid-stream and the
   * co-pilot fell back to a canned reply — the frontend then finalizes the
   * in-progress bubble honestly instead of leaving a stuck live badge.
   */
  hermesMode: "live" | "templated";
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

export type CopilotStreamEvent =
  | { type: "hermes.delta"; payload: CopilotDeltaEvent }
  | { type: "hermes.turn.completed"; payload: CopilotTurnCompletedEvent };

const subscribers = new Set<(event: CopilotStreamEvent) => void>();

/** Subscribe an SSE connection to co-pilot stream events. Returns an unsubscribe fn. */
export function onCopilotStreamEvent(fn: (event: CopilotStreamEvent) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** Broadcast one co-pilot stream event to every open SSE connection (best-effort). */
export function emitCopilotStreamEvent(event: CopilotStreamEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch {
      // A throwing subscriber (e.g. a dead SSE socket) must never break the
      // reply handler or the other subscribers.
    }
  }
}

/** Test/introspection helper: number of currently subscribed SSE connections. */
export function copilotStreamSubscriberCount(): number {
  return subscribers.size;
}
