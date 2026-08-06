import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  acquireNextExpiredDispatchClaim,
  acquireDispatchLease,
  claimDispatch,
  deriveIntendedRunId,
  DispatchClaimError,
  getDispatchClaim,
  getNextExpiredDispatchClaim,
  recordDispatchClaimProgress,
  releaseDispatchLease,
  renewDispatchLease,
  type DispatchStoreQuery,
} from "../../packages/averray-mcp/src/dispatch-claim.js";

const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("INT-2e deterministic dispatch claims", () => {
  it("derives a stable canonical UUID that changes with every identity input", () => {
    const base = deriveIntendedRunId("work-one", 1, HASH);

    expect(deriveIntendedRunId("work-one", 1, HASH)).toBe(base);
    expect(base).toMatch(CANONICAL_UUID);
    expect(base[14]).toBe("5");
    expect(["8", "9", "a", "b"]).toContain(base[19]);
    expect(deriveIntendedRunId("work-two", 1, HASH)).not.toBe(base);
    expect(deriveIntendedRunId("work-one", 2, HASH)).not.toBe(base);
    expect(deriveIntendedRunId("work-one", 1, OTHER_HASH)).not.toBe(base);
  });

  it("acquires, expires, renews, and releases the global lease without stealing", async () => {
    const db = new MemoryDispatchDatabase();

    await expect(
      acquireDispatchLease({ holder: "dispatcher-a", ttlSeconds: 30 }, { query: db.query }),
    ).resolves.toBe(true);
    await expect(
      acquireDispatchLease({ holder: "dispatcher-b", ttlSeconds: 30 }, { query: db.query }),
    ).resolves.toBe(false);
    await expect(
      renewDispatchLease({ holder: "dispatcher-b", ttlSeconds: 30 }, { query: db.query }),
    ).resolves.toBe(false);
    await expect(releaseDispatchLease("dispatcher-b", { query: db.query }))
      .resolves.toBe(false);
    await expect(
      renewDispatchLease({ holder: "dispatcher-a", ttlSeconds: 60 }, { query: db.query }),
    ).resolves.toBe(true);

    db.advanceSeconds(61);
    await expect(
      renewDispatchLease({ holder: "dispatcher-a", ttlSeconds: 30 }, { query: db.query }),
    ).resolves.toBe(false);
    await expect(
      acquireDispatchLease({ holder: "dispatcher-b", ttlSeconds: 30 }, { query: db.query }),
    ).resolves.toBe(true);
    await expect(releaseDispatchLease("dispatcher-a", { query: db.query }))
      .resolves.toBe(false);
    await expect(releaseDispatchLease("dispatcher-b", { query: db.query }))
      .resolves.toBe(true);
  });

  it("creates one immutable claim and treats an identical replay as a no-op", async () => {
    const db = new MemoryDispatchDatabase();
    const input = {
      workItemId: "work-one",
      taskVersion: 1,
      approvedTaskHash: HASH,
      intendedRunId: deriveIntendedRunId("work-one", 1, HASH),
      holder: "dispatcher-a",
      leaseTtlMs: 1_000,
    };

    await expect(claimDispatch(input, { query: db.query })).resolves.toMatchObject({
      created: true,
      acquired: true,
      claim: {
        workItemId: "work-one",
        taskVersion: 1,
        approvedTaskHash: HASH,
        intendedRunId: input.intendedRunId,
        claimState: "claimed",
      },
    });
    await expect(claimDispatch(input, { query: db.query })).resolves.toMatchObject({
      created: false,
      acquired: false,
      claim: { intendedRunId: input.intendedRunId },
    });
    await expect(getDispatchClaim("work-one", 1, { query: db.query }))
      .resolves.toMatchObject({ intendedRunId: input.intendedRunId });
    expect(db.claimCount).toBe(1);
  });

  it("refuses conflicting approval hashes and intended run ids", async () => {
    const db = new MemoryDispatchDatabase();
    const intendedRunId = deriveIntendedRunId("work-one", 1, HASH);
    const input = {
      workItemId: "work-one",
      taskVersion: 1,
      approvedTaskHash: HASH,
      intendedRunId,
      holder: "dispatcher-a",
      leaseTtlMs: 1_000,
    };
    await claimDispatch(input, { query: db.query });

    await expect(
      claimDispatch({ ...input, approvedTaskHash: OTHER_HASH }, { query: db.query }),
    ).rejects.toMatchObject({
      reason: "claim_conflict",
    });
    await expect(
      claimDispatch({
        ...input,
        intendedRunId: deriveIntendedRunId("work-one", 2, HASH),
      }, { query: db.query }),
    ).rejects.toBeInstanceOf(DispatchClaimError);
    await expect(
      claimDispatch({
        ...input,
        intendedRunId: deriveIntendedRunId("work-one", 2, HASH),
      }, { query: db.query }),
    ).rejects.toMatchObject({
      reason: "claim_conflict",
    });
    expect(db.claimCount).toBe(1);
  });

  it("expires once, advances only on progress, and exhausts without a third generation", async () => {
    const db = new MemoryDispatchDatabase();
    const intendedRunId = deriveIntendedRunId("work-one", 1, HASH);
    await claimDispatch({
      workItemId: "work-one",
      taskVersion: 1,
      approvedTaskHash: HASH,
      intendedRunId,
      holder: "dispatcher-a",
      leaseTtlMs: 1_000,
    }, { query: db.query });

    db.advanceSeconds(2);
    await expect(getNextExpiredDispatchClaim({ query: db.query })).resolves.toMatchObject({
      claimGeneration: 1,
      claimState: "claimed",
    });
    const retry = await acquireNextExpiredDispatchClaim({
      holder: "dispatcher-b",
      leaseTtlMs: 1_000,
    }, { query: db.query });
    expect(retry).toMatchObject({
      claimGeneration: 2,
      claimHolder: "dispatcher-b",
      claimState: "claimed",
    });
    await expect(recordDispatchClaimProgress({
      workItemId: "work-one",
      taskVersion: 1,
      holder: "dispatcher-b",
      claimGeneration: 2,
      progress: "submitted",
      leaseTtlMs: 1_000,
    }, { query: db.query })).resolves.toMatchObject({ claimState: "submitted" });

    db.advanceSeconds(2);
    await expect(acquireNextExpiredDispatchClaim({
      holder: "dispatcher-c",
      leaseTtlMs: 1_000,
    }, { query: db.query })).resolves.toMatchObject({
      claimGeneration: 2,
      claimHolder: "dispatcher-c",
      claimState: "exhausted",
    });

    const secondDb = new MemoryDispatchDatabase();
    await claimDispatch({
      workItemId: "work-two",
      taskVersion: 1,
      approvedTaskHash: HASH,
      intendedRunId: deriveIntendedRunId("work-two", 1, HASH),
      holder: "dispatcher-a",
      leaseTtlMs: 1_000,
    }, { query: secondDb.query });
    secondDb.advanceSeconds(2);
    await acquireNextExpiredDispatchClaim({
      holder: "dispatcher-b",
      leaseTtlMs: 1_000,
    }, { query: secondDb.query });
    secondDb.advanceSeconds(2);
    const exhausted = await acquireNextExpiredDispatchClaim({
      holder: "dispatcher-c",
      leaseTtlMs: 1_000,
    }, { query: secondDb.query });
    expect(exhausted).toMatchObject({
      claimGeneration: 2,
      claimState: "exhausted",
    });
    expect(exhausted).not.toHaveProperty("leaseExpiresAt");
  });

  it("pins the additive migration and migration runner ordering", () => {
    const migration = readFileSync(
      new URL(
        "../../ops/migrations/003_dispatch_claims_outbox_decisions.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const runner = readFileSync(
      new URL("../../ops/migrate.sh", import.meta.url),
      "utf8",
    );

    for (const table of [
      "dispatch_lease",
      "agent_task_dispatch_claims",
      "agent_task_run_outbox",
      "hermes_decision_records",
    ]) {
      expect(migration).toMatch(new RegExp(`create table if not exists ${table}`, "i"));
    }
    expect(migration).toMatch(/primary key\s*\(work_item_id,\s*task_version\)/i);
    expect(migration).toMatch(/hermes_decision_records_correlation_id_idx/i);
    expect(migration).toMatch(/hermes_decision_records_work_item_id_idx/i);
    expect(runner.indexOf("002_agent_tasks.sql"))
      .toBeLessThan(runner.indexOf("003_dispatch_claims_outbox_decisions.sql"));
    expect(runner.indexOf("004_dispatch_quarantines.sql"))
      .toBeLessThan(runner.indexOf("005_dispatch_claim_expiry_backpressure.sql"));
    const int4cMigration = readFileSync(
      new URL(
        "../../ops/migrations/005_dispatch_claim_expiry_backpressure.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(int4cMigration).toMatch(/claim_generation/i);
    expect(int4cMigration).toMatch(/harness_dispatch_backpressure/i);
  });
});

interface MemoryLease {
  holder: string;
  acquiredAt: number;
  expiresAt: number;
}

interface MemoryClaimRow {
  work_item_id: string;
  task_version: number;
  approved_task_hash: string;
  intended_run_id: string;
  claim_state: string;
  claim_holder: string | null;
  claim_generation: number;
  claimed_at: string;
  lease_expires_at: string | null;
}

class MemoryDispatchDatabase {
  private now = Date.parse("2026-07-24T12:00:00.000Z");
  private lease: MemoryLease | undefined;
  private readonly claims = new Map<string, MemoryClaimRow>();

  get claimCount(): number {
    return this.claims.size;
  }

  advanceSeconds(seconds: number): void {
    this.now += seconds * 1_000;
  }

  readonly query: DispatchStoreQuery = async <T>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> => {
    if (/insert into dispatch_lease/i.test(text)) {
      const holder = String(values[0]);
      const ttlSeconds = Number(values[1]);
      if (this.lease && this.lease.expiresAt >= this.now) return [];
      this.lease = {
        holder,
        acquiredAt: this.now,
        expiresAt: this.now + ttlSeconds * 1_000,
      };
      return [{ holder } as T];
    }
    if (/update dispatch_lease/i.test(text)) {
      const holder = String(values[0]);
      const ttlSeconds = Number(values[1]);
      if (
        !this.lease
        || this.lease.holder !== holder
        || this.lease.expiresAt < this.now
      ) {
        return [];
      }
      this.lease.expiresAt = this.now + ttlSeconds * 1_000;
      return [{ holder } as T];
    }
    if (/delete from dispatch_lease/i.test(text)) {
      const holder = String(values[0]);
      if (!this.lease || this.lease.holder !== holder) return [];
      this.lease = undefined;
      return [{ holder } as T];
    }
    if (/insert into agent_task_dispatch_claims/i.test(text)) {
      const row: MemoryClaimRow = {
        work_item_id: String(values[0]),
        task_version: Number(values[1]),
        approved_task_hash: String(values[2]),
        intended_run_id: String(values[3]),
        claim_state: "claimed",
        claim_holder: String(values[4]),
        claim_generation: 1,
        claimed_at: new Date(this.now).toISOString(),
        lease_expires_at: new Date(this.now + Number(values[5])).toISOString(),
      };
      const rowKey = claimKey(row.work_item_id, row.task_version);
      if (this.claims.has(rowKey)) return [];
      this.claims.set(rowKey, row);
      return [structuredClone(row) as T];
    }
    if (/with candidate as/i.test(text) && /update agent_task_dispatch_claims/i.test(text)) {
      const row = [...this.claims.values()].find((candidate) =>
        (candidate.claim_state === "claimed" || candidate.claim_state === "submitted")
        && candidate.lease_expires_at !== null
        && Date.parse(candidate.lease_expires_at) < this.now);
      if (!row) return [];
      if (row.claim_generation >= 2) {
        row.claim_state = "exhausted";
        row.lease_expires_at = null;
      } else {
        row.claim_generation = 2;
        row.lease_expires_at = new Date(this.now + Number(values[1])).toISOString();
      }
      row.claim_holder = String(values[0]);
      row.claimed_at = new Date(this.now).toISOString();
      return [structuredClone(row) as T];
    }
    if (/update agent_task_dispatch_claims/i.test(text)) {
      const row = this.claims.get(claimKey(String(values[0]), Number(values[1])));
      if (
        !row
        || row.claim_holder !== String(values[2])
        || row.claim_generation !== Number(values[3])
        || row.claim_state === "exhausted"
      ) return [];
      row.claim_state = String(values[4]);
      row.lease_expires_at = new Date(this.now + Number(values[5])).toISOString();
      return [structuredClone(row) as T];
    }
    if (/join agent_tasks/i.test(text) && /lease_expires_at < now/i.test(text)) {
      const row = [...this.claims.values()].find((candidate) =>
        (candidate.claim_state === "claimed" || candidate.claim_state === "submitted")
        && candidate.lease_expires_at !== null
        && Date.parse(candidate.lease_expires_at) < this.now);
      return row ? [structuredClone(row) as T] : [];
    }
    if (/from agent_task_dispatch_claims/i.test(text)) {
      const row = this.claims.get(claimKey(String(values[0]), Number(values[1])));
      return row ? [structuredClone(row) as T] : [];
    }
    throw new Error(`Unexpected dispatch test query: ${text}`);
  };
}

function claimKey(workItemId: string, taskVersion: number): string {
  return `${workItemId}:${taskVersion}`;
}
