import { query as defaultQuery } from "@avg/mcp-common";

import {
  type DispatchStoreDeps,
  type DispatchStoreQuery,
} from "./dispatch-claim.js";

export interface DispatchPolicyIdentity {
  version: string;
  hash: string;
}

export interface DispatchPolicyDriftState {
  workItemId: string;
  taskVersion: number;
  active: boolean;
  approvedPolicy: DispatchPolicyIdentity;
  activePolicy: DispatchPolicyIdentity;
  changedAt: string;
}

interface PolicyDriftRow {
  work_item_id: string;
  task_version: number;
  active: boolean;
  approved_policy_version: string;
  approved_policy_hash: string;
  active_policy_version: string;
  active_policy_hash: string;
  changed_at: string | Date;
  alert_pending?: boolean;
}

const SELECT_COLUMNS = `
  work_item_id,
  task_version,
  active,
  approved_policy_version,
  approved_policy_hash,
  active_policy_version,
  active_policy_hash,
  changed_at
`;

export async function getDispatchPolicyDrift(
  workItemId: string,
  taskVersion: number,
  deps: DispatchStoreDeps = {},
): Promise<DispatchPolicyDriftState | undefined> {
  const rows = await storeQuery(deps)<PolicyDriftRow>(
    `select ${SELECT_COLUMNS}
     from harness_dispatch_policy_drift
     where work_item_id = $1 and task_version = $2
     limit 1`,
    [workItemId, taskVersion],
  );
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new Error(`Dispatch policy drift read returned ${rows.length} rows`);
  }
  return parsePolicyDriftRow(rows[0]!);
}

export async function listDispatchPolicyDrifts(
  filter: { workItemId?: string; activeOnly?: boolean; limit?: number } = {},
  deps: DispatchStoreDeps = {},
): Promise<DispatchPolicyDriftState[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.workItemId !== undefined) {
    values.push(filter.workItemId);
    clauses.push(`work_item_id = $${values.length}`);
  }
  if (filter.activeOnly === true) clauses.push("active = true");
  values.push(normalizedLimit(filter.limit));
  const rows = await storeQuery(deps)<PolicyDriftRow>(
    `select ${SELECT_COLUMNS}
     from harness_dispatch_policy_drift
     ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
     order by changed_at desc, work_item_id asc, task_version desc
     limit $${values.length}`,
    values,
  );
  return rows.map(parsePolicyDriftRow);
}

export async function transitionDispatchPolicyDrift(
  input: {
    workItemId: string;
    taskVersion: number;
    active: boolean;
    approvedPolicy: DispatchPolicyIdentity;
    activePolicy: DispatchPolicyIdentity;
  },
  deps: DispatchStoreDeps = {},
): Promise<{ state: DispatchPolicyDriftState; notify: boolean }> {
  assertIdentity(input.approvedPolicy, "approved");
  assertIdentity(input.activePolicy, "active");
  if (!input.workItemId.trim() || !Number.isSafeInteger(input.taskVersion) || input.taskVersion < 1) {
    throw new Error("Dispatch policy drift identity is invalid");
  }
  const rows = await storeQuery(deps)<PolicyDriftRow>(
    `insert into harness_dispatch_policy_drift (
       work_item_id,
       task_version,
       active,
       approved_policy_version,
       approved_policy_hash,
       active_policy_version,
       active_policy_hash,
       changed_at,
       alert_pending
     ) values ($1, $2, $3, $4, $5, $6, $7, now(), $3)
     on conflict (work_item_id, task_version) do update set
       active = excluded.active,
       approved_policy_version = excluded.approved_policy_version,
       approved_policy_hash = excluded.approved_policy_hash,
       active_policy_version = excluded.active_policy_version,
       active_policy_hash = excluded.active_policy_hash,
       changed_at = case
         when harness_dispatch_policy_drift.active <> excluded.active
           or harness_dispatch_policy_drift.approved_policy_version <> excluded.approved_policy_version
           or harness_dispatch_policy_drift.approved_policy_hash <> excluded.approved_policy_hash
           or harness_dispatch_policy_drift.active_policy_version <> excluded.active_policy_version
           or harness_dispatch_policy_drift.active_policy_hash <> excluded.active_policy_hash
           then now()
         else harness_dispatch_policy_drift.changed_at
       end,
       alert_pending = case
         when excluded.active and (
           harness_dispatch_policy_drift.active <> excluded.active
           or harness_dispatch_policy_drift.approved_policy_version <> excluded.approved_policy_version
           or harness_dispatch_policy_drift.approved_policy_hash <> excluded.approved_policy_hash
           or harness_dispatch_policy_drift.active_policy_version <> excluded.active_policy_version
           or harness_dispatch_policy_drift.active_policy_hash <> excluded.active_policy_hash
         ) then true
         when not excluded.active then false
         else harness_dispatch_policy_drift.alert_pending
       end
     returning ${SELECT_COLUMNS}, alert_pending`,
    [
      input.workItemId,
      input.taskVersion,
      input.active,
      input.approvedPolicy.version,
      input.approvedPolicy.hash,
      input.activePolicy.version,
      input.activePolicy.hash,
    ],
  );
  if (rows.length !== 1) {
    throw new Error(`Dispatch policy drift transition returned ${rows.length} rows`);
  }
  const state = parsePolicyDriftRow(rows[0]!);
  if (rows[0]!.alert_pending !== true) return { state, notify: false };
  const claimed = await storeQuery(deps)<PolicyDriftRow>(
    `update harness_dispatch_policy_drift
     set alert_pending = false
     where work_item_id = $1 and task_version = $2 and alert_pending = true
     returning ${SELECT_COLUMNS}`,
    [input.workItemId, input.taskVersion],
  );
  return { state, notify: claimed.length === 1 };
}

function parsePolicyDriftRow(row: PolicyDriftRow): DispatchPolicyDriftState {
  return {
    workItemId: row.work_item_id,
    taskVersion: row.task_version,
    active: row.active,
    approvedPolicy: {
      version: row.approved_policy_version,
      hash: row.approved_policy_hash,
    },
    activePolicy: {
      version: row.active_policy_version,
      hash: row.active_policy_hash,
    },
    changedAt: row.changed_at instanceof Date
      ? row.changed_at.toISOString()
      : new Date(row.changed_at).toISOString(),
  };
}

function assertIdentity(identity: DispatchPolicyIdentity, label: string): void {
  if (!identity.version.trim() || !/^sha256:[a-f0-9]{64}$/u.test(identity.hash)) {
    throw new Error(`Dispatch ${label} policy identity is invalid`);
  }
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Dispatch policy drift list limit must be a positive safe integer");
  }
  return Math.min(value, 1_000);
}

function storeQuery(deps: DispatchStoreDeps): DispatchStoreQuery {
  return deps.query ?? defaultQuery;
}
