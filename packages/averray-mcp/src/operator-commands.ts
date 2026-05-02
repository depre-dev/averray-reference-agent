import type { WikipediaCitationRepairWorkflowInput } from "./job-workflows.js";

export type OperatorCommandSource = "slack" | "operator" | "command_center" | "hermes";

export type ParsedOperatorCommand =
  | {
      handled: true;
      kind: "run_wikipedia_citation_repair";
      source: OperatorCommandSource;
      input: WikipediaCitationRepairWorkflowInput;
    }
  | {
      handled: true;
      kind: "status_last_wikipedia_citation_repair";
      source: OperatorCommandSource;
    }
  | {
      handled: false;
      kind: "unknown";
      source: OperatorCommandSource;
      normalizedText: string;
      examples: string[];
    };

export type OperatorQueryFn = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[]
) => Promise<T[]>;

export interface LastWikipediaCitationRepairStatus {
  found: boolean;
  runId?: string;
  jobId?: string;
  sessionId?: string;
  status?: string;
  submittedAt?: string;
  failedAt?: string;
  draftId?: string;
  draftValidationStatus?: string;
  submitSucceeded: boolean;
  slackPermalink?: string | null;
  source: "submissions" | "draft_submissions" | "none";
  lastError?: string;
  updatedAt?: string;
}

const EXAMPLES = [
  "run one wikipedia citation repair if safe",
  "run wikipedia citation repair for wiki-en-... if safe",
  "status last wikipedia citation repair",
];

export function parseOperatorCommand(
  text: string,
  options: {
    source?: OperatorCommandSource;
    defaultDryRun?: boolean;
    maxEvidenceUrls?: number;
    confidenceThreshold?: number;
  } = {}
): ParsedOperatorCommand {
  const source = options.source ?? "operator";
  const normalizedText = normalizeCommandText(text);

  if (normalizedText === "status last wikipedia citation repair") {
    return { handled: true, kind: "status_last_wikipedia_citation_repair", source };
  }

  if (
    normalizedText.startsWith("run ") &&
    normalizedText.includes("wikipedia citation repair") &&
    normalizedText.includes("if safe")
  ) {
    const jobId = extractToken(text, /\bfor\s+([A-Za-z0-9_.:-]+)/i);
    const runId = extractToken(text, /\brun\s*id\s*[:=]?\s*([A-Za-z0-9_.:-]+)/i);
    const dryRun = /\b(dry\s*run|preview|read[-\s]*only|no\s+submit)\b/i.test(text)
      ? true
      : options.defaultDryRun ?? false;
    return {
      handled: true,
      kind: "run_wikipedia_citation_repair",
      source,
      input: {
        ...(runId ? { runId } : {}),
        ...(jobId ? { jobId } : {}),
        dryRun,
        maxEvidenceUrls: options.maxEvidenceUrls ?? 5,
        confidenceThreshold: options.confidenceThreshold ?? 0.7,
      },
    };
  }

  return { handled: false, kind: "unknown", source, normalizedText, examples: EXAMPLES };
}

export async function getLastWikipediaCitationRepairStatus(
  query: OperatorQueryFn
): Promise<LastWikipediaCitationRepairStatus> {
  const submissions = await query<SubmissionStatusRow>(
    `select
       s.request,
       s.response,
       s.status,
       s.last_error,
       s.updated_at,
       d.draft_id,
       d.run_id as draft_run_id,
       d.job_id as draft_job_id,
       d.session_id as draft_session_id,
       d.validation_status as draft_validation_status,
       e.slack_permalink,
       e.reply_permalink
     from submissions s
     left join draft_submissions d on d.draft_id = s.request->>'draftId'
     left join lateral (
       select slack_permalink, reply_permalink
       from operator_command_events
       where run_id = coalesce(s.request->>'policyRunId', s.request->>'runId', d.run_id)
       order by updated_at desc
       limit 1
     ) e on true
     where s.kind = 'submit'
       and coalesce(s.request->>'jobId', d.job_id, '') like 'wiki-en-%citation-repair%'
     order by s.updated_at desc
     limit 1`
  );
  if (submissions[0]) return statusFromSubmissionRow(submissions[0]);

  const drafts = await query<DraftStatusRow>(
    `select draft_id, run_id, job_id, session_id, validation_status, updated_at
     from draft_submissions
     where job_id like 'wiki-en-%citation-repair%'
     order by updated_at desc
     limit 1`
  );
  if (drafts[0]) return statusFromDraftRow(drafts[0]);

  return { found: false, source: "none", submitSucceeded: false, slackPermalink: null };
}

function statusFromSubmissionRow(row: SubmissionStatusRow): LastWikipediaCitationRepairStatus {
  const request = toRecord(row.request);
  const response = toRecord(row.response);
  const rawStatus = stringField(row, "status") ?? "unknown";
  const submitSucceeded = rawStatus === "completed";
  const status = submitSucceeded
    ? firstDeepString(response, ["state", "status"]) ?? "submitted"
    : rawStatus === "failed"
      ? "failed"
      : rawStatus;
  const updatedAt = dateString(row.updated_at);
  return {
    found: true,
    runId: stringField(request, "policyRunId") ?? stringField(request, "runId") ?? stringField(row, "draft_run_id"),
    jobId: stringField(request, "jobId") ?? stringField(row, "draft_job_id"),
    sessionId: stringField(request, "sessionId") ?? stringField(row, "draft_session_id"),
    status,
    ...(submitSucceeded && updatedAt ? { submittedAt: updatedAt } : {}),
    ...(!submitSucceeded && rawStatus === "failed" && updatedAt ? { failedAt: updatedAt } : {}),
    draftId: stringField(request, "draftId") ?? stringField(row, "draft_id"),
    draftValidationStatus: stringField(row, "draft_validation_status"),
    submitSucceeded,
    slackPermalink: stringField(row, "reply_permalink")
      ?? stringField(row, "slack_permalink")
      ?? firstDeepString(response, ["slackPermalink", "slack_permalink", "permalink"])
      ?? null,
    source: "submissions",
    ...(stringField(row, "last_error") ? { lastError: stringField(row, "last_error") } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function statusFromDraftRow(row: DraftStatusRow): LastWikipediaCitationRepairStatus {
  const updatedAt = dateString(row.updated_at);
  return {
    found: true,
    runId: stringField(row, "run_id"),
    jobId: stringField(row, "job_id"),
    sessionId: stringField(row, "session_id"),
    status: "draft_saved",
    draftId: stringField(row, "draft_id"),
    draftValidationStatus: stringField(row, "validation_status"),
    submitSucceeded: false,
    slackPermalink: null,
    source: "draft_submissions",
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function normalizeCommandText(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

function extractToken(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match?.[1]?.replace(/[.,!?]+$/g, "");
}

function toRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function firstDeepString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 5 || !isRecord(value)) return undefined;
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct.length > 0) return direct;
  }
  for (const nested of Object.values(value)) {
    const match = firstDeepString(nested, keys, depth + 1);
    if (match) return match;
  }
  return undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function dateString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SubmissionStatusRow {
  request?: unknown;
  response?: unknown;
  status?: string;
  last_error?: string | null;
  updated_at?: string | Date;
  draft_id?: string | null;
  draft_run_id?: string | null;
  draft_job_id?: string | null;
  draft_session_id?: string | null;
  draft_validation_status?: string | null;
  slack_permalink?: string | null;
  reply_permalink?: string | null;
}

interface DraftStatusRow {
  draft_id?: string;
  run_id?: string | null;
  job_id?: string;
  session_id?: string | null;
  validation_status?: string;
  updated_at?: string | Date;
}
