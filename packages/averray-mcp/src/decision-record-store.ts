import { query as defaultQuery } from "@avg/mcp-common";
import {
  hermesDecisionRecordV2Schema,
  type HermesDecisionRecordV2,
} from "@avg/schemas";

export type HermesDecisionStoreQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<T[]>;

export interface HermesDecisionStoreDeps {
  query?: HermesDecisionStoreQuery;
}

export interface HermesDecisionListFilter {
  correlationId?: string;
  workItemId?: string;
  limit?: number;
}

interface HermesDecisionRow {
  decision_id: string;
  correlation_id: string;
  work_item_id: string | null;
  decision_type: string;
  generated_at: string | Date;
  record: unknown;
}

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1_000;
const SELECT_COLUMNS = `
  decision_id,
  correlation_id,
  work_item_id,
  decision_type,
  generated_at,
  record
`;

export async function recordHermesDecision(
  input: HermesDecisionRecordV2,
  deps: HermesDecisionStoreDeps = {},
): Promise<HermesDecisionRecordV2> {
  const record = hermesDecisionRecordV2Schema.parse(input);
  await storeQuery(deps)<HermesDecisionRow>(
    `insert into hermes_decision_records (
       decision_id,
       correlation_id,
       work_item_id,
       decision_type,
       generated_at,
       record
     ) values ($1, $2, $3, $4, $5::timestamptz, $6::jsonb)
     on conflict (decision_id) do nothing
     returning ${SELECT_COLUMNS}`,
    [
      record.decisionId,
      record.correlationId,
      record.workItemId ?? null,
      record.decisionType,
      record.generatedAt,
      JSON.stringify(record),
    ],
  );
  return record;
}

export async function listHermesDecisions(
  filter: HermesDecisionListFilter = {},
  deps: HermesDecisionStoreDeps = {},
): Promise<HermesDecisionRecordV2[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (filter.correlationId !== undefined) {
    values.push(filter.correlationId);
    clauses.push(`correlation_id = $${values.length}`);
  }
  if (filter.workItemId !== undefined) {
    values.push(filter.workItemId);
    clauses.push(`work_item_id = $${values.length}`);
  }
  values.push(normalizedLimit(filter.limit));

  const rows = await storeQuery(deps)<HermesDecisionRow>(
    `select ${SELECT_COLUMNS}
     from hermes_decision_records
     ${clauses.length > 0 ? `where ${clauses.join(" and ")}` : ""}
     order by generated_at desc, decision_id asc
     limit $${values.length}`,
    values,
  );
  return rows.map(parseHermesDecisionRow);
}

function parseHermesDecisionRow(row: HermesDecisionRow): HermesDecisionRecordV2 {
  const rawRecord = typeof row.record === "string"
    ? JSON.parse(row.record) as unknown
    : row.record;
  const record = hermesDecisionRecordV2Schema.parse(rawRecord);
  const expected = {
    decisionId: row.decision_id,
    correlationId: row.correlation_id,
    workItemId: row.work_item_id ?? undefined,
    decisionType: row.decision_type,
    generatedAt: timestamp(row.generated_at),
  };
  const actual = {
    decisionId: record.decisionId,
    correlationId: record.correlationId,
    workItemId: record.workItemId,
    decisionType: record.decisionType,
    generatedAt: timestamp(record.generatedAt),
  };
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(`Hermes decision row columns do not match record JSON for ${record.decisionId}`);
  }
  return record;
}

function normalizedLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Hermes decision list limit must be a positive safe integer");
  }
  return Math.min(value, MAX_LIST_LIMIT);
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function storeQuery(deps: HermesDecisionStoreDeps): HermesDecisionStoreQuery {
  return deps.query ?? defaultQuery;
}
