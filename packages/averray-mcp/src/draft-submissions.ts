import { Buffer } from "node:buffer";
import {
  canonicalJson,
  idempotencyKey,
  optionalEnv,
  sha256Text,
} from "@avg/mcp-common";

export type DraftQueryFn = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[]
) => Promise<T[]>;

export interface DraftSubmission {
  draftId: string;
  runId?: string;
  jobId: string;
  sessionId?: string;
  output: Record<string, unknown>;
  outputHash: string;
  outputBytes: number;
  proposalOnly: boolean;
  noWikipediaEdit: boolean;
  validationStatus: "unvalidated" | "valid" | "invalid";
  validationResult?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface DraftSummary {
  draftId: string;
  runId?: string;
  jobId: string;
  sessionId?: string;
  outputHash: string;
  outputBytes: number;
  proposalOnly: boolean;
  noWikipediaEdit: boolean;
  validationStatus: "unvalidated" | "valid" | "invalid";
  createdAt?: string;
  updatedAt?: string;
}

export interface SaveDraftInput {
  runId?: string;
  jobId: string;
  sessionId?: string;
  output: unknown;
  proposalOnly?: boolean;
  noWikipediaEdit?: boolean;
}

export interface DraftLookup {
  draftId?: string;
  runId?: string;
  jobId?: string;
  sessionId?: string;
}

export interface NormalizedDraftOutput {
  output: Record<string, unknown>;
  outputHash: string;
  outputBytes: number;
  warning?: string;
}

const SECRET_KEY_PATTERN =
  /(^|[_-])(private.?key|seed.?phrase|mnemonic|password|secret|api.?key|access.?token|bearer|authorization|jwt)($|[_-])/i;

export function buildDraftId(input: {
  runId?: string;
  jobId: string;
  sessionId?: string;
}): string {
  return idempotencyKey(["draft-submission", input.runId, input.jobId, input.sessionId]);
}

export function normalizeDraftOutput(input: unknown): NormalizedDraftOutput {
  let value = input;
  let warning: string | undefined;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
      warning = "parsed_stringified_json_object";
    } catch {
      throw new Error(
        "draft_submission_output_must_be_object: output was a string, not JSON. Load the saved draft or pass the structured object directly."
      );
    }
  }

  if (!isRecord(value)) {
    throw new Error(
      "draft_submission_output_must_be_object: pass the top-level schema object, not a string, array, or primitive."
    );
  }
  assertNoSecretLikeKeys(value);
  const serialized = canonicalJson(value);
  const outputBytes = Buffer.byteLength(serialized, "utf8");
  const maxBytes = Number.parseInt(optionalEnv("AVERRAY_DRAFT_MAX_BYTES", "200000"), 10);
  if (outputBytes > maxBytes) {
    throw new Error(`draft_submission_too_large: ${outputBytes} bytes exceeds limit ${maxBytes}`);
  }
  return {
    output: value,
    outputHash: sha256Text(serialized),
    outputBytes,
    ...(warning ? { warning } : {}),
  };
}

export async function saveDraftSubmission(
  input: SaveDraftInput,
  query: DraftQueryFn
): Promise<DraftSubmission> {
  if (!input.jobId) throw new Error("draft_job_id_required");
  if (!input.runId && !input.sessionId) {
    throw new Error("draft_lookup_key_required: provide runId or sessionId before saving a draft");
  }
  if (input.proposalOnly === false || input.noWikipediaEdit === false) {
    throw new Error("draft_must_be_proposal_only: drafts may not claim a direct Wikipedia edit");
  }
  const normalized = normalizeDraftOutput(input.output);
  const draftId = buildDraftId(input);
  const rows = await query<DraftRow>(
    `insert into draft_submissions(
       draft_id, run_id, job_id, session_id, output, output_hash,
       output_bytes, proposal_only, no_wikipedia_edit, validation_status
     )
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, true, true, 'unvalidated')
     on conflict(draft_id) do update set
       output = excluded.output,
       output_hash = excluded.output_hash,
       output_bytes = excluded.output_bytes,
       proposal_only = true,
       no_wikipedia_edit = true,
       validation_status = 'unvalidated',
       validation_result = '{}'::jsonb,
       updated_at = now()
     returning *`,
    [
      draftId,
      input.runId ?? null,
      input.jobId,
      input.sessionId ?? null,
      JSON.stringify(normalized.output),
      normalized.outputHash,
      normalized.outputBytes,
    ]
  );
  return fromDraftRow(rows[0]);
}

export async function getDraftSubmission(
  lookup: DraftLookup,
  query: DraftQueryFn
): Promise<DraftSubmission> {
  const row = await getDraftRow(lookup, query);
  return fromDraftRow(row);
}

export async function listDraftSubmissions(
  lookup: { runId?: string; jobId?: string; sessionId?: string; limit?: number },
  query: DraftQueryFn
): Promise<DraftSummary[]> {
  const limit = Math.min(Math.max(lookup.limit ?? 20, 1), 50);
  const filters: string[] = [];
  const values: unknown[] = [];
  if (lookup.runId) {
    values.push(lookup.runId);
    filters.push(`run_id = $${values.length}`);
  }
  if (lookup.jobId) {
    values.push(lookup.jobId);
    filters.push(`job_id = $${values.length}`);
  }
  if (lookup.sessionId) {
    values.push(lookup.sessionId);
    filters.push(`session_id = $${values.length}`);
  }
  values.push(limit);
  const rows = await query<DraftRow>(
    `select * from draft_submissions
     ${filters.length > 0 ? `where ${filters.join(" and ")}` : ""}
     order by updated_at desc
     limit $${values.length}`,
    values
  );
  return rows.map((row) => summarizeDraft(fromDraftRow(row)));
}

export async function markDraftValidation(
  draftId: string,
  valid: boolean,
  validationResult: unknown,
  query: DraftQueryFn
): Promise<void> {
  await query(
    `update draft_submissions
     set validation_status = $2,
         validation_result = $3::jsonb,
         updated_at = now()
     where draft_id = $1`,
    [draftId, valid ? "valid" : "invalid", JSON.stringify(validationResult)]
  );
}

export function summarizeDraft(draft: DraftSubmission): DraftSummary {
  return {
    draftId: draft.draftId,
    ...(draft.runId ? { runId: draft.runId } : {}),
    jobId: draft.jobId,
    ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
    outputHash: draft.outputHash,
    outputBytes: draft.outputBytes,
    proposalOnly: draft.proposalOnly,
    noWikipediaEdit: draft.noWikipediaEdit,
    validationStatus: draft.validationStatus,
    ...(draft.createdAt ? { createdAt: draft.createdAt } : {}),
    ...(draft.updatedAt ? { updatedAt: draft.updatedAt } : {}),
  };
}

async function getDraftRow(lookup: DraftLookup, query: DraftQueryFn): Promise<DraftRow> {
  if (lookup.draftId) {
    const rows = await query<DraftRow>(
      "select * from draft_submissions where draft_id = $1 limit 1",
      [lookup.draftId]
    );
    const row = rows[0];
    if (!row) throw new Error("draft_not_found");
    assertLookupMatches(row, lookup);
    return row;
  }

  const filters: string[] = [];
  const values: unknown[] = [];
  if (lookup.jobId) {
    values.push(lookup.jobId);
    filters.push(`job_id = $${values.length}`);
  }
  if (lookup.runId) {
    values.push(lookup.runId);
    filters.push(`run_id = $${values.length}`);
  }
  if (lookup.sessionId) {
    values.push(lookup.sessionId);
    filters.push(`session_id = $${values.length}`);
  }
  if (filters.length === 0) {
    throw new Error("draft_lookup_key_required: provide draftId, runId, jobId, or sessionId to load a draft");
  }
  const rows = await query<DraftRow>(
    `select * from draft_submissions
     where ${filters.join(" and ")}
     order by updated_at desc
     limit 1`,
    values
  );
  if (!rows[0]) throw new Error("draft_not_found");
  return rows[0];
}

function assertLookupMatches(row: DraftRow, lookup: DraftLookup) {
  const mismatches: string[] = [];
  if (lookup.jobId && row.job_id !== lookup.jobId) mismatches.push("jobId");
  if (lookup.sessionId && row.session_id !== lookup.sessionId) mismatches.push("sessionId");
  if (lookup.runId && row.run_id !== lookup.runId) mismatches.push("runId");
  if (mismatches.length > 0) {
    throw new Error(`draft_lookup_mismatch: ${mismatches.join(", ")}`);
  }
}

function assertNoSecretLikeKeys(value: unknown, path: string[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretLikeKeys(item, [...path, String(index)]));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      const fullPath = [...path, key].join(".");
      throw new Error(`draft_contains_secret_like_key: ${fullPath}`);
    }
    assertNoSecretLikeKeys(item, [...path, key]);
  }
}

function fromDraftRow(row: DraftRow | undefined): DraftSubmission {
  if (!row) throw new Error("draft_not_found");
  const output = typeof row.output === "string" ? JSON.parse(row.output) : row.output;
  if (!isRecord(output)) throw new Error("draft_corrupt_output_not_object");
  return {
    draftId: row.draft_id,
    ...(row.run_id ? { runId: row.run_id } : {}),
    jobId: row.job_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    output,
    outputHash: row.output_hash,
    outputBytes: Number(row.output_bytes),
    proposalOnly: Boolean(row.proposal_only),
    noWikipediaEdit: Boolean(row.no_wikipedia_edit),
    validationStatus: normalizeValidationStatus(row.validation_status),
    ...(row.validation_result ? { validationResult: row.validation_result } : {}),
    ...(row.created_at ? { createdAt: String(row.created_at) } : {}),
    ...(row.updated_at ? { updatedAt: String(row.updated_at) } : {}),
  };
}

function normalizeValidationStatus(value: unknown): "unvalidated" | "valid" | "invalid" {
  return value === "valid" || value === "invalid" ? value : "unvalidated";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DraftRow {
  draft_id: string;
  run_id: string | null;
  job_id: string;
  session_id: string | null;
  output: unknown;
  output_hash: string;
  output_bytes: number | string;
  proposal_only: boolean;
  no_wikipedia_edit: boolean;
  validation_status: string;
  validation_result?: unknown;
  created_at?: string | Date;
  updated_at?: string | Date;
}
