import { Pool } from "pg";

import type { HarnessSourceState, WatchdogDatabaseProbes } from "./watchdog.js";

interface HarnessSourceRow {
  live_run: boolean;
  newest_event_at: Date | string | null;
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
