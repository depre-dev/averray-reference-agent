// Hermes Handoff Monitor — collaboration feed types + helpers (M8').
//
// The co-pilot rail renders the operator ↔ Hermes ↔ Codex/Claude collaboration
// feed served by slack-operator's /monitor/collaboration. This is the
// frontend's copy of the contract (they cross an HTTP/JSON boundary, so
// the declarations are intentionally independent, like card-types.ts).

import type { BoardCard } from "./card-types.js";

export type CollaborationAuthor = "claude" | "codex" | "test-writer" | "security" | "docs" | "hermes" | "operator" | "system";
export type CollaborationKind = "chat" | "proposal" | "request_help" | "status";
export type CollaborationTarget = "everyone" | "claude" | "codex" | "test-writer" | "security" | "docs" | "hermes" | "operator";
export type HermesReplyMode = "live" | "templated";

export interface CollaborationRelatedPr {
  repo: string;
  number: number;
}

export interface CollaborationRelatedMission {
  id: string;
}

export interface CollaborationMessage {
  id: string;
  ts: number;
  author: CollaborationAuthor;
  kind: CollaborationKind;
  text: string;
  addressedTo: CollaborationTarget;
  hermesMode?: HermesReplyMode;
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
  /**
   * True while this Hermes turn is still receiving live tokens over the
   * co-pilot SSE (feature #3). Set only on the in-progress streaming turn so the
   * UI can show a "streaming…" affordance; cleared when the terminal
   * `hermes.turn.completed` finalizes the text. Absent for polled/templated
   * turns, which render exactly as before.
   */
  streaming?: boolean;
}

// --- co-pilot live-token stream (feature #3) --------------------------------
// The frontend's copy of the SSE event contract broadcast by slack-operator's
// board stream while a co-pilot Hermes reply streams. Independent of the
// backend declaration by design (they cross an HTTP/SSE boundary).

/** Incremental token for an in-progress co-pilot Hermes turn (`hermes.delta`). */
export interface CopilotDeltaEvent {
  turnId: string;
  delta: string;
  addressedTo?: CollaborationTarget;
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

/** Terminal event for a co-pilot Hermes turn (`hermes.turn.completed`). */
export interface CopilotTurnCompletedEvent {
  turnId: string;
  text: string;
  hermesMode?: HermesReplyMode;
  addressedTo?: CollaborationTarget;
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

export type CopilotStreamEvent =
  | { type: "hermes.delta"; payload: CopilotDeltaEvent }
  | { type: "hermes.turn.completed"; payload: CopilotTurnCompletedEvent };

/**
 * Subscribe to co-pilot live-token events. Returns an unsubscribe fn. The
 * default implementation (in the hook) is EventSource-backed against the board
 * SSE; tests inject a synchronous stub. A no-op source (returns a no-op
 * unsubscribe and never calls the handler) keeps the rail on the poll path.
 */
export type CopilotStreamSource = (
  onEvent: (event: CopilotStreamEvent) => void,
) => () => void;

export interface ReviewRequest {
  id: string;
  relatedPr?: CollaborationRelatedPr;
  relatedMission?: CollaborationRelatedMission;
  correlationId?: string;
  requestedBy: Exclude<CollaborationAuthor, "system">;
  reviewer: Exclude<CollaborationTarget, "everyone">;
  reason: string;
  status: "requested" | "responded" | "cancelled";
  createdAt: string;
  updatedAt: string;
}

/** Display name for a turn's author (operator → "Pascal", else the role). */
export function actorLabel(author: CollaborationAuthor): string {
  if (author === "hermes") return "Hermes";
  if (author === "operator") return "Pascal";
  if (author === "claude") return "Claude";
  if (author === "test-writer") return "Test-writer";
  if (author === "security") return "Security";
  if (author === "docs") return "Docs";
  if (author === "codex") return "Codex";
  return "System";
}

/** Display name for a concrete collaboration turn, including Hermes reply provenance. */
export function actorLabelForMessage(message: Pick<CollaborationMessage, "author" | "hermesMode">): string {
  if (message.author !== "hermes") return actorLabel(message.author);
  if (message.hermesMode === "live") return "Hermes (live)";
  if (message.hermesMode === "templated") return "Hermes (offline — templated)";
  return "Hermes";
}

/** Short clock label (HH:MM) for a turn timestamp. */
export function formatTurnTime(ts: number, now: () => number = Date.now): string {
  const ms = Number.isFinite(ts) ? ts : now();
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Scope a Hermes question to a focused card. Only cards with a `#<number>`
 * identity (PRs, deploys, ext) map to a relatedPr; missions and Codex
 * tasks have no PR number, so a question about them is board-scoped.
 */
export function relatedPrForCard(card: BoardCard | undefined | null): CollaborationRelatedPr | undefined {
  if (!card || typeof card.repo !== "string" || !card.repo) return undefined;
  const m = /#(\d+)/.exec(card.id);
  if (!m) return undefined;
  const number = Number.parseInt(m[1] as string, 10);
  return Number.isFinite(number) ? { repo: card.repo, number } : undefined;
}
