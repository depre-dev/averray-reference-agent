import { describe, expect, it } from "vitest";

import { DispatchClaimError } from "../../packages/averray-mcp/src/dispatch-claim.js";
import {
  bindRunToWorkItem,
  getRunBinding,
} from "../../packages/averray-mcp/src/run-binding-outbox.js";
import type { DispatchStoreQuery } from "../../packages/averray-mcp/src/dispatch-claim.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_RUN_ID = "22222222-2222-4222-8222-222222222222";
const MANIFEST_HASH = `sha256:${"a".repeat(64)}`;
const OTHER_MANIFEST_HASH = `sha256:${"b".repeat(64)}`;
const MANIFEST_REF = {
  uri: `artifact://sha256/${"a".repeat(64)}`,
  sha256: MANIFEST_HASH,
};

describe("INT-2e run-binding outbox", () => {
  it("creates one binding and treats an identical rebind as an idempotent replay", async () => {
    const db = new MemoryRunBindingDatabase();

    await expect(
      bindRunToWorkItem(
        { workItemId: "work-one", harnessRunId: RUN_ID },
        { query: db.query },
      ),
    ).resolves.toMatchObject({
      created: true,
      binding: { workItemId: "work-one", harnessRunId: RUN_ID },
    });
    await expect(
      bindRunToWorkItem(
        { workItemId: "work-one", harnessRunId: RUN_ID },
        { query: db.query },
      ),
    ).resolves.toMatchObject({
      created: false,
      binding: { harnessRunId: RUN_ID },
    });
    await expect(getRunBinding("work-one", { query: db.query }))
      .resolves.toMatchObject({ harnessRunId: RUN_ID });
    expect(db.size).toBe(1);
  });

  it("fills the immutable manifest reference and hash after the initial bind", async () => {
    const db = new MemoryRunBindingDatabase();
    await bindRunToWorkItem(
      { workItemId: "work-one", harnessRunId: RUN_ID },
      { query: db.query },
    );

    await expect(
      bindRunToWorkItem({
        workItemId: "work-one",
        harnessRunId: RUN_ID,
        runManifestRef: MANIFEST_REF,
        runManifestHash: MANIFEST_HASH,
      }, { query: db.query }),
    ).resolves.toMatchObject({
      created: false,
      binding: {
        harnessRunId: RUN_ID,
        runManifestRef: MANIFEST_REF,
        runManifestHash: MANIFEST_HASH,
      },
    });
    expect(db.size).toBe(1);
  });

  it("refuses a second Harness run id for the same work item", async () => {
    const db = new MemoryRunBindingDatabase();
    await bindRunToWorkItem(
      { workItemId: "work-one", harnessRunId: RUN_ID },
      { query: db.query },
    );

    await expect(
      bindRunToWorkItem(
        { workItemId: "work-one", harnessRunId: OTHER_RUN_ID },
        { query: db.query },
      ),
    ).rejects.toBeInstanceOf(DispatchClaimError);
    await expect(
      bindRunToWorkItem(
        { workItemId: "work-one", harnessRunId: OTHER_RUN_ID },
        { query: db.query },
      ),
    ).rejects.toMatchObject({ reason: "binding_conflict" });
    expect(db.size).toBe(1);
  });

  it("refuses manifest reference/hash disagreement and immutable manifest changes", async () => {
    const db = new MemoryRunBindingDatabase();
    await expect(
      bindRunToWorkItem({
        workItemId: "work-one",
        harnessRunId: RUN_ID,
        runManifestRef: MANIFEST_REF,
        runManifestHash: OTHER_MANIFEST_HASH,
      }, { query: db.query }),
    ).rejects.toMatchObject({ reason: "binding_conflict" });

    await bindRunToWorkItem({
      workItemId: "work-one",
      harnessRunId: RUN_ID,
      runManifestRef: MANIFEST_REF,
      runManifestHash: MANIFEST_HASH,
    }, { query: db.query });
    await expect(
      bindRunToWorkItem({
        workItemId: "work-one",
        harnessRunId: RUN_ID,
        runManifestHash: OTHER_MANIFEST_HASH,
      }, { query: db.query }),
    ).rejects.toMatchObject({ reason: "binding_conflict" });
  });
});

interface MemoryRunBindingRow {
  work_item_id: string;
  harness_run_id: string;
  run_manifest_ref: unknown | null;
  run_manifest_hash: string | null;
  bound_at: string;
}

class MemoryRunBindingDatabase {
  private readonly rows = new Map<string, MemoryRunBindingRow>();

  get size(): number {
    return this.rows.size;
  }

  readonly query: DispatchStoreQuery = async <T>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> => {
    if (/insert into agent_task_run_outbox/i.test(text)) {
      const workItemId = String(values[0]);
      if (this.rows.has(workItemId)) return [];
      const row: MemoryRunBindingRow = {
        work_item_id: workItemId,
        harness_run_id: String(values[1]),
        run_manifest_ref: parseJsonValue(values[2]),
        run_manifest_hash: values[3] === null ? null : String(values[3]),
        bound_at: "2026-07-24T12:00:00.000Z",
      };
      this.rows.set(workItemId, row);
      return [structuredClone(row) as T];
    }
    if (/update agent_task_run_outbox/i.test(text)) {
      const row = this.rows.get(String(values[0]));
      if (!row || row.harness_run_id !== values[1]) return [];
      const incomingRef = parseJsonValue(values[2]);
      const incomingHash = values[3] === null ? null : String(values[3]);
      if (
        incomingRef !== null
        && row.run_manifest_ref !== null
        && JSON.stringify(incomingRef) !== JSON.stringify(row.run_manifest_ref)
      ) {
        return [];
      }
      if (
        incomingHash !== null
        && row.run_manifest_hash !== null
        && incomingHash !== row.run_manifest_hash
      ) {
        return [];
      }
      const mergedRef = row.run_manifest_ref ?? incomingRef;
      const mergedHash = row.run_manifest_hash ?? incomingHash;
      if (
        mergedRef !== null
        && mergedHash !== null
        && manifestSha(mergedRef) !== mergedHash
      ) {
        return [];
      }
      row.run_manifest_ref = mergedRef;
      row.run_manifest_hash = mergedHash;
      return [structuredClone(row) as T];
    }
    if (/from agent_task_run_outbox/i.test(text)) {
      const row = this.rows.get(String(values[0]));
      return row ? [structuredClone(row) as T] : [];
    }
    throw new Error(`Unexpected run-binding test query: ${text}`);
  };
}

function parseJsonValue(value: unknown): unknown | null {
  if (value === null) return null;
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

function manifestSha(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>).sha256;
}
