import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
 * Conversation storage is intentionally in-memory and bounded: a ring
 * of the last `MAX_MESSAGES` entries with a 24h soft TTL on read.
 * Hermes memory is a smaller derived layer: operator guidance and
 * operator outcomes can be persisted to `HERMES_MONITOR_MEMORY_PATH`
 * so Hermes keeps learning preferences across monitor restarts without
 * treating memory as live proof. Durable full transcripts and per-PR
 * threads remain separate follow-ups.
 */

const MAX_MESSAGES = 500;
const MAX_REVIEW_REQUESTS = 300;
const SOFT_TTL_MS = 24 * 60 * 60 * 1000;
const HERMES_MEMORY_MAX_NOTES = 120;
const HERMES_MEMORY_NOTE_MAX_CHARS = 320;

const KNOWN_AUTHORS = new Set(["claude", "codex", "hermes", "operator", "system"] as const);
const KNOWN_KINDS = new Set(["chat", "proposal", "request_help", "status"] as const);
const KNOWN_TARGETS = new Set(["everyone", "claude", "codex", "hermes", "operator"] as const);

export type CollaborationAuthor = "claude" | "codex" | "hermes" | "operator" | "system";
export type CollaborationKind = "chat" | "proposal" | "request_help" | "status";
export type CollaborationTarget = "everyone" | "claude" | "codex" | "hermes" | "operator";
export type ReviewRequester = "hermes" | "operator" | "codex" | "claude";
export type ReviewRequestReviewer = "codex" | "claude" | "hermes" | "operator";
export type ReviewRequestStatus = "requested" | "responded" | "cancelled";

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
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

export interface ReviewRequest {
  id: string;
  relatedPr?: CollaborationRelatedPr;
  relatedMission?: CollaborationRelatedMission;
  correlationId?: string;
  requestedBy: ReviewRequester;
  reviewer: ReviewRequestReviewer;
  reason: string;
  status: ReviewRequestStatus;
  createdAt: string;
  updatedAt: string;
}

export interface HermesMemoryNote {
  id: string;
  ts: number;
  scope: "global" | "pr";
  text: string;
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

export type HermesMemoryRequestKind = "show" | "forget_pr" | "none";

export interface RecordCollaborationInput {
  author?: unknown;
  kind?: unknown;
  text?: unknown;
  addressedTo?: unknown;
  relatedPr?: unknown;
  relatedCorrelationId?: unknown;
}

export interface RecordReviewRequestInput {
  relatedPr?: unknown;
  relatedMission?: unknown;
  correlationId?: unknown;
  relatedCorrelationId?: unknown;
  requestedBy?: unknown;
  reviewer?: unknown;
  reason?: unknown;
  status?: unknown;
}

export interface ListCollaborationOptions {
  sinceMs?: number;
  limit?: number;
}

export interface ListReviewRequestsOptions {
  limit?: number;
  status?: ReviewRequestStatus;
}

export interface ListHermesMemoryOptions {
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
  limit?: number;
}

export interface RecordHermesMemoryNoteInput {
  text: string;
  scope?: "global" | "pr";
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

export class CollaborationValidationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CollaborationValidationError";
  }
}

const store: CollaborationMessage[] = [];
const reviewRequests: ReviewRequest[] = [];
const hermesMemoryNotes: HermesMemoryNote[] = [];
let idSeq = 0;
let reviewRequestSeq = 0;
let memorySeq = 0;
let memoryLoaded = false;

export function recordCollaborationMessage(
  input: RecordCollaborationInput,
  nowMs: number = Date.now()
): CollaborationMessage {
  const author = normalizeAuthor(input.author);
  if (!author) {
    throw new CollaborationValidationError(
      "invalid_author",
      "author must be one of: claude, codex, hermes, operator, system."
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
  const addressedTo = normalizeTarget(input.addressedTo);
  if (addressedTo === null && hasExplicitTarget(input.addressedTo)) {
    throw new CollaborationValidationError(
      "invalid_target",
      "addressedTo must be one of: everyone, claude, codex, hermes, operator."
    );
  }
  const relatedPr = normalizeRelatedPr(input.relatedPr);
  const relatedCorrelationId = normalizeCorrelationId(input.relatedCorrelationId);

  const message: CollaborationMessage = {
    id: nextId(nowMs),
    ts: nowMs,
    author,
    kind,
    text,
    addressedTo: addressedTo ?? "everyone",
    ...(relatedPr ? { relatedPr } : {}),
    ...(relatedCorrelationId ? { relatedCorrelationId } : {}),
  };

  store.push(message);
  while (store.length > MAX_MESSAGES) store.shift();
  if (!applyHermesMemoryGovernanceFromMessage(message)) {
    learnHermesMemoryFromMessage(message);
  }
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

export function recordReviewRequest(
  input: RecordReviewRequestInput,
  nowMs: number = Date.now()
): ReviewRequest {
  const requestedBy = normalizeRequester(input.requestedBy);
  if (!requestedBy) {
    throw new CollaborationValidationError(
      "invalid_requested_by",
      "requestedBy must be one of: hermes, operator, codex, claude."
    );
  }

  const reviewer = normalizeReviewer(input.reviewer);
  if (!reviewer) {
    throw new CollaborationValidationError(
      "invalid_reviewer",
      "reviewer must be one of: codex, claude, hermes, operator."
    );
  }

  const reason = normalizeText(input.reason);
  if (!reason) {
    throw new CollaborationValidationError(
      "invalid_reason",
      "reason is required and must be a non-empty string (max 4000 chars)."
    );
  }

  const relatedPr = normalizeRelatedPr(input.relatedPr);
  const relatedMission = normalizeRelatedMission(input.relatedMission);
  const correlationId = normalizeCorrelationId(input.correlationId) ?? normalizeCorrelationId(input.relatedCorrelationId);
  if (!relatedPr && !relatedMission && !correlationId) {
    throw new CollaborationValidationError(
      "missing_review_scope",
      "review request must include relatedPr, relatedMission, or correlationId."
    );
  }

  const status = normalizeReviewStatus(input.status);
  if (status === null && hasExplicitTarget(input.status)) {
    throw new CollaborationValidationError(
      "invalid_review_status",
      "status must be one of: requested, responded, cancelled."
    );
  }
  const at = new Date(nowMs).toISOString();
  const request: ReviewRequest = {
    id: nextReviewRequestId(nowMs),
    ...(relatedPr ? { relatedPr } : {}),
    ...(relatedMission ? { relatedMission } : {}),
    ...(correlationId ? { correlationId } : {}),
    requestedBy,
    reviewer,
    reason,
    status: status ?? "requested",
    createdAt: at,
    updatedAt: at,
  };

  reviewRequests.push(request);
  while (reviewRequests.length > MAX_REVIEW_REQUESTS) reviewRequests.shift();
  recordReviewRequestCollaborationTurn(request, nowMs);
  return request;
}

export function listReviewRequests(options: ListReviewRequestsOptions = {}): ReviewRequest[] {
  const limit = clampLimit(options.limit, MAX_REVIEW_REQUESTS);
  const filtered = options.status
    ? reviewRequests.filter((request) => request.status === options.status)
    : reviewRequests;
  return filtered.slice(-limit);
}

export function listHermesMemoryNotes(options: ListHermesMemoryOptions = {}): HermesMemoryNote[] {
  loadHermesMemoryIfNeeded();
  const limit = clampLimit(options.limit, HERMES_MEMORY_MAX_NOTES);
  const relatedCorrelationId = options.relatedCorrelationId?.trim();
  const filtered = hermesMemoryNotes.filter((note) => {
    if (note.scope === "global") return true;
    if (options.relatedPr && note.relatedPr && samePr(note.relatedPr, options.relatedPr)) return true;
    if (relatedCorrelationId && note.relatedCorrelationId === relatedCorrelationId) return true;
    return false;
  });
  return filtered.slice(-limit);
}

export function recordHermesMemoryNote(
  input: RecordHermesMemoryNoteInput,
  nowMs: number = Date.now()
): HermesMemoryNote | undefined {
  loadHermesMemoryIfNeeded();
  const text = normalizeText(input.text).slice(0, HERMES_MEMORY_NOTE_MAX_CHARS);
  if (!text) return undefined;
  const note: HermesMemoryNote = {
    id: nextMemoryId(nowMs),
    ts: nowMs,
    scope: input.scope ?? (input.relatedPr ? "pr" : "global"),
    text,
    ...(input.relatedPr ? { relatedPr: input.relatedPr } : {}),
    ...(input.relatedCorrelationId ? { relatedCorrelationId: input.relatedCorrelationId.trim().slice(0, 256) } : {}),
  };
  upsertHermesMemoryNote(note);
  return note;
}

export function classifyHermesMemoryRequest(message: Pick<CollaborationMessage, "author" | "addressedTo" | "text">): HermesMemoryRequestKind {
  if (message.author !== "operator") return "none";
  if (message.addressedTo !== "hermes" && message.addressedTo !== "everyone") return "none";
  const lower = message.text.toLowerCase();
  if (isForgetMemoryRequest(lower)) return "forget_pr";
  if (isShowMemoryRequest(lower)) return "show";
  return "none";
}

export function __resetCollaborationStoreForTests(): void {
  store.length = 0;
  reviewRequests.length = 0;
  hermesMemoryNotes.length = 0;
  idSeq = 0;
  reviewRequestSeq = 0;
  memorySeq = 0;
  memoryLoaded = false;
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

function hasExplicitTarget(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function normalizeRequester(value: unknown): ReviewRequester | null {
  const author = normalizeAuthor(value);
  if (author === "system" || !author) return null;
  return author;
}

function normalizeReviewer(value: unknown): ReviewRequestReviewer | null {
  const target = normalizeTarget(value);
  if (target === "everyone" || !target) return null;
  return target;
}

function normalizeReviewStatus(value: unknown): ReviewRequestStatus | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "requested" || v === "responded" || v === "cancelled") return v;
  return null;
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

function normalizeRelatedMission(value: unknown): CollaborationRelatedMission | undefined {
  if (!value || typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim().slice(0, 256) : "";
  return id ? { id } : undefined;
}

function normalizeCorrelationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 256) : undefined;
}

function clampLimit(value: unknown, max: number = MAX_MESSAGES): number {
  if (!Number.isFinite(value as number)) return max;
  const n = Math.floor(Number(value));
  if (n < 1) return max;
  return Math.min(n, max);
}

function nextId(nowMs: number): string {
  idSeq = (idSeq + 1) % 1_000_000;
  return `collab-${nowMs.toString(36)}-${idSeq.toString(36)}`;
}

function nextReviewRequestId(nowMs: number): string {
  reviewRequestSeq = (reviewRequestSeq + 1) % 1_000_000;
  return `review-${nowMs.toString(36)}-${reviewRequestSeq.toString(36)}`;
}

function nextMemoryId(nowMs: number): string {
  memorySeq = (memorySeq + 1) % 1_000_000;
  return `hermes-memory-${nowMs.toString(36)}-${memorySeq.toString(36)}`;
}

function recordReviewRequestCollaborationTurn(request: ReviewRequest, nowMs: number): void {
  const scope = reviewRequestScopeLabel(request);
  const reviewer = actorDisplayName(request.reviewer);
  const relatedCorrelationId = request.correlationId ?? request.relatedMission?.id;
  recordCollaborationMessage({
    author: request.requestedBy,
    kind: "request_help",
    addressedTo: request.reviewer,
    text: `Review requested from ${reviewer}${scope ? ` on ${scope}` : ""}: ${request.reason}`,
    ...(request.relatedPr ? { relatedPr: request.relatedPr } : {}),
    ...(relatedCorrelationId ? { relatedCorrelationId } : {}),
  }, nowMs);
}

function reviewRequestScopeLabel(request: ReviewRequest): string {
  if (request.relatedPr) return `${request.relatedPr.repo}#${request.relatedPr.number}`;
  if (request.relatedMission) return `mission ${request.relatedMission.id}`;
  return request.correlationId ?? "";
}

function actorDisplayName(actor: ReviewRequester | ReviewRequestReviewer): string {
  if (actor === "hermes") return "Hermes";
  if (actor === "operator") return "Pascal";
  if (actor === "claude") return "Claude";
  return "Codex";
}

function learnHermesMemoryFromMessage(message: CollaborationMessage): void {
  loadHermesMemoryIfNeeded();
  const noteText = memoryTextForMessage(message);
  if (!noteText) return;

  recordHermesMemoryNote({
    text: noteText,
    scope: message.relatedPr ? "pr" : "global",
    ...(message.relatedPr ? { relatedPr: message.relatedPr } : {}),
    ...(message.relatedCorrelationId ? { relatedCorrelationId: message.relatedCorrelationId } : {}),
  }, message.ts);
}

function upsertHermesMemoryNote(note: HermesMemoryNote): void {
  const dedupeKey = memoryDedupeKey(note);
  const existingIndex = hermesMemoryNotes.findIndex((candidate) =>
    memoryDedupeKey(candidate) === dedupeKey
  );
  if (existingIndex >= 0) {
    hermesMemoryNotes.splice(existingIndex, 1);
  }
  hermesMemoryNotes.push(note);
  while (hermesMemoryNotes.length > HERMES_MEMORY_MAX_NOTES) hermesMemoryNotes.shift();
  persistHermesMemoryNotes();
}

function applyHermesMemoryGovernanceFromMessage(message: CollaborationMessage): boolean {
  loadHermesMemoryIfNeeded();
  const request = classifyHermesMemoryRequest(message);
  if (request === "none") return false;
  if (request !== "forget_pr") return true;
  if (!message.relatedPr) return true;

  const before = hermesMemoryNotes.length;
  for (let i = hermesMemoryNotes.length - 1; i >= 0; i -= 1) {
    const note = hermesMemoryNotes[i];
    if (note.scope === "pr" && note.relatedPr && samePr(note.relatedPr, message.relatedPr)) {
      hermesMemoryNotes.splice(i, 1);
    }
  }
  if (hermesMemoryNotes.length !== before) persistHermesMemoryNotes();
  return true;
}

function memoryTextForMessage(message: CollaborationMessage): string | null {
  if (message.author !== "operator") return null;
  if (message.addressedTo === "operator") return null;

  const outcomeMemory = operatorOutcomeMemoryTextForMessage(message);
  if (outcomeMemory) return outcomeMemory;

  if (!looksLikeOperatorGuidance(message.text)) return null;

  const compact = message.text.replace(/\s+/g, " ").trim();
  const prRef = message.relatedPr ? `${message.relatedPr.repo}#${message.relatedPr.number}` : null;
  const prefix = prRef ? `Pascal note for ${prRef}: ` : "Pascal preference: ";
  return `${prefix}${compact}`.slice(0, HERMES_MEMORY_NOTE_MAX_CHARS);
}

function operatorOutcomeMemoryTextForMessage(message: CollaborationMessage): string | null {
  if (!message.relatedPr) return null;

  const compact = message.text.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const prRef = `${message.relatedPr.repo}#${message.relatedPr.number}`;
  const prefix = `Pascal outcome for ${prRef}: `;

  const outcome = classifyOperatorOutcome(lower);
  if (!outcome) return null;

  return `${prefix}${outcome}`.slice(0, HERMES_MEMORY_NOTE_MAX_CHARS);
}

function classifyOperatorOutcome(lower: string): string | null {
  if (includesAll(lower, ["opened the failed task output", "runner error"])) {
    return "opened the failed Codex runner output; next move is a smaller retry task or a clear no-code-change explanation.";
  }
  if (includesAll(lower, ["please take over", "still a draft"])) {
    return "delegated draft takeover to Codex; Codex may inspect and finish only verifiable missing work, then mark ready only if complete.";
  }
  if (includesAll(lower, ["sending", "back from operator review"])) {
    return "sent operator review back to Codex because the pre-check was not enough; Codex should make the smallest justified fix or explain no change.";
  }
  if (includesAll(lower, ["reopened my local review", "keep it out of the release path"])) {
    return "reopened local review; keep the PR out of the release path until it is marked reviewed again or sent back to Codex.";
  }
  if (includesAll(lower, ["marked", "reviewed for release"])) {
    return "marked the PR reviewed for release; this is not a merge and it may move toward release only while branch protection stays green.";
  }
  if (includesAll(lower, ["accepting the project-level review gate"])) {
    return "accepted the project-level review gate; if CI or evidence changes, bring the PR back before it moves forward.";
  }
  if (includesAll(lower, ["created a proposed task", "not a runner start yet"])) {
    return "proposed a Codex task but did not start the runner; Codex should hold until the task is explicitly approved.";
  }
  if (includesAll(lower, ["approved the task", "allowed to pick it up now"])) {
    return "approved the Codex task; Codex may pick it up, keep the change bounded, and let Hermes re-check after CI.";
  }
  if (includesAll(lower, ["cancelled the codex task"])) {
    return "cancelled the Codex task; keep the card parked until the next move is clearer or a smaller task is proposed.";
  }
  return null;
}

function includesAll(text: string, cues: string[]): boolean {
  return cues.every((cue) => text.includes(cue));
}

function includesAny(text: string, cues: string[]): boolean {
  return cues.some((cue) => text.includes(cue));
}

function isForgetMemoryRequest(lower: string): boolean {
  const asksForget = includesAny(lower, ["forget", "clear", "remove", "delete"]);
  const namesMemory = includesAny(lower, ["memory", "remember", "remembered", "what you know"]);
  return asksForget && namesMemory;
}

function isShowMemoryRequest(lower: string): boolean {
  return includesAny(lower, [
    "what do you remember",
    "what are you remembering",
    "show memory",
    "show memories",
    "list memory",
    "list memories",
    "memory for this pr",
    "what memory",
  ]);
}

function looksLikeOperatorGuidance(text: string): boolean {
  const lower = text.toLowerCase();
  return [
    "remember",
    "from now",
    "always",
    "never",
    "prefer",
    "preference",
    "owner",
    "owns",
    "ownership",
    "delegate",
    "do not",
    "don't",
    "external agent",
    "another agent",
    "merge steward",
    "release queue",
    "draft",
    "operator",
    "codex",
    "hermes",
    "board",
    "approved",
    "reviewed",
    "sent back",
    "take over",
    "takeover",
    "runner start",
    "pick it up",
    "reopened",
  ].some((cue) => lower.includes(cue));
}

function memoryDedupeKey(note: HermesMemoryNote): string {
  const scopeKey = note.relatedPr
    ? `pr:${note.relatedPr.repo.toLowerCase()}#${note.relatedPr.number}`
    : note.relatedCorrelationId
      ? `correlation:${note.relatedCorrelationId.toLowerCase()}`
      : "global";
  return `${scopeKey}:${note.text.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function samePr(a: CollaborationRelatedPr, b: CollaborationRelatedPr): boolean {
  return a.number === b.number && a.repo.toLowerCase() === b.repo.toLowerCase();
}

function hermesMemoryPath(): string | null {
  const path = process.env.HERMES_MONITOR_MEMORY_PATH?.trim();
  return path ? path : null;
}

function loadHermesMemoryIfNeeded(): void {
  if (memoryLoaded) return;
  memoryLoaded = true;
  const path = hermesMemoryPath();
  if (!path) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return;
  }

  const rawNotes = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.notes)
      ? parsed.notes
      : [];
  for (const raw of rawNotes) {
    const note = restoreHermesMemoryNote(raw);
    if (note) hermesMemoryNotes.push(note);
  }
  while (hermesMemoryNotes.length > HERMES_MEMORY_MAX_NOTES) hermesMemoryNotes.shift();
}

function persistHermesMemoryNotes(): void {
  const path = hermesMemoryPath();
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ schemaVersion: 1, notes: hermesMemoryNotes }, null, 2)}\n`
    );
  } catch {
    // Memory is helpful context, not a runtime dependency. Keep the
    // collaboration channel alive even if the optional memory file is
    // unavailable.
  }
}

function restoreHermesMemoryNote(value: unknown): HermesMemoryNote | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id ? value.id : nextMemoryId(Date.now());
  const ts = typeof value.ts === "number" && Number.isFinite(value.ts) ? value.ts : Date.now();
  const scope = value.scope === "pr" ? "pr" : "global";
  const text = typeof value.text === "string" ? value.text.trim().slice(0, HERMES_MEMORY_NOTE_MAX_CHARS) : "";
  if (!text) return null;
  const relatedPr = normalizeRelatedPr(value.relatedPr);
  const relatedCorrelationId = normalizeCorrelationId(value.relatedCorrelationId);
  return {
    id,
    ts,
    scope: relatedPr ? "pr" : scope,
    text,
    ...(relatedPr ? { relatedPr } : {}),
    ...(relatedCorrelationId ? { relatedCorrelationId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ───────────────────────────────────────────────────────────────────────
// Hermes auto-reply synthesizer
//
// Operators expect the channel to feel like a conversation: post a
// message, get an acknowledgment. Today the chat is one-way for
// operator posts (Codex/Hermes only "speak" via synthesized board
// state). This helper produces a short, contextual ack from Hermes so
// the channel reads as bidirectional.
//
// Tone: brief, professional, on-message. Not LLM-routed — canned
// templates keyed on intent and whether a PR is referenced. Cheap and
// predictable; richer LLM-backed replies can layer on later.
//
// Returns null when no reply is warranted (operator talking to
// themselves, message from a non-operator, addressed only to Codex,
// etc.) so the caller can skip the schedule.
// ───────────────────────────────────────────────────────────────────────

export interface HermesReplyDraft {
  text: string;
  addressedTo: CollaborationTarget;
  relatedPr?: CollaborationRelatedPr;
  relatedCorrelationId?: string;
}

export function synthesizeHermesReplyFor(message: CollaborationMessage): HermesReplyDraft | null {
  if (message.author !== "operator") return null;
  // Only chime in when the operator is talking to Hermes or to the
  // whole room. Don't reply to ops-to-Codex or ops-to-self posts —
  // those have a different conversational partner.
  if (message.addressedTo !== "hermes" && message.addressedTo !== "everyone") return null;

  const prRef = message.relatedPr
    ? `${message.relatedPr.repo}#${message.relatedPr.number}`
    : null;

  let text: string;
  if (message.kind === "request_help") {
    text = prRef
      ? `On it — what specifically is blocking you on ${prRef}?`
      : "On it. What's the blocker?";
  } else if (message.kind === "proposal") {
    text = prRef
      ? `Noted on ${prRef}. I'll surface a verdict here once Codex picks it up or the checks move.`
      : "Noted. I'll surface a verdict here once the work lands.";
  } else if (message.kind === "status") {
    text = prRef
      ? `Acknowledged. I'll keep watching ${prRef} and call out anything new.`
      : "Acknowledged. I'll keep watching the board.";
  } else if (prRef) {
    text = `Got it. I've got eyes on ${prRef} — I'll post here as soon as the verdict moves or the checks settle.`;
  } else {
    text = "Got it. I'll keep watching the board and surface anything that needs your call.";
  }

  return {
    text,
    addressedTo: "operator",
    ...(message.relatedPr ? { relatedPr: message.relatedPr } : {}),
    ...(message.relatedCorrelationId ? { relatedCorrelationId: message.relatedCorrelationId } : {}),
  };
}
