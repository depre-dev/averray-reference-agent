import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  findBindingIntegrityViolations,
} from "../../packages/averray-mcp/src/dispatch-quarantine.js";
import { deriveIntendedRunId } from "../../packages/averray-mcp/src/dispatch-claim.js";

const HASH = `sha256:${"a".repeat(64)}`;

describe("INT-4b dispatch quarantine store contract", () => {
  it("detects intended-id mismatches and duplicate run ids independently", () => {
    const intended = deriveIntendedRunId("work-one", 1, HASH);
    const duplicate = "00000000-0000-5000-8000-000000000099";
    expect(findBindingIntegrityViolations([
      {
        workItemId: "work-one",
        taskVersion: 1,
        approvedTaskHash: HASH,
        harnessRunId: intended,
      },
      {
        workItemId: "work-two",
        taskVersion: 1,
        approvedTaskHash: HASH,
        harnessRunId: duplicate,
      },
      {
        workItemId: "work-three",
        taskVersion: 2,
        approvedTaskHash: HASH,
        harnessRunId: duplicate,
      },
    ])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "run_id_mismatch",
        workItemId: "work-two",
      }),
      expect.objectContaining({
        kind: "run_id_mismatch",
        workItemId: "work-three",
      }),
      expect.objectContaining({
        kind: "duplicate_run_id",
        workItemId: "work-two",
        conflictingWorkItemId: "work-three",
      }),
      expect.objectContaining({
        kind: "duplicate_run_id",
        workItemId: "work-three",
        conflictingWorkItemId: "work-two",
      }),
    ]));
  });

  it("pins the additive active-marker schema and ordered migration runner", async () => {
    const migration = await readFile(
      new URL("../../ops/migrations/004_dispatch_quarantines.sql", import.meta.url),
      "utf8",
    );
    const runner = await readFile(
      new URL("../../ops/migrate.sh", import.meta.url),
      "utf8",
    );
    expect(migration).toMatch(/create table if not exists agent_task_dispatch_quarantines/i);
    expect(migration).toMatch(/primary key\s*\(work_item_id,\s*task_version\)/i);
    expect(migration).toMatch(/where cleared_at is null/i);
    expect(runner.indexOf("003_dispatch_claims_outbox_decisions.sql"))
      .toBeLessThan(runner.indexOf("004_dispatch_quarantines.sql"));
  });
});
