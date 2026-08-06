import { createHash } from "node:crypto";

import { query as defaultQuery } from "@avg/mcp-common";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_COLUMNS = `
  work_item_id,
  task_version,
  approved_task_hash,
  intended_run_id,
  claim_state,
  claim_holder,
  claim_generation,
  claimed_at,
  lease_expires_at
`;
const QUALIFIED_CLAIM_COLUMNS = `
  claims.work_item_id,
  claims.task_version,
  claims.approved_task_hash,
  claims.intended_run_id,
  claims.claim_state,
  claims.claim_holder,
  claims.claim_generation,
  claims.claimed_at,
  claims.lease_expires_at
`;

export type DispatchClaimErrorReason = "claim_conflict" | "binding_conflict";

export class DispatchClaimError extends Error {
  constructor(
    readonly reason: DispatchClaimErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "DispatchClaimError";
  }
}

export type DispatchStoreQuery = <T = Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<T[]>;

export interface DispatchStoreDeps {
  query?: DispatchStoreQuery;
}

export interface DispatchClaim {
  workItemId: string;
  taskVersion: number;
  approvedTaskHash: string;
  intendedRunId: string;
  claimState: "claimed" | "submitted" | "bound" | "exhausted";
  claimHolder?: string;
  claimGeneration: number;
  claimedAt: string;
  leaseExpiresAt?: string;
}

export interface ClaimDispatchInput {
  workItemId: string;
  taskVersion: number;
  approvedTaskHash: string;
  intendedRunId: string;
  holder: string;
  leaseTtlMs: number;
}

export interface DispatchClaimProgressInput {
  workItemId: string;
  taskVersion: number;
  holder: string;
  claimGeneration: number;
  progress: "submitted" | "bound";
  leaseTtlMs: number;
}

interface DispatchClaimRow {
  work_item_id: string;
  task_version: number;
  approved_task_hash: string;
  intended_run_id: string;
  claim_state: string;
  claim_holder: string | null;
  claim_generation: number;
  claimed_at: string | Date;
  lease_expires_at: string | Date | null;
}

interface LeaseHolderRow {
  holder: string;
}

export function deriveIntendedRunId(
  workItemId: string,
  taskVersion: number,
  approvedTaskHash: string,
): string {
  const digest = createHash("sha256")
    .update(`${workItemId}\0${taskVersion}\0${approvedTaskHash}`, "utf8")
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export async function acquireDispatchLease(
  input: { holder: string; ttlSeconds: number },
  deps: DispatchStoreDeps = {},
): Promise<boolean> {
  const holder = normalizedHolder(input.holder);
  const ttlSeconds = normalizedTtl(input.ttlSeconds, "Dispatch lease TTL");
  const rows = await storeQuery(deps)<LeaseHolderRow>(
    `insert into dispatch_lease (lease_id, holder, acquired_at, expires_at)
     values ('global', $1, now(), now() + ($2 * interval '1 second'))
     on conflict (lease_id) do update set
       holder = excluded.holder,
       acquired_at = excluded.acquired_at,
       expires_at = excluded.expires_at
     where dispatch_lease.expires_at < now()
     returning holder`,
    [holder, ttlSeconds],
  );
  return rows.length === 1 && rows[0]?.holder === holder;
}

export async function renewDispatchLease(
  input: { holder: string; ttlSeconds: number },
  deps: DispatchStoreDeps = {},
): Promise<boolean> {
  const holder = normalizedHolder(input.holder);
  const ttlSeconds = normalizedTtl(input.ttlSeconds, "Dispatch lease TTL");
  const rows = await storeQuery(deps)<LeaseHolderRow>(
    `update dispatch_lease
     set expires_at = now() + ($2 * interval '1 second')
     where lease_id = 'global'
       and holder = $1
       and expires_at >= now()
     returning holder`,
    [holder, ttlSeconds],
  );
  return rows.length === 1 && rows[0]?.holder === holder;
}

export async function releaseDispatchLease(
  holderInput: string,
  deps: DispatchStoreDeps = {},
): Promise<boolean> {
  const holder = normalizedHolder(holderInput);
  const rows = await storeQuery(deps)<LeaseHolderRow>(
    `delete from dispatch_lease
     where lease_id = 'global' and holder = $1
     returning holder`,
    [holder],
  );
  return rows.length === 1 && rows[0]?.holder === holder;
}

export async function claimDispatch(
  input: ClaimDispatchInput,
  deps: DispatchStoreDeps = {},
): Promise<{ claim: DispatchClaim; created: boolean; acquired: boolean }> {
  assertClaimInput(input);
  const inserted = await storeQuery(deps)<DispatchClaimRow>(
    `insert into agent_task_dispatch_claims (
       work_item_id,
       task_version,
       approved_task_hash,
       intended_run_id,
       claim_state,
       claim_holder,
       claim_generation,
       claimed_at,
       lease_expires_at
     ) values ($1, $2, $3, $4::uuid, 'claimed', $5, 1, now(),
       now() + ($6 * interval '1 millisecond'))
     on conflict (work_item_id, task_version) do nothing
     returning ${CLAIM_COLUMNS}`,
    [
      input.workItemId,
      input.taskVersion,
      input.approvedTaskHash,
      input.intendedRunId,
      normalizedHolder(input.holder),
      normalizedTtl(input.leaseTtlMs, "Dispatch claim TTL"),
    ],
  );
  if (inserted.length > 1) {
    throw new Error(`Dispatch claim insert returned ${inserted.length} rows`);
  }

  const claim = inserted[0]
    ? parseDispatchClaimRow(inserted[0])
    : await getDispatchClaim(input.workItemId, input.taskVersion, deps);
  if (!claim) {
    throw new Error(`Dispatch claim disappeared for ${input.workItemId}@${input.taskVersion}`);
  }
  if (
    claim.approvedTaskHash !== input.approvedTaskHash
    || claim.intendedRunId !== input.intendedRunId
  ) {
    throw new DispatchClaimError(
      "claim_conflict",
      `Dispatch claim conflicts with the immutable binding for ${input.workItemId}@${input.taskVersion}`,
    );
  }
  return {
    claim,
    created: inserted.length === 1,
    acquired: inserted.length === 1,
  };
}

export async function getDispatchClaim(
  workItemId: string,
  taskVersion: number,
  deps: DispatchStoreDeps = {},
): Promise<DispatchClaim | undefined> {
  const rows = await storeQuery(deps)<DispatchClaimRow>(
    `select ${CLAIM_COLUMNS}
     from agent_task_dispatch_claims
     where work_item_id = $1 and task_version = $2
     limit 1`,
    [workItemId, taskVersion],
  );
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new Error(`Dispatch claim read returned ${rows.length} rows`);
  }
  return parseDispatchClaimRow(rows[0]!);
}

export async function getNextExpiredDispatchClaim(
  deps: DispatchStoreDeps = {},
): Promise<DispatchClaim | undefined> {
  const rows = await storeQuery(deps)<DispatchClaimRow>(
    `select ${QUALIFIED_CLAIM_COLUMNS}
     from agent_task_dispatch_claims claims
     join agent_tasks tasks
       on tasks.work_item_id = claims.work_item_id
      and tasks.task_version = claims.task_version
     where claims.claim_state in ('claimed', 'submitted')
       and claims.lease_expires_at < now()
       and tasks.lifecycle in ('approved', 'dispatching')
     order by claims.lease_expires_at asc, claims.work_item_id asc
     limit 1`,
  );
  return optionalSingleClaim(rows, "expired claim read");
}

export async function acquireNextExpiredDispatchClaim(
  input: { holder: string; leaseTtlMs: number },
  deps: DispatchStoreDeps = {},
): Promise<DispatchClaim | undefined> {
  const holder = normalizedHolder(input.holder);
  const leaseTtlMs = normalizedTtl(input.leaseTtlMs, "Dispatch claim TTL");
  const rows = await storeQuery(deps)<DispatchClaimRow>(
    `with candidate as (
       select claims.work_item_id, claims.task_version
       from agent_task_dispatch_claims claims
       join agent_tasks tasks
         on tasks.work_item_id = claims.work_item_id
        and tasks.task_version = claims.task_version
       where claims.claim_state in ('claimed', 'submitted')
         and claims.lease_expires_at < now()
         and tasks.lifecycle in ('approved', 'dispatching')
       order by claims.lease_expires_at asc, claims.work_item_id asc
       for update of claims skip locked
       limit 1
     )
     update agent_task_dispatch_claims claims
     set claim_state = case
           when claims.claim_generation >= 2
             then 'exhausted'
           else claims.claim_state
         end,
         claim_holder = $1,
         claim_generation = case
           when claims.claim_generation = 1
             then 2
           else claims.claim_generation
         end,
         claimed_at = now(),
         lease_expires_at = case
           when claims.claim_generation >= 2
             then null
           else now() + ($2 * interval '1 millisecond')
         end
     from candidate
     where claims.work_item_id = candidate.work_item_id
       and claims.task_version = candidate.task_version
     returning ${QUALIFIED_CLAIM_COLUMNS}`,
    [holder, leaseTtlMs],
  );
  return optionalSingleClaim(rows, "expired claim acquire");
}

export async function recordDispatchClaimProgress(
  input: DispatchClaimProgressInput,
  deps: DispatchStoreDeps = {},
): Promise<DispatchClaim> {
  const holder = normalizedHolder(input.holder);
  const leaseTtlMs = normalizedTtl(input.leaseTtlMs, "Dispatch claim TTL");
  if (!Number.isSafeInteger(input.claimGeneration) || input.claimGeneration < 1) {
    throw new Error("Dispatch claim generation must be a positive safe integer");
  }
  const rows = await storeQuery(deps)<DispatchClaimRow>(
    `update agent_task_dispatch_claims
     set claim_state = $5,
         lease_expires_at = now() + ($6 * interval '1 millisecond')
     where work_item_id = $1
       and task_version = $2
       and claim_holder = $3
       and claim_generation = $4
       and claim_state <> 'exhausted'
     returning ${CLAIM_COLUMNS}`,
    [
      input.workItemId,
      input.taskVersion,
      holder,
      input.claimGeneration,
      input.progress,
      leaseTtlMs,
    ],
  );
  if (rows.length !== 1) {
    throw new DispatchClaimError(
      "claim_conflict",
      `Dispatch claim progress conflicts with the active generation for ${input.workItemId}@${input.taskVersion}`,
    );
  }
  return parseDispatchClaimRow(rows[0]!);
}

function assertClaimInput(input: ClaimDispatchInput): void {
  if (!input.workItemId.trim()) {
    throw new Error("Dispatch claim work item id must not be empty");
  }
  if (!Number.isSafeInteger(input.taskVersion) || input.taskVersion < 1) {
    throw new Error("Dispatch claim task version must be a positive safe integer");
  }
  if (!input.approvedTaskHash.trim()) {
    throw new Error("Dispatch claim approved task hash must not be empty");
  }
  if (!CANONICAL_UUID.test(input.intendedRunId)) {
    throw new Error("Dispatch claim intended run id must be a lowercase canonical UUID");
  }
}

function optionalSingleClaim(
  rows: DispatchClaimRow[],
  operation: string,
): DispatchClaim | undefined {
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new Error(`Dispatch ${operation} returned ${rows.length} rows`);
  }
  return parseDispatchClaimRow(rows[0]!);
}

function parseDispatchClaimRow(row: DispatchClaimRow): DispatchClaim {
  if (!CANONICAL_UUID.test(row.intended_run_id)) {
    throw new Error("Stored dispatch claim has a non-canonical intended run id");
  }
  if (!Number.isSafeInteger(row.task_version) || row.task_version < 1) {
    throw new Error("Stored dispatch claim has an invalid task version");
  }
  if (!Number.isSafeInteger(row.claim_generation) || row.claim_generation < 1) {
    throw new Error("Stored dispatch claim has an invalid generation");
  }
  if (
    row.claim_state !== "claimed"
    && row.claim_state !== "submitted"
    && row.claim_state !== "bound"
    && row.claim_state !== "exhausted"
  ) {
    throw new Error("Stored dispatch claim has an invalid state");
  }
  return {
    workItemId: row.work_item_id,
    taskVersion: row.task_version,
    approvedTaskHash: row.approved_task_hash,
    intendedRunId: row.intended_run_id,
    claimState: row.claim_state,
    ...(row.claim_holder ? { claimHolder: row.claim_holder } : {}),
    claimGeneration: row.claim_generation,
    claimedAt: timestamp(row.claimed_at),
    ...(row.lease_expires_at
      ? { leaseExpiresAt: timestamp(row.lease_expires_at) }
      : {}),
  };
}

function normalizedHolder(holder: string): string {
  const normalized = holder.trim();
  if (!normalized) throw new Error("Dispatch lease holder must not be empty");
  return normalized;
}

function normalizedTtl(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function storeQuery(deps: DispatchStoreDeps): DispatchStoreQuery {
  return deps.query ?? defaultQuery;
}
