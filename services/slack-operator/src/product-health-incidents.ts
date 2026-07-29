// Durable incident memory for the product-health monitor.
//
// WHY THIS EXISTS: incidents used to be DERIVED from the rolling sample buffer
// (`deriveIncidents(history)` over a 60-slot ring). When a sample aged out, the
// incident computed from it ceased to exist — so at the 5-minute cadence Hermes
// forgot everything older than ~5 hours. A real 10.2s /health spike on
// 2026-07-28 was detected, displayed, and then evaporated before it could be
// investigated. An incident you can't look up after the fact is an incident the
// monitor didn't really record.
//
// The sample ring stays as-is (it drives sparklines/trends and must stay bounded).
// This adds a separate append-only JSONL log of incident RECORDS — a few fields
// each — mirroring the LLM-usage log. It survives restarts, which matters
// because the slack-operator restarts on every deploy: in-memory retention would
// still lose the overnight incident whenever a deploy landed before anyone looked.
//
// Append-only with last-write-wins per id: an incident is written when it opens
// and rewritten when it closes, so a crash mid-run can never corrupt earlier
// records — the worst case is an incident that stays open until the next tick
// reconciles it.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProductHealthIncident } from "./product-health.js";

const DEFAULT_INCIDENT_LOG_PATH = "/data/product-health-incidents.jsonl";

export function incidentLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PRODUCT_HEALTH_INCIDENT_LOG_PATH?.trim() || DEFAULT_INCIDENT_LOG_PATH;
}

/**
 * Merge freshly-derived incidents into the persisted set. PURE — the
 * last-write-wins reasoning is the part worth testing without a filesystem.
 *
 * Returns the full merged view (newest first, capped) plus only the records
 * that actually need writing, so a steady state writes nothing.
 */
export function reconcileIncidents(input: {
  persisted: readonly ProductHealthIncident[];
  derived: readonly ProductHealthIncident[];
  limit: number;
}): { merged: ProductHealthIncident[]; writes: ProductHealthIncident[] } {
  const byId = new Map<string, ProductHealthIncident>();
  for (const incident of input.persisted) byId.set(incident.id, incident);

  const writes: ProductHealthIncident[] = [];
  for (const incident of input.derived) {
    const existing = byId.get(incident.id);
    // New incident, or one that changed state (usually open → closed). Comparing
    // the whole record also catches a note that sharpened as the run went on.
    if (!existing || !sameIncident(existing, incident)) {
      writes.push(incident);
      byId.set(incident.id, incident);
    }
  }

  const merged = [...byId.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, input.limit);
  return { merged, writes };
}

function sameIncident(a: ProductHealthIncident, b: ProductHealthIncident): boolean {
  return (
    a.severity === b.severity &&
    a.startedAt === b.startedAt &&
    (a.endedAt ?? null) === (b.endedAt ?? null) &&
    (a.note ?? "") === (b.note ?? "")
  );
}

/**
 * Read the incident log, collapsing by id so the last record for an id wins
 * (that's how a close supersedes the open). A missing file is an empty history,
 * not an error — the first run has nothing to read.
 */
export async function readIncidents(path: string = incidentLogPath()): Promise<ProductHealthIncident[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOENT") return [];
    throw error;
  }
  const byId = new Map<string, ProductHealthIncident>();
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseIncidentLine(line);
    if (parsed) byId.set(parsed.id, parsed);
  }
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export async function appendIncidents(
  incidents: readonly ProductHealthIncident[],
  options: { path?: string } = {},
): Promise<void> {
  if (incidents.length === 0) return;
  const path = options.path ?? incidentLogPath();
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, incidents.map((i) => `${JSON.stringify(i)}\n`).join(""), "utf8");
}

/** A malformed line is skipped, never thrown — one bad write can't blind the log. */
function parseIncidentLine(line: string): ProductHealthIncident | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const probe = typeof record.probe === "string" ? record.probe : "";
    const severity = record.severity === "red" || record.severity === "degraded" ? record.severity : undefined;
    const startedAt = typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : undefined;
    if (!id || !probe || !severity || startedAt === undefined) return undefined;
    const endedAt = typeof record.endedAt === "number" && Number.isFinite(record.endedAt) ? record.endedAt : null;
    return {
      id,
      probe,
      severity,
      startedAt,
      endedAt,
      ...(typeof record.note === "string" && record.note ? { note: record.note } : {}),
    };
  } catch {
    return undefined;
  }
}
