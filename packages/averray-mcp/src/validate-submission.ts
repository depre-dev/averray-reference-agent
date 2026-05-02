/**
 * Local pre-flight validation for `averray_submit`.
 *
 * The Averray backend strict-validates `payload.submission` against a
 * job's output schema. The reference agent has `maxSubmitAttempts=1`,
 * so a single shape mistake (e.g. an extra `citation_number` field on a
 * Wikipedia citation-repair proposal) consumes the only submit attempt
 * and the corrected payload is then blocked by `max_submit_attempts_exceeded`.
 *
 * This module makes that mistake free: it re-runs the strict schema
 * locally before the mutation policy check, returning actionable error
 * paths the agent can use to fix the proposal and try again. Local
 * failures don't touch the submission ledger.
 *
 * Today only Wikipedia task outputs have first-class local schemas
 * (`packages/schemas`). For other source kinds (GitHub, OSV, OpenAPI,
 * standards, open-data, native), `validateSubmissionLocally` returns
 * `{ valid: true, validator: "permissive" }` so the agent still
 * benefits from the wallet/auth flow without us blocking unknown
 * payload shapes prematurely.
 */

import { z } from "zod";
import {
  wikipediaCitationRepairOutputSchema,
  wikipediaFreshnessCheckOutputSchema,
  wikipediaInfoboxConsistencyOutputSchema,
} from "@avg/schemas";

export type SubmissionValidator = "wikipedia" | "permissive";

export interface SubmissionValidationResult {
  valid: boolean;
  /** Which validator ran. `permissive` means we don't have a local
   *  schema for this source kind yet and skipped the check. */
  validator: SubmissionValidator;
  /** The detected source kind / task type for trace context. */
  taskType?: string;
  /** Per-error breakdown when `valid === false`. Each entry carries
   *  the JSON path the agent should adjust. */
  errors?: SubmissionValidationError[];
  /** Top-level human-readable message; redundant with `errors[]` but
   *  convenient for log lines. */
  message?: string;
}

export interface SubmissionValidationError {
  path: string;
  code: string;
  message: string;
}

/**
 * Result of inspecting a `/jobs/definition` payload to figure out
 * which local schema (if any) applies. Exposed mostly for testing —
 * production code calls `validateSubmissionLocally`.
 */
export interface ValidatorSelection {
  validator: SubmissionValidator;
  taskType?: string;
}

interface JobDefinitionShape {
  source?: { type?: string; taskType?: string } | unknown;
  publicDetails?: { source?: string; taskType?: string } | unknown;
}

/**
 * Pick a local Zod schema for a job. Returns `permissive` when we
 * don't yet have a port of the upstream schema in this repo.
 */
export function selectValidator(jobDefinition: unknown): ValidatorSelection {
  const def = (jobDefinition ?? {}) as JobDefinitionShape;
  const source = isRecord(def.source) ? def.source : undefined;
  const publicDetails = isRecord(def.publicDetails) ? def.publicDetails : undefined;

  const sourceKind = stringField(source, "type") ?? stringField(publicDetails, "source");
  if (sourceKind === "wikipedia_article" || sourceKind === "wikipedia") {
    const taskType =
      stringField(source, "taskType") ?? stringField(publicDetails, "taskType");
    if (taskType) return { validator: "wikipedia", taskType };
    return { validator: "permissive" };
  }

  return { validator: "permissive" };
}

/**
 * Validate a submission payload against the right local schema for the
 * given job definition. Caller is responsible for fetching the job
 * definition (the MCP tool layer already does this for `_get_definition`
 * and friends).
 */
export function validateSubmissionLocally(
  jobDefinition: unknown,
  output: unknown
): SubmissionValidationResult {
  const { validator, taskType } = selectValidator(jobDefinition);
  if (validator === "permissive") {
    return {
      valid: true,
      validator,
      ...(taskType ? { taskType } : {}),
    };
  }

  const schema = pickWikipediaSchema(taskType);
  if (!schema) {
    // Fall through to permissive when we recognise the source kind but
    // not the specific task type — better than refusing a payload we
    // can't actually evaluate.
    return {
      valid: true,
      validator: "permissive",
      ...(taskType ? { taskType } : {}),
    };
  }

  const result = schema.safeParse(output);
  if (result.success) {
    return { valid: true, validator, taskType };
  }

  const errors = result.error.issues.map(formatIssue);
  return {
    valid: false,
    validator,
    taskType,
    errors,
    message:
      errors.length === 1
        ? errors[0].message
        : `${errors.length} validation errors — see errors[].path/.message`,
  };
}

function pickWikipediaSchema(taskType: string | undefined) {
  if (!taskType) return undefined;
  switch (taskType) {
    case "citation_repair":
      return wikipediaCitationRepairOutputSchema;
    case "freshness_check":
      return wikipediaFreshnessCheckOutputSchema;
    case "infobox_consistency":
      return wikipediaInfoboxConsistencyOutputSchema;
    default:
      return undefined;
  }
}

function formatIssue(issue: z.ZodIssue): SubmissionValidationError {
  const path = issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
  // Zod's `unrecognized_keys` issue is the one that catches the
  // citation_number bug from the reference run. Surface the offending
  // key inside the path so the message reads as
  // `citation_findings.0.citation_number is not allowed`.
  if (issue.code === "unrecognized_keys") {
    const keys = Array.isArray((issue as { keys?: unknown }).keys)
      ? ((issue as { keys: unknown[] }).keys.map(String))
      : [];
    const key = keys[0] ?? "<unknown>";
    const fullPath = path === "(root)" ? key : `${path}.${key}`;
    return {
      path: fullPath,
      code: issue.code,
      message: `${fullPath} is not allowed (extra field)`,
    };
  }
  return {
    path,
    code: issue.code,
    message: `${path}: ${issue.message}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
