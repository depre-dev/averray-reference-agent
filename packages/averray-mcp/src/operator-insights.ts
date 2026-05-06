import type { LastWikipediaCitationRepairStatus } from "./operator-commands.js";
import { getLastWikipediaCitationRepairStatus } from "./operator-commands.js";
import type { OperatorStatusDeps } from "./operator-status.js";
import { getOperatorStatus } from "./operator-status.js";

export async function getBusinessLedger(deps: OperatorStatusDeps) {
  const [status, latestRun, submitStats, draftStats, operatorStats] = await Promise.all([
    getOperatorStatus(deps),
    getLastWikipediaCitationRepairStatus(deps.query).catch(() => {
      return { found: false, source: "none", submitSucceeded: false, slackPermalink: null } satisfies LastWikipediaCitationRepairStatus;
    }),
    querySubmitStats(deps),
    queryDraftStats(deps),
    queryOperatorStats(deps),
  ]);
  const wikipedia = status.workflows.wikipediaCitationRepair;
  return {
    schemaVersion: 1,
    kind: "business_ledger",
    generatedAt: status.generatedAt,
    mutates: false,
    summary: {
      latestWikipediaCitationRepair: latestRun,
      openWikipediaCitationRepairJobs: wikipedia.openJobs,
      discoveredWikipediaCitationRepairJobs: wikipedia.discoveredJobs,
      budget: status.policy.budget,
      sevenDaySubmissions: submitStats,
      sevenDayDrafts: draftStats,
      sevenDayOperatorCommands: operatorStats,
    },
    recommendedNextActions: status.recommendedNextActions,
    safety: {
      mutatesByDefault: false,
      source: "postgres_read_only",
      editsWikipedia: false,
    },
  };
}

export async function getOpsHealth(deps: OperatorStatusDeps) {
  const [status, tableStats, recentOperatorEvents, latestErrors] = await Promise.all([
    getOperatorStatus(deps),
    queryTableStats(deps),
    queryRecentOperatorEvents(deps),
    queryRecentErrors(deps),
  ]);
  const health = healthFromStatus(status, tableStats, latestErrors);
  return {
    schemaVersion: 1,
    kind: "ops_health",
    generatedAt: status.generatedAt,
    mutates: false,
    health,
    wallet: status.agent,
    budget: status.policy.budget,
    wikipediaCitationRepair: {
      ready: status.workflows.wikipediaCitationRepair.ready,
      openJobs: status.workflows.wikipediaCitationRepair.openJobs,
      latestRun: status.workflows.wikipediaCitationRepair.latestRun,
    },
    controlPlane: {
      tables: tableStats,
      recentOperatorEvents,
      recentErrors: latestErrors,
      note: "This is database/control-plane health. Container disk, SQLite WAL files, and raw MCP stderr logs require a host-level ops check.",
    },
    recommendedNextActions: opsNextActions(health, status.errors ?? []),
    safety: {
      mutatesByDefault: false,
      source: "postgres_read_only",
      editsWikipedia: false,
    },
  };
}

async function querySubmitStats(deps: OperatorStatusDeps) {
  const rows = await deps.query<CountStatsRow>(
    `select
       count(*)::int as total,
       count(*) filter (where status = 'completed')::int as completed,
       count(*) filter (where status = 'failed')::int as failed,
       count(*) filter (where status not in ('completed', 'failed'))::int as other
     from submissions
     where kind = 'submit'
       and coalesce(request->>'jobId', '') like 'wiki-en-%citation-repair%'
       and updated_at >= now() - interval '7 days'`
  ).catch(() => []);
  return countStats(rows[0]);
}

async function queryDraftStats(deps: OperatorStatusDeps) {
  const rows = await deps.query<CountStatsRow>(
    `select
       count(*)::int as total,
       count(*) filter (where validation_status = 'valid')::int as completed,
       count(*) filter (where validation_status = 'invalid')::int as failed,
       count(*) filter (where validation_status = 'unvalidated')::int as other
     from draft_submissions
     where job_id like 'wiki-en-%citation-repair%'
       and updated_at >= now() - interval '7 days'`
  ).catch(() => []);
  return {
    total: numberField(rows[0], "total"),
    valid: numberField(rows[0], "completed"),
    invalid: numberField(rows[0], "failed"),
    unvalidated: numberField(rows[0], "other"),
  };
}

async function queryOperatorStats(deps: OperatorStatusDeps) {
  const rows = await deps.query<CountStatsRow>(
    `select
       count(*)::int as total,
       count(*) filter (where source like 'slack%')::int as completed,
       count(*) filter (where status = 'failed')::int as failed,
       count(distinct normalized_text)::int as other
     from operator_command_events
     where updated_at >= now() - interval '7 days'`
  ).catch(() => []);
  return {
    total: numberField(rows[0], "total"),
    slackRouted: numberField(rows[0], "completed"),
    failed: numberField(rows[0], "failed"),
    distinctCommands: numberField(rows[0], "other"),
  };
}

async function queryTableStats(deps: OperatorStatusDeps) {
  const rows = await deps.query<TableStatsRow>(
    `select
       (select count(*)::int from runs) as runs,
       (select count(*)::int from submissions) as submissions,
       (select count(*)::int from draft_submissions) as drafts,
       (select count(*)::int from operator_command_events) as operator_events,
       (select count(*)::int from budgets) as budgets,
       (select max(updated_at) from operator_command_events) as last_operator_event_at,
       (select max(updated_at) from submissions) as last_submission_at`
  ).catch(() => []);
  const row = rows[0] ?? {};
  return {
    runs: numberField(row, "runs"),
    submissions: numberField(row, "submissions"),
    drafts: numberField(row, "drafts"),
    operatorEvents: numberField(row, "operator_events"),
    budgets: numberField(row, "budgets"),
    lastOperatorEventAt: dateString(row.last_operator_event_at),
    lastSubmissionAt: dateString(row.last_submission_at),
  };
}

async function queryRecentOperatorEvents(deps: OperatorStatusDeps) {
  const rows = await deps.query<OperatorEventRow>(
    `select normalized_text, source, status, updated_at
     from operator_command_events
     order by updated_at desc
     limit 5`
  ).catch(() => []);
  return rows.map((row) => ({
    command: stringField(row, "normalized_text"),
    source: stringField(row, "source"),
    status: stringField(row, "status"),
    updatedAt: dateString(row.updated_at),
  }));
}

async function queryRecentErrors(deps: OperatorStatusDeps) {
  const rows = await deps.query<OperatorEventRow>(
    `select normalized_text, source, status, updated_at
     from operator_command_events
     where status = 'failed'
     order by updated_at desc
     limit 3`
  ).catch(() => []);
  return rows.map((row) => ({
    command: stringField(row, "normalized_text"),
    source: stringField(row, "source"),
    status: stringField(row, "status"),
    updatedAt: dateString(row.updated_at),
  }));
}

function healthFromStatus(
  status: Awaited<ReturnType<typeof getOperatorStatus>>,
  tableStats: Awaited<ReturnType<typeof queryTableStats>>,
  latestErrors: Awaited<ReturnType<typeof queryRecentErrors>>
) {
  const errors = status.errors ?? [];
  if (!status.agent.walletReady) return "blocked";
  if (errors.length > 0 || latestErrors.length > 0) return "degraded";
  if (tableStats.operatorEvents === 0 && tableStats.submissions === 0) return "quiet";
  return "ready";
}

function opsNextActions(health: string, errors: string[]) {
  if (health === "blocked") return ["Fix wallet readiness before allowing mutation workflows."];
  if (health === "degraded") return [
    "Inspect recent operator errors and MCP/server logs.",
    ...errors.map((error) => `Status error: ${error}`),
  ];
  return [
    "Keep daily brief and safe-work scans enabled.",
    "Run a host-level ops check periodically for disk, logs, and SQLite WAL housekeeping.",
  ];
}

function countStats(row: CountStatsRow | undefined) {
  return {
    total: numberField(row, "total"),
    completed: numberField(row, "completed"),
    failed: numberField(row, "failed"),
    other: numberField(row, "other"),
  };
}

interface CountStatsRow {
  total?: number | string;
  completed?: number | string;
  failed?: number | string;
  other?: number | string;
}

interface TableStatsRow {
  runs?: number | string;
  submissions?: number | string;
  drafts?: number | string;
  operator_events?: number | string;
  budgets?: number | string;
  last_operator_event_at?: string | Date;
  last_submission_at?: string | Date;
}

interface OperatorEventRow {
  normalized_text?: string;
  source?: string;
  status?: string;
  updated_at?: string | Date;
}

function numberField(value: unknown, key: string): number {
  const record = toRecord(value);
  const raw = record[key];
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? "0"), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringField(value: unknown, key: string): string | undefined {
  const record = toRecord(value);
  const field = record[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function dateString(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
