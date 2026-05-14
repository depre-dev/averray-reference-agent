import type { WikipediaCitationRepairWorkflowInput } from "./job-workflows.js";
import type { AdminActionProposalInput } from "./operator-admin.js";
import type { GithubOperatorView } from "./operator-github.js";

export type OperatorCommandSource = "slack" | "operator" | "command_center" | "hermes" | "agent";

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
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "operator_status";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "daily_operator_brief";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "find_safe_work";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "agent_usefulness_plan";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "admin_readiness";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "admin_proposal";
      source: OperatorCommandSource;
      detailed: boolean;
      input: AdminActionProposalInput;
    }
  | {
      handled: true;
      kind: "business_ledger";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "ops_health";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "github_status";
      source: OperatorCommandSource;
      view: GithubOperatorView;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "github_brief";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "testbed_e2e_suite";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "run_testbed_e2e_read_only";
      source: OperatorCommandSource;
      detailed: boolean;
    }
  | {
      handled: true;
      kind: "handoff_monitor";
      source: OperatorCommandSource;
      detailed: boolean;
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
  "daily operator brief",
  "what can you do for us",
  "admin readiness",
  "admin proposal",
  "propose merge for averray-agent/agent#123",
  "propose deploy for averray-agent/agent sha abc1234",
  "propose secret rotation",
  "business ledger",
  "ops health",
  "github status",
  "github brief",
  "daily github brief",
  "what changed since last time",
  "github open prs",
  "github ci failures",
  "github issue digest",
  "testbed e2e suite",
  "platform e2e suite",
  "run testbed e2e read-only",
  "handoff monitor",
  "hermes handoff monitor",
  "what is hermes doing",
  "find safe work",
  "operator status",
  "operator status details",
  "run one wikipedia citation repair if safe",
  "run wikipedia citation repair for wiki-en-... if safe",
  "status last wikipedia citation repair",
  "status last wikipedia citation repair details",
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

  const detailed = wantsDetailedOutput(normalizedText);

  if (isDailyOperatorBriefCommand(normalizedText)) {
    return { handled: true, kind: "daily_operator_brief", source, detailed };
  }

  if (isFindSafeWorkCommand(normalizedText)) {
    return { handled: true, kind: "find_safe_work", source, detailed };
  }

  if (isAgentUsefulnessPlanCommand(normalizedText)) {
    return { handled: true, kind: "agent_usefulness_plan", source, detailed };
  }

  if (isAdminReadinessCommand(normalizedText)) {
    return { handled: true, kind: "admin_readiness", source, detailed };
  }

  const adminProposal = adminActionProposalInput(text, normalizedText, source);
  if (adminProposal) {
    return { handled: true, kind: "admin_proposal", source, detailed, input: adminProposal };
  }

  if (isBusinessLedgerCommand(normalizedText)) {
    return { handled: true, kind: "business_ledger", source, detailed };
  }

  if (isOpsHealthCommand(normalizedText)) {
    return { handled: true, kind: "ops_health", source, detailed };
  }

  const githubView = githubOperatorView(normalizedText);
  if (githubView) {
    return { handled: true, kind: "github_status", source, view: githubView, detailed };
  }

  if (isGithubBriefCommand(normalizedText)) {
    return { handled: true, kind: "github_brief", source, detailed };
  }

  if (isRunTestbedE2eReadOnlyCommand(normalizedText)) {
    return { handled: true, kind: "run_testbed_e2e_read_only", source, detailed };
  }

  if (isHandoffMonitorCommand(normalizedText)) {
    return { handled: true, kind: "handoff_monitor", source, detailed };
  }

  if (isTestbedE2eSuiteCommand(normalizedText)) {
    return { handled: true, kind: "testbed_e2e_suite", source, detailed };
  }

  if (isLatestWikipediaCitationRepairStatusCommand(normalizedText)) {
    return { handled: true, kind: "status_last_wikipedia_citation_repair", source, detailed };
  }

  if (isOperatorStatusCommand(normalizedText)) {
    return { handled: true, kind: "operator_status", source, detailed };
  }

  if (
    normalizedText.startsWith("run ") &&
    normalizedText.includes("wikipedia citation repair") &&
    (normalizedText.includes("if safe") || wantsDryRunOnly(normalizedText))
  ) {
    const jobId = extractToken(text, /\bfor\s+([A-Za-z0-9_.:-]+)/i);
    const runId = extractToken(text, /\brun\s*id\s*[:=]?\s*([A-Za-z0-9_.:-]+)/i);
    const dryRun = wantsDryRunOnly(text)
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

function isLatestWikipediaCitationRepairStatusCommand(text: string): boolean {
  return /^status last wikipedia citation repair( details?| full| audit)?$/.test(text);
}

function isOperatorStatusCommand(text: string): boolean {
  return /^(operator status|averray operator status|averray status)( details?| full| audit)?$/.test(text)
    || text === "help";
}

function isDailyOperatorBriefCommand(text: string): boolean {
  return /^(daily operator brief|operator brief|daily brief|morning brief|brief me|what is my brief)( details?| full| audit)?$/.test(text);
}

function isFindSafeWorkCommand(text: string): boolean {
  return /^(find safe work|safe work|next safe work|find work|what should i do next|operator todo)( details?| full| audit)?$/.test(text);
}

function isAgentUsefulnessPlanCommand(text: string): boolean {
  return /^(what can you do|what can you do for us|how can you help|how can you work for us|work for us|agent usefulness|agent usefulness plan|agent plan|usefulness plan|show use cases|show agent use cases)( details?| full| audit)?$/.test(text);
}

function isAdminReadinessCommand(text: string): boolean {
  return /^(admin readiness|project admin readiness|admin plan|project admin plan|can you be admin|can you admin my projects|how can you admin my projects|admin mode|future admin plan)( details?| full| audit)?$/.test(text);
}

function adminActionProposalInput(
  originalText: string,
  text: string,
  source: OperatorCommandSource
): AdminActionProposalInput | undefined {
  const compact = text.replace(/\b(details?|full|audit)\b/g, "").replace(/\s+/g, " ").trim();
  if (!/\b(propose|proposal|approval|approve|admin action)\b/.test(compact)) return undefined;
  const action = compact.includes("secret") || compact.includes("token") || compact.includes("credential")
    ? "secret_rotation"
    : compact.includes("rollback") || compact.includes("roll back")
      ? "rollback"
      : compact.includes("restart")
        ? "restart"
        : compact.includes("deploy")
          ? "deploy"
          : compact.includes("merge") || compact.includes("pr ")
            ? "merge"
            : "unknown";
  return {
    action,
    requester: source,
    reason: originalText.trim(),
    ...adminProposalTarget(originalText),
  };
}

function adminProposalTarget(text: string): Pick<AdminActionProposalInput, "repo" | "pullRequestNumber" | "sha"> {
  const repoWithPr = text.match(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/);
  const repo = repoWithPr?.[1]
    ?? extractToken(text, /\b(?:repo|repository|for)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i);
  const pullRequestNumber = repoWithPr?.[2]
    ? Number.parseInt(repoWithPr[2], 10)
    : numberToken(text, /\b(?:pr|pull request|pull-request|#)\s*#?(\d+)\b/i);
  const sha = extractToken(text, /\b(?:sha|commit)\s+([a-f0-9]{7,40})\b/i);
  return {
    ...(repo ? { repo } : {}),
    ...(pullRequestNumber ? { pullRequestNumber } : {}),
    ...(sha ? { sha } : {}),
  };
}

function isBusinessLedgerCommand(text: string): boolean {
  return /^(business ledger|averray business ledger|business status|business report|work ledger|reward ledger|run ledger)( details?| full| audit)?$/.test(text);
}

function isOpsHealthCommand(text: string): boolean {
  return /^(ops health|operator health|agent health|stack health|health check|control plane health|mcp health)( details?| full| audit)?$/.test(text);
}

function isHandoffMonitorCommand(text: string): boolean {
  return /^(handoff monitor|agent handoff monitor|hermes handoff monitor|hermes monitor|what is hermes doing|what is the agent doing|current handoffs|active handoffs|handoff status)( details?| full| audit)?$/.test(text);
}

function githubOperatorView(text: string): GithubOperatorView | undefined {
  const compact = text.replace(/\b(details?|full|audit)\b/g, "").replace(/\s+/g, " ").trim();
  if (/^(github status|github repo status|github repositories|github repos)$/.test(compact)) return "status";
  if (/^(github open prs|github prs|github pull requests|github open pull requests|open prs)$/.test(compact)) return "prs";
  if (/^(github ci|github ci failures|github failures|github checks|github actions|ci failures)$/.test(compact)) return "ci";
  if (/^(github issues|github issue digest|github open issues|issue digest)$/.test(compact)) return "issues";
  if (/^(github digest|github attention|github needs attention|github work digest)$/.test(compact)) return "digest";
  return undefined;
}

function isGithubBriefCommand(text: string): boolean {
  const compact = text.replace(/\b(details?|full|audit)\b/g, "").replace(/\s+/g, " ").trim();
  return /^(github brief|daily github brief|github daily brief|github changes|github changed|what changed since last time|what changed in github since last time|what merged|what deployed|what failed|what needs attention)$/.test(compact);
}

function isTestbedE2eSuiteCommand(text: string): boolean {
  const compact = text.replace(/\b(details?|full|audit)\b/g, "").replace(/\s+/g, " ").trim();
  return /^(testbed e2e|testbed e2e suite|platform e2e|platform e2e suite|e2e test suite|full e2e suite|testbed full suite|run testbed e2e|run platform e2e)$/.test(compact);
}

function isRunTestbedE2eReadOnlyCommand(text: string): boolean {
  const compact = text.replace(/\b(details?|full|audit)\b/g, "").replace(/\s+/g, " ").trim();
  return /^(run )?(testbed|platform)?\s*e2e read[-\s]*only$/.test(compact)
    || /^(run )?(testbed|platform) e2e suite read[-\s]*only$/.test(compact)
    || /^(run )?read[-\s]*only testbed e2e$/.test(compact);
}

function wantsDetailedOutput(text: string): boolean {
  return /\b(details?|full|audit)\b/.test(text);
}

function wantsDryRunOnly(text: string): boolean {
  return /\b(dry\s*run|preview|read[-\s]*only|no\s+submit)\b/i.test(text);
}

function extractToken(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match?.[1]?.replace(/[.,!?]+$/g, "");
}

function numberToken(text: string, pattern: RegExp): number | undefined {
  const token = extractToken(text, pattern);
  if (!token) return undefined;
  const value = Number.parseInt(token, 10);
  return Number.isFinite(value) ? value : undefined;
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
