import { query as defaultQuery } from "@avg/mcp-common";
import {
  artifactRefSchema,
  sha256Schema,
  type ArtifactRef,
} from "@avg/schemas";

import {
  DispatchClaimError,
  type DispatchStoreDeps,
  type DispatchStoreQuery,
} from "./dispatch-claim.js";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BINDING_COLUMNS = `
  work_item_id,
  harness_run_id,
  run_manifest_ref,
  run_manifest_hash,
  bound_at
`;

export interface RunBinding {
  workItemId: string;
  harnessRunId: string;
  runManifestRef?: ArtifactRef;
  runManifestHash?: string;
  boundAt: string;
}

export interface BindRunInput {
  workItemId: string;
  harnessRunId: string;
  runManifestRef?: ArtifactRef;
  runManifestHash?: string;
}

interface RunBindingRow {
  work_item_id: string;
  harness_run_id: string;
  run_manifest_ref: unknown | null;
  run_manifest_hash: string | null;
  bound_at: string | Date;
}

export async function bindRunToWorkItem(
  input: BindRunInput,
  deps: DispatchStoreDeps = {},
): Promise<{ binding: RunBinding; created: boolean }> {
  const normalized = parseBindingInput(input);
  const inserted = await storeQuery(deps)<RunBindingRow>(
    `insert into agent_task_run_outbox (
       work_item_id,
       harness_run_id,
       run_manifest_ref,
       run_manifest_hash,
       bound_at
     ) values ($1, $2::uuid, $3::jsonb, $4, now())
     on conflict (work_item_id) do nothing
     returning ${BINDING_COLUMNS}`,
    bindingValues(normalized),
  );
  if (inserted.length > 1) {
    throw new Error(`Run binding insert returned ${inserted.length} rows`);
  }
  if (inserted[0]) {
    return { binding: parseRunBindingRow(inserted[0]), created: true };
  }

  const updated = await storeQuery(deps)<RunBindingRow>(
    `update agent_task_run_outbox
     set run_manifest_ref = coalesce(run_manifest_ref, $3::jsonb),
         run_manifest_hash = coalesce(run_manifest_hash, $4)
     where work_item_id = $1
       and harness_run_id = $2::uuid
       and ($3::jsonb is null or run_manifest_ref is null or run_manifest_ref = $3::jsonb)
       and ($4::text is null or run_manifest_hash is null or run_manifest_hash = $4)
       and (
         coalesce(run_manifest_hash, $4::text) is null
         or coalesce(run_manifest_ref, $3::jsonb) is null
         or coalesce(run_manifest_ref, $3::jsonb)->>'sha256'
           = coalesce(run_manifest_hash, $4::text)
       )
     returning ${BINDING_COLUMNS}`,
    bindingValues(normalized),
  );
  if (updated.length === 1) {
    return { binding: parseRunBindingRow(updated[0]!), created: false };
  }
  if (updated.length > 1) {
    throw new Error(`Run binding update returned ${updated.length} rows`);
  }

  const existing = await getRunBinding(input.workItemId, deps);
  if (existing) {
    throw new DispatchClaimError(
      "binding_conflict",
      `Run binding conflicts with the immutable binding for ${input.workItemId}`,
    );
  }
  throw new Error(`Run binding disappeared for ${input.workItemId}`);
}

export async function getRunBinding(
  workItemId: string,
  deps: DispatchStoreDeps = {},
): Promise<RunBinding | undefined> {
  const rows = await storeQuery(deps)<RunBindingRow>(
    `select ${BINDING_COLUMNS}
     from agent_task_run_outbox
     where work_item_id = $1
     limit 1`,
    [workItemId],
  );
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new Error(`Run binding read returned ${rows.length} rows`);
  }
  return parseRunBindingRow(rows[0]!);
}

function parseBindingInput(input: BindRunInput): BindRunInput {
  if (!input.workItemId.trim()) {
    throw new DispatchClaimError(
      "binding_conflict",
      "Run binding work item id must not be empty",
    );
  }
  if (!CANONICAL_UUID.test(input.harnessRunId)) {
    throw new DispatchClaimError(
      "binding_conflict",
      "Run binding Harness run id must be a lowercase canonical UUID",
    );
  }
  const runManifestRef = input.runManifestRef
    ? artifactRefSchema.parse(input.runManifestRef)
    : undefined;
  const runManifestHash = input.runManifestHash
    ? sha256Schema.parse(input.runManifestHash)
    : undefined;
  if (
    runManifestRef
    && runManifestHash
    && runManifestRef.sha256 !== runManifestHash
  ) {
    throw new DispatchClaimError(
      "binding_conflict",
      "Run manifest reference and hash disagree",
    );
  }
  return {
    workItemId: input.workItemId,
    harnessRunId: input.harnessRunId,
    ...(runManifestRef ? { runManifestRef } : {}),
    ...(runManifestHash ? { runManifestHash } : {}),
  };
}

function bindingValues(input: BindRunInput): unknown[] {
  return [
    input.workItemId,
    input.harnessRunId,
    input.runManifestRef ? JSON.stringify(input.runManifestRef) : null,
    input.runManifestHash ?? null,
  ];
}

function parseRunBindingRow(row: RunBindingRow): RunBinding {
  if (!CANONICAL_UUID.test(row.harness_run_id)) {
    throw new DispatchClaimError(
      "binding_conflict",
      "Stored run binding has a non-canonical Harness run id",
    );
  }
  const rawRef = typeof row.run_manifest_ref === "string"
    ? JSON.parse(row.run_manifest_ref) as unknown
    : row.run_manifest_ref;
  const runManifestRef = rawRef === null
    ? undefined
    : artifactRefSchema.parse(rawRef);
  const runManifestHash = row.run_manifest_hash === null
    ? undefined
    : sha256Schema.parse(row.run_manifest_hash);
  if (
    runManifestRef
    && runManifestHash
    && runManifestRef.sha256 !== runManifestHash
  ) {
    throw new DispatchClaimError(
      "binding_conflict",
      "Stored run manifest reference and hash disagree",
    );
  }
  return {
    workItemId: row.work_item_id,
    harnessRunId: row.harness_run_id,
    ...(runManifestRef ? { runManifestRef } : {}),
    ...(runManifestHash ? { runManifestHash } : {}),
    boundAt: timestamp(row.bound_at),
  };
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function storeQuery(deps: DispatchStoreDeps): DispatchStoreQuery {
  return deps.query ?? defaultQuery;
}
