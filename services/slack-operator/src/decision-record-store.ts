import {
  isHermesDecisionRecord,
  type HermesDecisionRecord,
} from "@avg/averray-mcp/decision-records";
import type { CodexTask } from "./codex-task-queue.js";

export type DecisionRecordQueryFn = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<T[]>;

export interface DecisionRecordsMonitorResponse {
  schemaVersion: 1;
  kind: "hermes_decision_records";
  generatedAt: string;
  limit: number;
  records: HermesDecisionRecord[];
  safety: {
    readOnly: true;
    mutates: false;
    mutatesGithub: false;
    mutatesAverray: false;
    editsWikipedia: false;
  };
}

export async function listDecisionRecordsForMonitor(input: {
  query: DecisionRecordQueryFn;
  tasks?: CodexTask[];
  limit?: number;
  now?: Date;
}): Promise<DecisionRecordsMonitorResponse> {
  const limit = clampLimit(input.limit);
  const rows = await input.query<{ decision_record: unknown }>(
    `select result->'decisionRecord' as decision_record
       from operator_command_events
      where result ? 'decisionRecord'
      order by updated_at desc
      limit $1`,
    [Math.max(limit, 50)],
  );
  return buildDecisionRecordsMonitorResponse({
    records: [
      ...rows.map((row) => row.decision_record).filter(isHermesDecisionRecord),
      ...(input.tasks ?? []).map((task) => task.decisionRecord).filter(isHermesDecisionRecord),
    ],
    limit,
    now: input.now,
  });
}

export function buildDecisionRecordsMonitorResponse(input: {
  records: HermesDecisionRecord[];
  limit?: number;
  now?: Date;
}): DecisionRecordsMonitorResponse {
  const limit = clampLimit(input.limit);
  const recordsById = new Map<string, HermesDecisionRecord>();
  for (const record of input.records) {
    recordsById.set(record.id, record);
  }
  const records = [...recordsById.values()]
    .sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt))
    .slice(0, limit);
  return {
    schemaVersion: 1,
    kind: "hermes_decision_records",
    generatedAt: (input.now ?? new Date()).toISOString(),
    limit,
    records,
    safety: {
      readOnly: true,
      mutates: false,
      mutatesGithub: false,
      mutatesAverray: false,
      editsWikipedia: false,
    },
  };
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? NaN)) return 50;
  return Math.min(100, Math.max(1, Math.floor(limit!)));
}
