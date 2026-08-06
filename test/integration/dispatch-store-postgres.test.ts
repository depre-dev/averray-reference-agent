import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  acquireNextExpiredDispatchClaim,
  acquireDispatchLease,
  claimDispatch,
  deriveIntendedRunId,
  getNextExpiredDispatchClaim,
  recordDispatchClaimProgress,
  releaseDispatchLease,
  renewDispatchLease,
  type DispatchStoreQuery,
} from "../../packages/averray-mcp/src/dispatch-claim.js";
import {
  countInflightHarnessRuns,
  getDispatchBackpressure,
  transitionDispatchBackpressure,
} from "../../packages/averray-mcp/src/dispatch-backpressure.js";
import {
  buildHermesDecisionRecordV2,
} from "../../packages/averray-mcp/src/decision-records.js";
import {
  listHermesDecisions,
  recordHermesDecision,
  type HermesDecisionStoreQuery,
} from "../../packages/averray-mcp/src/decision-record-store.js";
import {
  bindRunToWorkItem,
  getRunBinding,
} from "../../packages/averray-mcp/src/run-binding-outbox.js";

const DATABASE_URL = process.env.DISPATCH_TEST_DATABASE_URL;
const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN_ID = "22222222-2222-4222-8222-222222222222";
const MANIFEST_REF = {
  uri: `artifact://sha256/${"c".repeat(64)}`,
  sha256: `sha256:${"c".repeat(64)}`,
};

describe.skipIf(!DATABASE_URL)("INT-2e dispatch stores against Postgres", () => {
  let pool: Pool;
  let dispatchQuery: DispatchStoreQuery;
  let decisionQuery: HermesDecisionStoreQuery;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const query = async <T>(
      text: string,
      values: unknown[] = [],
    ): Promise<T[]> => {
      const result = await pool.query(text, values);
      return result.rows as T[];
    };
    dispatchQuery = query;
    decisionQuery = query;

    const migrationsDirectory = new URL("../../ops/migrations/", import.meta.url);
    const migrations = readdirSync(migrationsDirectory)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const migration of migrations) {
      await pool.query(
        readFileSync(new URL(migration, migrationsDirectory), "utf8"),
      );
    }
  });

  beforeEach(async () => {
    await pool.query("delete from harness_dispatch_backpressure");
    await pool.query("delete from hermes_decision_records");
    await pool.query("delete from agent_task_run_outbox");
    await pool.query("delete from agent_task_dispatch_claims");
    await pool.query("delete from agent_tasks");
    await pool.query("delete from dispatch_lease");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("enforces live lease ownership, expiry, renewal, and release", async () => {
    await expect(
      acquireDispatchLease(
        { holder: "dispatcher-a", ttlSeconds: 1 },
        { query: dispatchQuery },
      ),
    ).resolves.toBe(true);
    await expect(
      acquireDispatchLease(
        { holder: "dispatcher-b", ttlSeconds: 1 },
        { query: dispatchQuery },
      ),
    ).resolves.toBe(false);
    await expect(
      renewDispatchLease(
        { holder: "dispatcher-b", ttlSeconds: 1 },
        { query: dispatchQuery },
      ),
    ).resolves.toBe(false);
    await expect(
      releaseDispatchLease("dispatcher-b", { query: dispatchQuery }),
    ).resolves.toBe(false);
    await expect(
      renewDispatchLease(
        { holder: "dispatcher-a", ttlSeconds: 1 },
        { query: dispatchQuery },
      ),
    ).resolves.toBe(true);

    await delay(1_200);

    await expect(
      renewDispatchLease(
        { holder: "dispatcher-a", ttlSeconds: 1 },
        { query: dispatchQuery },
      ),
    ).resolves.toBe(false);
    await expect(
      acquireDispatchLease(
        { holder: "dispatcher-b", ttlSeconds: 1 },
        { query: dispatchQuery },
      ),
    ).resolves.toBe(true);
    await expect(
      releaseDispatchLease("dispatcher-a", { query: dispatchQuery }),
    ).resolves.toBe(false);
    await expect(
      releaseDispatchLease("dispatcher-b", { query: dispatchQuery }),
    ).resolves.toBe(true);
  });

  it("deduplicates identical claims and refuses a conflicting hash", async () => {
    const intendedRunId = deriveIntendedRunId("pg-work-claim", 1, HASH);
    const input = {
      workItemId: "pg-work-claim",
      taskVersion: 1,
      approvedTaskHash: HASH,
      intendedRunId,
      holder: "dispatcher-a",
      leaseTtlMs: 1_000,
    };

    await expect(
      claimDispatch(input, { query: dispatchQuery }),
    ).resolves.toMatchObject({
      created: true,
      claim: { intendedRunId },
    });
    await expect(
      claimDispatch(input, { query: dispatchQuery }),
    ).resolves.toMatchObject({
      created: false,
      claim: { intendedRunId },
    });
    await expect(
      claimDispatch(
        { ...input, approvedTaskHash: OTHER_HASH },
        { query: dispatchQuery },
      ),
    ).rejects.toMatchObject({ reason: "claim_conflict" });

    const result = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from agent_task_dispatch_claims
       where work_item_id = $1 and task_version = $2`,
      [input.workItemId, input.taskVersion],
    );
    expect(result.rows[0]?.count).toBe("1");
  });

  it("takes over expired claims once and exhausts generation two", async () => {
    await insertTask(pool, "pg-expiry", "dispatching");
    const intendedRunId = deriveIntendedRunId("pg-expiry", 1, HASH);
    await claimDispatch({
      workItemId: "pg-expiry",
      taskVersion: 1,
      approvedTaskHash: HASH,
      intendedRunId,
      holder: "dispatcher-a",
      leaseTtlMs: 50,
    }, { query: dispatchQuery });
    await delay(75);

    await expect(getNextExpiredDispatchClaim({ query: dispatchQuery })).resolves.toMatchObject({
      intendedRunId,
      claimGeneration: 1,
    });
    const retry = await acquireNextExpiredDispatchClaim({
      holder: "dispatcher-b",
      leaseTtlMs: 50,
    }, { query: dispatchQuery });
    expect(retry).toMatchObject({
      intendedRunId,
      claimGeneration: 2,
      claimState: "claimed",
      claimHolder: "dispatcher-b",
    });
    await recordDispatchClaimProgress({
      workItemId: "pg-expiry",
      taskVersion: 1,
      holder: "dispatcher-b",
      claimGeneration: 2,
      progress: "submitted",
      leaseTtlMs: 50,
    }, { query: dispatchQuery });
    await delay(75);
    await expect(acquireNextExpiredDispatchClaim({
      holder: "dispatcher-c",
      leaseTtlMs: 50,
    }, { query: dispatchQuery })).resolves.toMatchObject({
      claimGeneration: 2,
      claimState: "exhausted",
      claimHolder: "dispatcher-c",
    });

    await insertTask(pool, "pg-exhaust", "dispatching");
    await claimDispatch({
      workItemId: "pg-exhaust",
      taskVersion: 1,
      approvedTaskHash: HASH,
      intendedRunId: deriveIntendedRunId("pg-exhaust", 1, HASH),
      holder: "dispatcher-a",
      leaseTtlMs: 50,
    }, { query: dispatchQuery });
    await delay(75);
    await acquireNextExpiredDispatchClaim({
      holder: "dispatcher-b",
      leaseTtlMs: 50,
    }, { query: dispatchQuery });
    await delay(75);
    await expect(acquireNextExpiredDispatchClaim({
      holder: "dispatcher-c",
      leaseTtlMs: 50,
    }, { query: dispatchQuery })).resolves.toMatchObject({
      claimGeneration: 2,
      claimState: "exhausted",
    });
  });

  it("counts non-terminal bindings and persists only backpressure transitions", async () => {
    await insertTask(pool, "pg-running", "running");
    await bindRunToWorkItem({
      workItemId: "pg-running",
      harnessRunId: RUN_ID,
    }, { query: dispatchQuery });
    await expect(countInflightHarnessRuns({ query: dispatchQuery })).resolves.toBe(1);

    await expect(transitionDispatchBackpressure({
      active: true,
      observedInflight: 1,
      maxInflight: 1,
    }, { query: dispatchQuery })).resolves.toMatchObject({ changed: true });
    await expect(transitionDispatchBackpressure({
      active: true,
      observedInflight: 1,
      maxInflight: 1,
    }, { query: dispatchQuery })).resolves.toMatchObject({ changed: false });
    await expect(transitionDispatchBackpressure({
      active: false,
      observedInflight: 0,
      maxInflight: 1,
    }, { query: dispatchQuery })).resolves.toMatchObject({ changed: true });
    await expect(getDispatchBackpressure({ query: dispatchQuery })).resolves.toMatchObject({
      active: false,
      observedInflight: 0,
      maxInflight: 1,
    });
  });

  it("keeps run binding immutable while allowing a late manifest fill-in", async () => {
    await expect(
      bindRunToWorkItem(
        { workItemId: "pg-work-binding", harnessRunId: RUN_ID },
        { query: dispatchQuery },
      ),
    ).resolves.toMatchObject({ created: true });
    await expect(
      bindRunToWorkItem(
        { workItemId: "pg-work-binding", harnessRunId: RUN_ID },
        { query: dispatchQuery },
      ),
    ).resolves.toMatchObject({ created: false });
    await expect(
      bindRunToWorkItem(
        { workItemId: "pg-work-binding", harnessRunId: OTHER_RUN_ID },
        { query: dispatchQuery },
      ),
    ).rejects.toMatchObject({ reason: "binding_conflict" });

    await expect(
      bindRunToWorkItem({
        workItemId: "pg-work-binding",
        harnessRunId: RUN_ID,
        runManifestRef: MANIFEST_REF,
        runManifestHash: MANIFEST_REF.sha256,
      }, { query: dispatchQuery }),
    ).resolves.toMatchObject({
      created: false,
      binding: {
        harnessRunId: RUN_ID,
        runManifestRef: MANIFEST_REF,
        runManifestHash: MANIFEST_REF.sha256,
      },
    });
    await expect(
      getRunBinding("pg-work-binding", { query: dispatchQuery }),
    ).resolves.toMatchObject({
      harnessRunId: RUN_ID,
      runManifestRef: MANIFEST_REF,
      runManifestHash: MANIFEST_REF.sha256,
    });
  });

  it("inserts a duplicate decision id once without updating its record", async () => {
    const original = buildHermesDecisionRecordV2(decisionInput(
      "The immutable claim conflicts with the approved task.",
    ));
    const conflictingReplay = buildHermesDecisionRecordV2(decisionInput(
      "A replay must not replace the original append-only decision.",
    ));
    expect(conflictingReplay.decisionId).toBe(original.decisionId);

    await recordHermesDecision(original, { query: decisionQuery });
    await recordHermesDecision(original, { query: decisionQuery });
    await recordHermesDecision(conflictingReplay, { query: decisionQuery });

    const result = await pool.query<{ count: string; record: unknown }>(
      `select count(*) over ()::text as count, record
       from hermes_decision_records
       where decision_id = $1`,
      [original.decisionId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.count).toBe("1");
    expect(result.rows[0]?.record).toEqual(original);
    await expect(
      listHermesDecisions(
        { workItemId: original.workItemId },
        { query: decisionQuery },
      ),
    ).resolves.toEqual([original]);
  });
});

function decisionInput(reason: string) {
  return {
    correlationId: "pg-correlation",
    workItemId: "pg-work-decision",
    decisionType: "dispatch_refusal" as const,
    proposal: {
      what: "Refuse the supervised dispatch attempt.",
      why: [reason],
      evidenceRefs: [],
    },
    inputs: [{
      name: "approved-task",
      hash: HASH,
      observedAt: "2026-07-24T12:00:00.000Z",
    }],
    risk: {
      tier: "medium" as const,
      reasons: ["Conflicting immutable state must fail closed."],
      irreversible: false,
    },
    approval: {
      required: "operator" as const,
      decision: "approved" as const,
      actor: { type: "operator" as const, id: "operator-one" },
      policyVersion: "policy-v1",
      policyHash: HASH,
      decidedAt: "2026-07-24T11:59:00.000Z",
    },
    effects: {
      mutates: false,
      mutations: [],
      authorityChanged: false,
      budgetChanged: false,
    },
    next: {
      action: "Operator resolves the conflicting immutable state.",
      owner: "operator" as const,
    },
    generatedAt: "2026-07-24T12:00:00.000Z",
  };
}

async function insertTask(
  pool: Pool,
  workItemId: string,
  lifecycle: string,
): Promise<void> {
  await pool.query(
    `insert into agent_tasks (
       work_item_id, task_version, correlation_id, lifecycle, executor_kind,
       approved_task_hash, deadline, updated_at, task
     ) values ($1, 1, $1, $2, 'harness', $3, now() + interval '1 hour', now(), '{}'::jsonb)`,
    [workItemId, lifecycle, HASH],
  );
}
