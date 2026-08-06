import { query as defaultQuery } from "@avg/mcp-common";

import {
  type DispatchStoreDeps,
  type DispatchStoreQuery,
} from "./dispatch-claim.js";

export interface DispatchBackpressureState {
  active: boolean;
  observedInflight: number;
  maxInflight: number;
  changedAt: string;
}

interface CountRow {
  count: number | string;
}

interface BackpressureRow {
  active: boolean;
  observed_inflight: number;
  max_inflight: number;
  changed_at: string | Date;
}

export async function countInflightHarnessRuns(
  deps: DispatchStoreDeps = {},
): Promise<number> {
  const rows = await storeQuery(deps)<CountRow>(
    `select count(*)::integer as count
     from agent_task_run_outbox bindings
     join lateral (
       select lifecycle
       from agent_tasks tasks
       where tasks.work_item_id = bindings.work_item_id
       order by tasks.task_version desc
       limit 1
     ) latest on true
     where latest.lifecycle in ('dispatching', 'running', 'verifying')`,
  );
  if (rows.length !== 1) {
    throw new Error(`Dispatch in-flight count returned ${rows.length} rows`);
  }
  const count = Number(rows[0]!.count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Dispatch in-flight count is invalid");
  }
  return count;
}

export async function getDispatchBackpressure(
  deps: DispatchStoreDeps = {},
): Promise<DispatchBackpressureState | undefined> {
  const rows = await storeQuery(deps)<BackpressureRow>(
    `select active, observed_inflight, max_inflight, changed_at
     from harness_dispatch_backpressure
     where state_id = 'global'
     limit 1`,
  );
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new Error(`Dispatch backpressure read returned ${rows.length} rows`);
  }
  return parseBackpressureRow(rows[0]!);
}

export async function transitionDispatchBackpressure(
  input: { active: boolean; observedInflight: number; maxInflight: number },
  deps: DispatchStoreDeps = {},
): Promise<{ state: DispatchBackpressureState; changed: boolean }> {
  assertCount(input.observedInflight, "observed in-flight count", true);
  assertCount(input.maxInflight, "maximum in-flight count", false);
  const previous = await getDispatchBackpressure(deps);
  const rows = await storeQuery(deps)<BackpressureRow>(
    `insert into harness_dispatch_backpressure (
       state_id, active, observed_inflight, max_inflight, changed_at
     ) values ('global', $1, $2, $3, now())
     on conflict (state_id) do update set
       active = excluded.active,
       observed_inflight = excluded.observed_inflight,
       max_inflight = excluded.max_inflight,
       changed_at = case
         when harness_dispatch_backpressure.active <> excluded.active
           then now()
         else harness_dispatch_backpressure.changed_at
       end
     returning active, observed_inflight, max_inflight, changed_at`,
    [input.active, input.observedInflight, input.maxInflight],
  );
  if (rows.length !== 1) {
    throw new Error(`Dispatch backpressure transition returned ${rows.length} rows`);
  }
  return {
    state: parseBackpressureRow(rows[0]!),
    changed: previous === undefined || previous.active !== input.active,
  };
}

function parseBackpressureRow(row: BackpressureRow): DispatchBackpressureState {
  return {
    active: row.active,
    observedInflight: row.observed_inflight,
    maxInflight: row.max_inflight,
    changedAt: row.changed_at instanceof Date
      ? row.changed_at.toISOString()
      : new Date(row.changed_at).toISOString(),
  };
}

function assertCount(value: number, label: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`Dispatch ${label} is invalid`);
  }
}

function storeQuery(deps: DispatchStoreDeps): DispatchStoreQuery {
  return deps.query ?? defaultQuery;
}
