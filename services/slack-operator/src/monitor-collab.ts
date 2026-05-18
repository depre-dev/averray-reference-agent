/**
 * In-memory collaboration channel for the Hermes Handoff Monitor.
 *
 * The existing monitor thread is a *derived* view — it synthesizes
 * Codex/Hermes/Operator dialogue from the current board state every
 * render. That works for "what is happening right now" but it cannot
 * carry an actual conversation: a real Codex agent saying "I picked
 * this up", Hermes flagging a regression, or the operator asking the
 * agents for help.
 *
 * This module is the additive layer that backs those *real* posts:
 *
 *   - `POST /monitor/collaboration`  → recordCollaborationMessage(...)
 *   - `GET  /monitor/collaboration`  → listCollaborationMessages(...)
 *   - `loadMonitorSnapshot()` includes the recent buffer so the SSE
 *     stream propagates new messages without a separate topic.
 *
 * Storage is intentionally in-memory and bounded: a ring of the last
 * `MAX_MESSAGES` entries with a 24h soft TTL on read. Durable storage
 * and per-PR threads land as follow-ups; the contract here is the
 * "this is what the monitor shows during a live session" surface.
 */

const MAX_MESSAGES = 500;
const SOFT_TTL_MS = 24 * 60 * 60 * 1000;

const KNOWN_AUTHORS = new Set(["codex", "hermes", "operator", "system"] as const);
const KNOWN_KINDS = new Set(["chat", "proposal", "request_help", "status"] as const);
const KNOWN_TARGETS = new Set(["everyone", "codex", "hermes", "operator"] as const);

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

export interface RecordCollaborationInput {
  author?: unknown;
  kind?: unknown;
  text?: unknown;
  addressedTo?: unknown;
  relatedPr?: unknown;
  relatedCorrelationId?: unknown;
}

export interface ListCollaborationOptions {
  sinceMs?: number;
  limit?: number;
}

export class CollaborationValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CollaborationValidationError";
  }
}

const store: CollaborationMessage[] = [];
let idSeq = 0;

export function recordCollaborationMessage(
  input: RecordCollaborationInput,
  nowMs: number = Date.now()
): CollaborationMessage {
  const author = normalizeAuthor(input.author);
  if (!author) {
    throw new CollaborationValidationError(
      "invalid_author",
      "author must be one of: codex, hermes, operator, system."
    );
  }

  const text = normalizeText(input.text);
  if (!text) {
    throw new CollaborationValidationError(
      "invalid_text",
      "text is required and must be a non-empty string (max 4000 chars)."
    );
  }

  const kind = normalizeKind(input.kind) ?? "chat";
  const addressedTo = normalizeTarget(input.addressedTo) ?? "everyone";
  const relatedPr = normalizeRelatedPr(input.relatedPr);
  const relatedCorrelationId = normalizeCorrelationId(input.relatedCorrelationId);

  const message: CollaborationMessage = {
    id: nextId(nowMs),
    ts: nowMs,
    author,
    kind,
    text,
    addressedTo,
    ...(relatedPr ? { relatedPr } : {}),
    ...(relatedCorrelationId ? { relatedCorrelationId } : {}),
  };

  store.push(message);
  while (store.length > MAX_MESSAGES) store.shift();
  return message;
}

export function listCollaborationMessages(
  options: ListCollaborationOptions = {},
  nowMs: number = Date.now()
): CollaborationMessage[] {
  const cutoff = nowMs - SOFT_TTL_MS;
  const sinceMs = Number.isFinite(options.sinceMs) ? Number(options.sinceMs) : -Infinity;
  const limit = clampLimit(options.limit);
  const filtered = store.filter((m) => m.ts >= cutoff && m.ts > sinceMs);
  return filtered.slice(-limit);
}

export function __resetCollaborationStoreForTests(): void {
  store.length = 0;
  idSeq = 0;
}

function normalizeAuthor(value: unknown): CollaborationAuthor | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (KNOWN_AUTHORS as Set<string>).has(v) ? (v as CollaborationAuthor) : null;
}

function normalizeKind(value: unknown): CollaborationKind | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (KNOWN_KINDS as Set<string>).has(v) ? (v as CollaborationKind) : null;
}

function normalizeTarget(value: unknown): CollaborationTarget | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  return (KNOWN_TARGETS as Set<string>).has(v) ? (v as CollaborationTarget) : null;
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.slice(0, 4000);
}

function normalizeRelatedPr(value: unknown): CollaborationRelatedPr | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const repo = typeof obj.repo === "string" ? obj.repo.trim() : "";
  const number = typeof obj.number === "number" && Number.isInteger(obj.number) ? obj.number : NaN;
  if (!repo || !Number.isFinite(number) || number < 1) return undefined;
  return { repo, number };
}

function normalizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 256) : undefined;
}

function clampLimit(value: unknown): number {
  if (!Number.isFinite(value as number)) return MAX_MESSAGES;
  const n = Math.floor(Number(value));
  if (n < 1) return MAX_MESSAGES;
  return Math.min(n, MAX_MESSAGES);
}

function nextId(nowMs: number): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `collab-${nowMs.toString(36)}-${idSeq.toString(36)}`;
}
