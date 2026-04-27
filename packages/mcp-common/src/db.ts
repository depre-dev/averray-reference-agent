import { Pool } from "pg";
import { optionalEnv } from "./config.js";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: optionalEnv("DATABASE_URL", "postgres://avg_agent:avg_agent@localhost:5432/avg_agent")
    });
  }
  return pool;
}

export async function query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  const result = await getPool().query(text, values);
  return result.rows as T[];
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function assertNoKillSwitch(toolName: string): Promise<void> {
  const haltFile = optionalEnv("HALT_FILE", "/data/HALT");
  const fs = await import("node:fs");
  if (fs.existsSync(haltFile)) {
    throw new Error(`Kill switch active via ${haltFile}; refusing ${toolName}`);
  }
  const rows = await query<{ active: boolean; reason: string | null }>(
    "select active, reason from kill_switches where name = 'global' limit 1"
  ).catch(() => []);
  if (rows[0]?.active) {
    throw new Error(`Kill switch active: ${rows[0].reason ?? "no reason"}`);
  }
}

