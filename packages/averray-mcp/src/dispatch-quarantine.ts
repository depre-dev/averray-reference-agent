import { query as defaultQuery } from "@avg/mcp-common";

import {
  deriveIntendedRunId,
  type DispatchStoreDeps,
  type DispatchStoreQuery,
} from "./dispatch-claim.js";

const QUARANTINE_COLUMNS = `
  work_item_id,
  task_version,
  reason,
  fingerprint,
  cycle_count,
  quarantined_at,
  cleared_at,
  cleared_by
`;

export type DispatchQuarantineReason =
  | "poison_read"
  | "binding_integrity";

export interface DispatchQuarantine {
  workItemId: string;
  taskVersion: number;
  reason: DispatchQuarantineReason;
  fingerprint: string;
  cycleCount: number;
  quarantinedAt: string;
  clearedAt?: string;
  clearedBy?: string;
}

export interface MarkDispatchQuarantineInput {
  workItemId: string;
  taskVersion: number;
  reason: DispatchQuarantineReason;
  fingerprint: string;
  cycleCount: number;
}

export interface RunBindingAuditRow {
  workItemId: string;
  taskVersion: number;
  approvedTaskHash?: string;
  harnessRunId: string;
}

export type BindingIntegrityViolation =
  | {
      kind: "run_id_mismatch";
      workItemId: string;
      taskVersion: number;
      harnessRunId: string;
      intendedRunId?: string;
    }
  | {
      kind: "duplicate_run_id";
      workItemId: string;
      taskVersion: number;
      harnessRunId: string;
      conflictingWorkItemId: string;
      conflictingTaskVersion: number;
    };

interface DispatchQuarantineRow {
  work_item_id: string;
  task_version: number;
  reason: string;
  fingerprint: string;
  cycle_count: number;
  quarantined_at: string | Date;
  cleared_at: string | Date | null;
  cleared_by: string | null;
}

interface RunBindingAuditDatabaseRow {
  work_item_id: string;
  task_version: number;
  approved_task_hash: string | null;
  harness_run_id: string;
}

export async function markDispatchQuarantine(
  input: MarkDispatchQuarantineInput,
  deps: DispatchStoreDeps = {},
): Promise<{ marker: DispatchQuarantine; activated: boolean }> {
  assertMarkerInput(input);
  const rows = await storeQuery(deps)<DispatchQuarantineRow>(
    `insert into agent_task_dispatch_quarantines (
       work_item_id,
       task_version,
       reason,
       fingerprint,
       cycle_count,
       quarantined_at
     ) values ($1, $2, $3, $4, $5, now())
     on conflict (work_item_id, task_version) do update set
       reason = excluded.reason,
       fingerprint = excluded.fingerprint,
       cycle_count = excluded.cycle_count,
       quarantined_at = excluded.quarantined_at,
       cleared_at = null,
       cleared_by = null
     where agent_task_dispatch_quarantines.cleared_at is not null
     returning ${QUARANTINE_COLUMNS}`,
    [
      input.workItemId,
      input.taskVersion,
      input.reason,
      input.fingerprint,
      input.cycleCount,
    ],
  );
  if (rows.length > 1) {
    throw new Error(`Dispatch quarantine write returned ${rows.length} rows`);
  }
  if (rows[0]) {
    return { marker: parseQuarantineRow(rows[0]), activated: true };
  }
  const existing = await getActiveDispatchQuarantine(
    input.workItemId,
    input.taskVersion,
    deps,
  );
  if (!existing) {
    throw new Error(
      `Dispatch quarantine disappeared for ${input.workItemId}@${input.taskVersion}`,
    );
  }
  return { marker: existing, activated: false };
}

export async function getActiveDispatchQuarantine(
  workItemId: string,
  taskVersion: number,
  deps: DispatchStoreDeps = {},
): Promise<DispatchQuarantine | undefined> {
  const rows = await storeQuery(deps)<DispatchQuarantineRow>(
    `select ${QUARANTINE_COLUMNS}
     from agent_task_dispatch_quarantines
     where work_item_id = $1
       and task_version = $2
       and cleared_at is null
     limit 1`,
    [workItemId, taskVersion],
  );
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new Error(`Dispatch quarantine read returned ${rows.length} rows`);
  }
  return parseQuarantineRow(rows[0]!);
}

export async function listDispatchQuarantines(
  filter: { workItemId?: string; activeOnly?: boolean; limit?: number } = {},
  deps: DispatchStoreDeps = {},
): Promise<DispatchQuarantine[]> {
  const values: unknown[] = [];
  const clauses: string[] = [];
  if (filter.workItemId !== undefined) {
    values.push(filter.workItemId);
    clauses.push(`work_item_id = $${values.length}`);
  }
  if (filter.activeOnly !== false) clauses.push("cleared_at is null");
  const limit = normalizeLimit(filter.limit);
  values.push(limit);
  const rows = await storeQuery(deps)<DispatchQuarantineRow>(
    `select ${QUARANTINE_COLUMNS}
     from agent_task_dispatch_quarantines
     ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
     order by quarantined_at desc, work_item_id asc, task_version desc
     limit $${values.length}`,
    values,
  );
  return rows.map(parseQuarantineRow);
}

export async function clearDispatchQuarantine(
  input: { workItemId: string; taskVersion: number; operatorId: string },
  deps: DispatchStoreDeps = {},
): Promise<DispatchQuarantine | undefined> {
  if (!input.operatorId.trim()) {
    throw new Error("Dispatch quarantine operator id must not be empty");
  }
  const rows = await storeQuery(deps)<DispatchQuarantineRow>(
    `update agent_task_dispatch_quarantines
     set cleared_at = now(), cleared_by = $3
     where work_item_id = $1
       and task_version = $2
       and cleared_at is null
     returning ${QUARANTINE_COLUMNS}`,
    [input.workItemId, input.taskVersion, input.operatorId.trim()],
  );
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new Error(`Dispatch quarantine clear returned ${rows.length} rows`);
  }
  return parseQuarantineRow(rows[0]!);
}

export async function listRunBindingAuditRows(
  deps: DispatchStoreDeps = {},
): Promise<RunBindingAuditRow[]> {
  const rows = await storeQuery(deps)<RunBindingAuditDatabaseRow>(
    `select
       binding.work_item_id,
       binding.harness_run_id,
       task.task_version,
       task.approved_task_hash
     from agent_task_run_outbox binding
     join lateral (
       select task_version, approved_task_hash
       from agent_tasks
       where work_item_id = binding.work_item_id
       order by task_version desc
       limit 1
     ) task on true
     left join agent_task_dispatch_quarantines quarantine
       on quarantine.work_item_id = binding.work_item_id
      and quarantine.task_version = task.task_version
      and quarantine.cleared_at is null
     where quarantine.work_item_id is null
     order by binding.work_item_id asc`,
  );
  return rows.map((row) => ({
    workItemId: row.work_item_id,
    taskVersion: row.task_version,
    ...(row.approved_task_hash
      ? { approvedTaskHash: row.approved_task_hash }
      : {}),
    harnessRunId: row.harness_run_id,
  }));
}

export function findBindingIntegrityViolations(
  rows: readonly RunBindingAuditRow[],
): BindingIntegrityViolation[] {
  const violations: BindingIntegrityViolation[] = [];
  const byRunId = new Map<string, RunBindingAuditRow[]>();
  for (const row of rows) {
    const intendedRunId = row.approvedTaskHash
      ? deriveIntendedRunId(
          row.workItemId,
          row.taskVersion,
          row.approvedTaskHash,
        )
      : undefined;
    if (intendedRunId === undefined || row.harnessRunId !== intendedRunId) {
      violations.push({
        kind: "run_id_mismatch",
        workItemId: row.workItemId,
        taskVersion: row.taskVersion,
        harnessRunId: row.harnessRunId,
        ...(intendedRunId ? { intendedRunId } : {}),
      });
    }
    const peers = byRunId.get(row.harnessRunId) ?? [];
    peers.push(row);
    byRunId.set(row.harnessRunId, peers);
  }
  for (const [harnessRunId, peers] of byRunId) {
    if (peers.length < 2) continue;
    for (const row of peers) {
      const peer = peers.find((candidate) =>
        candidate.workItemId !== row.workItemId
        || candidate.taskVersion !== row.taskVersion);
      if (!peer) continue;
      violations.push({
        kind: "duplicate_run_id",
        workItemId: row.workItemId,
        taskVersion: row.taskVersion,
        harnessRunId,
        conflictingWorkItemId: peer.workItemId,
        conflictingTaskVersion: peer.taskVersion,
      });
    }
  }
  return violations;
}

function assertMarkerInput(input: MarkDispatchQuarantineInput): void {
  if (!input.workItemId.trim()) {
    throw new Error("Dispatch quarantine work item id must not be empty");
  }
  if (!Number.isSafeInteger(input.taskVersion) || input.taskVersion < 1) {
    throw new Error("Dispatch quarantine task version must be positive");
  }
  if (!input.fingerprint.trim()) {
    throw new Error("Dispatch quarantine fingerprint must not be empty");
  }
  if (!Number.isSafeInteger(input.cycleCount) || input.cycleCount < 1) {
    throw new Error("Dispatch quarantine cycle count must be positive");
  }
}

function parseQuarantineRow(row: DispatchQuarantineRow): DispatchQuarantine {
  if (row.reason !== "poison_read" && row.reason !== "binding_integrity") {
    throw new Error("Stored dispatch quarantine reason is unsupported");
  }
  return {
    workItemId: row.work_item_id,
    taskVersion: row.task_version,
    reason: row.reason,
    fingerprint: row.fingerprint,
    cycleCount: row.cycle_count,
    quarantinedAt: timestamp(row.quarantined_at),
    ...(row.cleared_at ? { clearedAt: timestamp(row.cleared_at) } : {}),
    ...(row.cleared_by ? { clearedBy: row.cleared_by } : {}),
  };
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Dispatch quarantine list limit must be positive");
  }
  return Math.min(value, 1_000);
}

function storeQuery(deps: DispatchStoreDeps): DispatchStoreQuery {
  return deps.query ?? defaultQuery;
}
