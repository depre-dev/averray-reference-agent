import { createHash } from "node:crypto";

import { query as defaultQuery } from "@avg/mcp-common";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLAIM_COLUMNS = `
  work_item_id,
  task_version,
  approved_task_hash,
  intended_run_id,
  claim_state,
  claimed_at,
  lease_expires_at
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
  claimState: string;
  claimedAt: string;
  leaseExpiresAt?: string;
}

export interface ClaimDispatchInput {
  workItemId: string;
  taskVersion: number;
  approvedTaskHash: string;
  intendedRunId: string;
}

interface DispatchClaimRow {
  work_item_id: string;
  task_version: number;
  approved_task_hash: string;
  intended_run_id: string;
  claim_state: string;
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
  const ttlSeconds = normalizedTtl(input.ttlSeconds);
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
  const ttlSeconds = normalizedTtl(input.ttlSeconds);
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
): Promise<{ claim: DispatchClaim; created: boolean }> {
  assertClaimInput(input);
  const inserted = await storeQuery(deps)<DispatchClaimRow>(
    `insert into agent_task_dispatch_claims (
       work_item_id,
       task_version,
       approved_task_hash,
       intended_run_id,
       claim_state,
       claimed_at,
       lease_expires_at
     ) values ($1, $2, $3, $4::uuid, 'claimed', now(), null)
     on conflict (work_item_id, task_version) do nothing
     returning ${CLAIM_COLUMNS}`,
    [
      input.workItemId,
      input.taskVersion,
      input.approvedTaskHash,
      input.intendedRunId,
    ],
  );
  if (inserted.length > 1) {
    throw new Error(`Dispatch claim insert returned ${inserted.length} rows`);
  }

  const claim = await getDispatchClaim(input.workItemId, input.taskVersion, deps);
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
  return { claim, created: inserted.length === 1 };
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

function parseDispatchClaimRow(row: DispatchClaimRow): DispatchClaim {
  if (!CANONICAL_UUID.test(row.intended_run_id)) {
    throw new Error("Stored dispatch claim has a non-canonical intended run id");
  }
  if (!Number.isSafeInteger(row.task_version) || row.task_version < 1) {
    throw new Error("Stored dispatch claim has an invalid task version");
  }
  return {
    workItemId: row.work_item_id,
    taskVersion: row.task_version,
    approvedTaskHash: row.approved_task_hash,
    intendedRunId: row.intended_run_id,
    claimState: row.claim_state,
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

function normalizedTtl(ttlSeconds: number): number {
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new Error("Dispatch lease TTL must be a positive safe integer");
  }
  return ttlSeconds;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function storeQuery(deps: DispatchStoreDeps): DispatchStoreQuery {
  return deps.query ?? defaultQuery;
}
