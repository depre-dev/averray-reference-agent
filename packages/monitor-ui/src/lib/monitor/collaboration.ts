// Hermes Handoff Monitor — collaboration feed types + helpers (M8').
//
// The co-pilot rail renders the operator ↔ Hermes ↔ Codex collaboration
// feed served by slack-operator's /monitor/collaboration. This is the
// frontend's copy of the contract (they cross an HTTP/JSON boundary, so
// the declarations are intentionally independent, like card-types.ts).

import type { BoardCard } from "./card-types.js";

export type CollaborationAuthor = "codex" | "hermes" | "operator" | "system";
export type CollaborationKind = "chat" | "proposal" | "request_help" | "status";
export type CollaborationTarget = "everyone" | "codex" | "hermes" | "operator";

export interface CollaborationRelatedPr {
  repo: string;
  number: number;
}

export interface CollaborationMessage {
  id: string;
  ts: number;
  author: CollaborationAuthor;
  kind: CollaborationKind;
  text: string;
  addressedTo: CollaborationTarget;
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

/** Display name for a turn's author (operator → "Pascal", else the role). */
export function actorLabel(author: CollaborationAuthor): string {
  if (author === "hermes") return "Hermes";
  if (author === "operator") return "Pascal";
  if (author === "codex") return "Codex";
  return "System";
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
