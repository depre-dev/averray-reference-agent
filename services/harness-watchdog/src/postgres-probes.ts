import { Pool } from "pg";

import type {
  HarnessRunInventoryRow,
  HarnessSourceState,
  ReferenceBindingInventoryRow,
  WatchdogDatabaseProbes,
} from "./watchdog.js";

interface HarnessSourceRow {
  live_run: boolean;
  newest_event_at: Date | string | null;
}

interface ReferenceBindingRow {
  work_item_id: string;
  harness_run_id: string;
  bound_at: Date | string;
  task_version: number;
  approved_task_hash: string | null;
  lifecycle: string;
  task_updated_at: Date | string;
}

interface HarnessRunRow {
  run_id: string;
  outcome: string | null;
  updated_at: Date | string;
}

export interface ProductionWatchdogDatabaseProbes extends WatchdogDatabaseProbes {
  close(): Promise<void>;
}

export function createPostgresWatchdogProbes(options: {
  referenceDatabaseUrl?: string;
  harnessDatabaseUrl?: string;
  connectionTimeoutMs?: number;
}): ProductionWatchdogDatabaseProbes {
  const connectionTimeoutMillis = options.connectionTimeoutMs ?? 5_000;
  const referenceDatabaseUrl = options.referenceDatabaseUrl?.trim();
  const harnessDatabaseUrl = options.harnessDatabaseUrl?.trim();
  const referencePool = referenceDatabaseUrl
    ? new Pool({
        connectionString: referenceDatabaseUrl,
        connectionTimeoutMillis,
        query_timeout: connectionTimeoutMillis,
      })
    : undefined;
  const harnessPool = harnessDatabaseUrl
    ? new Pool({
        connectionString: harnessDatabaseUrl,
        connectionTimeoutMillis,
        query_timeout: connectionTimeoutMillis,
      })
    : undefined;

  // pg emits an EventEmitter "error" when an idle pooled connection dies.
  // Without listeners, stopping either watched database terminates Node before
  // the next read-only probe can turn the outage into an alert.
  referencePool?.on("error", () => {});
  harnessPool?.on("error", () => {});

  return {
    async probeReferenceDatabase(): Promise<void> {
      if (!referencePool) throw new DatabaseProbeConfigurationError("reference");
      await referencePool.query("select 1");
    },
    async probeHarnessDatabase(): Promise<HarnessSourceState> {
      if (!harnessPool) throw new DatabaseProbeConfigurationError("harness");
      const result = await harnessPool.query<HarnessSourceRow>(
        `select
           exists(select 1 from runs where outcome is null) as live_run,
           (select max(ts) from domain_events) as newest_event_at`,
      );
      const row = result.rows[0];
      return {
        liveRun: row?.live_run === true,
        newestEventAt: parseTimestamp(row?.newest_event_at),
      };
    },
    async readReferenceBindings(): Promise<ReferenceBindingInventoryRow[]> {
      if (!referencePool) throw new DatabaseProbeConfigurationError("reference");
      const result = await referencePool.query<ReferenceBindingRow>(
        `select
           binding.work_item_id,
           binding.harness_run_id,
           binding.bound_at,
           task.task_version,
           task.approved_task_hash,
           task.lifecycle,
           task.updated_at as task_updated_at
         from agent_task_run_outbox binding
         join lateral (
           select task_version, approved_task_hash, lifecycle, updated_at
           from agent_tasks
           where work_item_id = binding.work_item_id
           order by task_version desc
           limit 1
         ) task on true
         order by binding.work_item_id asc`,
      );
      return result.rows.map((row) => ({
        workItemId: row.work_item_id,
        taskVersion: row.task_version,
        approvedTaskHash: row.approved_task_hash,
        harnessRunId: row.harness_run_id,
        lifecycle: row.lifecycle,
        boundAt: timestamp(row.bound_at),
        taskUpdatedAt: timestamp(row.task_updated_at),
      }));
    },
    async readHarnessRuns(): Promise<HarnessRunInventoryRow[]> {
      if (!harnessPool) throw new DatabaseProbeConfigurationError("harness");
      const result = await harnessPool.query<HarnessRunRow>(
        `select run_id, outcome, updated_at
         from runs
         order by run_id asc`,
      );
      return result.rows.map((row) => ({
        runId: row.run_id,
        terminal: row.outcome !== null,
        updatedAt: timestamp(row.updated_at),
      }));
    },
    async close(): Promise<void> {
      await Promise.all([
        referencePool?.end(),
        harnessPool?.end(),
      ]);
    },
  };
}

export class DatabaseProbeConfigurationError extends Error {
  constructor(readonly database: "reference" | "harness") {
    super(`${database} database connection is not configured`);
    this.name = "DatabaseProbeConfigurationError";
  }
}

function parseTimestamp(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
