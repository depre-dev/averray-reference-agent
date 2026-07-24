import { query as defaultQuery } from "@avg/mcp-common";
import {
  agentTaskV1Schema,
  type AgentTaskV1,
  type AgentTaskLifecycle,
} from "@avg/schemas";

export type AgentTaskExecutorKind = AgentTaskV1["executor"]["kind"];

export interface AgentTaskListFilter {
  workItemId?: string;
  correlationId?: string;
  lifecycle?: AgentTaskLifecycle;
  executorKind?: AgentTaskExecutorKind;
  limit?: number;
}

export type AgentTaskStoreQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<T[]>;

export interface AgentTaskStoreDeps {
  query?: AgentTaskStoreQuery;
}

interface AgentTaskRow {
  work_item_id: string;
  task_version: number;
  correlation_id: string;
  lifecycle: string;
  executor_kind: string;
  approved_task_hash: string | null;
  deadline: string | Date;
  updated_at: string | Date;
  task: unknown;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;
const SELECT_COLUMNS = `
  work_item_id,
  task_version,
  correlation_id,
  lifecycle,
  executor_kind,
  approved_task_hash,
  deadline,
  updated_at,
  task
`;

export async function putAgentTask(
  input: AgentTaskV1,
  deps: AgentTaskStoreDeps = {},
): Promise<AgentTaskV1> {
  const task = agentTaskV1Schema.parse(input);
  const rows = await storeQuery(deps)<AgentTaskRow>(
    `insert into agent_tasks (
       work_item_id,
       task_version,
       correlation_id,
       lifecycle,
       executor_kind,
       approved_task_hash,
       deadline,
       updated_at,
       task
     ) values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::jsonb)
     on conflict (work_item_id, task_version) do update set
       correlation_id = excluded.correlation_id,
       lifecycle = excluded.lifecycle,
       executor_kind = excluded.executor_kind,
       approved_task_hash = excluded.approved_task_hash,
       deadline = excluded.deadline,
       updated_at = excluded.updated_at,
       task = excluded.task
     returning ${SELECT_COLUMNS}`,
    taskValues(task),
  );
  return parseSingleRow(rows, "put");
}

export async function getAgentTask(
  workItemId: string,
  taskVersion: number,
  deps: AgentTaskStoreDeps = {},
): Promise<AgentTaskV1 | undefined> {
  const rows = await storeQuery(deps)<AgentTaskRow>(
    `select ${SELECT_COLUMNS}
     from agent_tasks
     where work_item_id = $1 and task_version = $2
     limit 1`,
    [workItemId, taskVersion],
  );
  if (rows.length === 0) return undefined;
  return parseSingleRow(rows, "get");
}

export async function listAgentTasks(
  filter: AgentTaskListFilter = {},
  deps: AgentTaskStoreDeps = {},
): Promise<AgentTaskV1[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    clauses.push(`${column} = $${values.length}`);
  };

  if (filter.workItemId !== undefined) add("work_item_id", filter.workItemId);
  if (filter.correlationId !== undefined) add("correlation_id", filter.correlationId);
  if (filter.lifecycle !== undefined) add("lifecycle", filter.lifecycle);
  if (filter.executorKind !== undefined) add("executor_kind", filter.executorKind);
  const limit = normalizedLimit(filter.limit);
  values.push(limit);

  const rows = await storeQuery(deps)<AgentTaskRow>(
    `select ${SELECT_COLUMNS}
     from agent_tasks
     ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
     order by updated_at desc, work_item_id asc, task_version desc
     limit $${values.length}`,
    values,
  );
  return rows.map(parseAgentTaskRow);
}

export async function listDispatchableAgentTasks(
  deps: AgentTaskStoreDeps = {},
): Promise<AgentTaskV1[]> {
  const rows = await storeQuery(deps)<AgentTaskRow>(
    `select ${SELECT_COLUMNS}
     from agent_tasks
     where executor_kind = 'harness'
       and lifecycle = 'approved'
       and approved_task_hash is not null
     order by updated_at asc, work_item_id asc, task_version asc
     limit $1`,
    [MAX_LIST_LIMIT],
  );
  return rows
    .map(parseAgentTaskRow)
    .filter(isDispatchableAgentTask);
}

export function isDispatchableAgentTask(task: AgentTaskV1): boolean {
  return task.executor.kind === "harness"
    && task.lifecycle === "approved"
    && task.approval.approvedTaskHash !== undefined;
}

function taskValues(task: AgentTaskV1): unknown[] {
  return [
    task.workItemId,
    task.taskVersion,
    task.correlationId,
    task.lifecycle,
    task.executor.kind,
    task.approval.approvedTaskHash ?? null,
    task.deadline,
    task.timestamps.updatedAt,
    JSON.stringify(task),
  ];
}

function parseSingleRow(rows: AgentTaskRow[], operation: string): AgentTaskV1 {
  if (rows.length !== 1) {
    throw new Error(`AgentTask store ${operation} expected one row, received ${rows.length}`);
  }
  return parseAgentTaskRow(rows[0]!);
}

function parseAgentTaskRow(row: AgentTaskRow): AgentTaskV1 {
  const rawTask = typeof row.task === "string" ? JSON.parse(row.task) as unknown : row.task;
  const task = agentTaskV1Schema.parse(rawTask);
  const expected = {
    workItemId: row.work_item_id,
    taskVersion: row.task_version,
    correlationId: row.correlation_id,
    lifecycle: row.lifecycle,
    executorKind: row.executor_kind,
    approvedTaskHash: row.approved_task_hash ?? undefined,
    deadline: timestamp(row.deadline),
    updatedAt: timestamp(row.updated_at),
  };
  const actual = {
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    correlationId: task.correlationId,
    lifecycle: task.lifecycle,
    executorKind: task.executor.kind,
    approvedTaskHash: task.approval.approvedTaskHash,
    deadline: timestamp(task.deadline),
    updatedAt: timestamp(task.timestamps.updatedAt),
  };
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`AgentTask row columns do not match task JSON for ${task.workItemId}@${task.taskVersion}`);
  }
  return task;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("AgentTask list limit must be a positive safe integer");
  }
  return Math.min(value, MAX_LIST_LIMIT);
}

function storeQuery(deps: AgentTaskStoreDeps): AgentTaskStoreQuery {
  return deps.query ?? defaultQuery;
}
