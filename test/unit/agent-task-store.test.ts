import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  getAgentTask,
  listAgentTasks,
  listDispatchableAgentTasks,
  putAgentTask,
  type AgentTaskStoreQuery,
} from "../../packages/averray-mcp/src/agent-task-store.js";
import {
  agentTaskV1Schema,
  canonicalContractJson,
  hashAgentTaskApprovalPayload,
  type AgentTaskV1,
} from "../../packages/schemas/src/index.js";
import {
  mergeAgentTaskBoardItems,
} from "../../services/slack-operator/src/agent-task-board.js";
import type { CodexTask } from "../../services/slack-operator/src/codex-task-queue.js";
import { buildV2BoardSnapshot } from "../../services/slack-operator/src/monitor-v2.js";

describe("INT-2a AgentTask Postgres store", () => {
  it("round-trips schema-validated AgentTask V1 records and rejects invalid writes and reads", async () => {
    const db = new MemoryAgentTaskDatabase();
    const task = proposedTask();

    await expect(putAgentTask(task, { query: db.query })).resolves.toEqual(task);
    const stored = await getAgentTask(task.workItemId, task.taskVersion, { query: db.query });
    expect(stored).toEqual(task);
    expect(canonicalContractJson(stored)).toBe(canonicalContractJson(task));
    await expect(listAgentTasks({}, { query: db.query })).resolves.toEqual([task]);

    const invalid = {
      ...task,
      requestedAuthority: {
        ...task.requestedAuthority,
        delegable: true,
      },
    } as unknown as AgentTaskV1;
    await expect(putAgentTask(invalid, { query: db.query })).rejects.toThrow();
    expect(db.size).toBe(1);

    db.corruptStoredTask(task.workItemId, task.taskVersion, { ...task, schemaVersion: 2 });
    await expect(getAgentTask(task.workItemId, task.taskVersion, { query: db.query }))
      .rejects.toThrow();
  });

  it("keeps one row per work item and task version while storing newer versions separately", async () => {
    const db = new MemoryAgentTaskDatabase();
    const v1 = proposedTask();
    const v1Updated = proposedTask({
      proposal: {
        ...v1.proposal,
        title: "Updated title for the same task version",
      },
      timestamps: {
        ...v1.timestamps,
        updatedAt: "2026-07-23T12:05:00.000Z",
      },
    });
    const v2 = proposedTask({
      taskVersion: 2,
      timestamps: {
        ...v1.timestamps,
        updatedAt: "2026-07-23T12:10:00.000Z",
      },
    });

    await putAgentTask(v1, { query: db.query });
    await putAgentTask(v1Updated, { query: db.query });
    expect(db.size).toBe(1);
    await expect(getAgentTask(v1.workItemId, 1, { query: db.query }))
      .resolves.toMatchObject({ proposal: { title: "Updated title for the same task version" } });

    await putAgentTask(v2, { query: db.query });
    expect(db.size).toBe(2);
    await expect(listAgentTasks({}, { query: db.query }))
      .resolves.toEqual([v2, v1Updated]);
  });

  it("lists only approved, hash-bound Harness tasks as dispatchable", async () => {
    const db = new MemoryAgentTaskDatabase();
    const harnessApproved = await approvedTask({
      workItemId: "work-harness-approved",
      correlationId: "correlation-harness-approved",
    });
    const directApproved = await approvedTask({
      workItemId: "work-direct-approved",
      correlationId: "correlation-direct-approved",
      executor: {
        kind: "direct",
        directAgent: "codex",
        selectionReason: "The legacy direct runner remains the explicit fallback.",
      },
    });
    const harnessProposed = proposedTask({
      workItemId: "work-harness-proposed",
      correlationId: "correlation-harness-proposed",
    });

    for (const task of [harnessApproved, directApproved, harnessProposed]) {
      await putAgentTask(task, { query: db.query });
    }
    await expect(
      putAgentTask(legacyTask() as unknown as AgentTaskV1, { query: db.query }),
    ).rejects.toThrow();
    expect(db.size).toBe(3);

    await expect(listDispatchableAgentTasks({ query: db.query }))
      .resolves.toEqual([harnessApproved]);
  });

  it("pins the additive migration primary key and lookup indexes", () => {
    const migration = readFileSync(
      new URL("../../ops/migrations/002_agent_tasks.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toMatch(/primary key\s*\(work_item_id,\s*task_version\)/i);
    expect(migration).toMatch(/agent_tasks_lifecycle_idx/i);
    expect(migration).toMatch(/agent_tasks_correlation_id_idx/i);
  });
});

describe("INT-2a dual-read board path", () => {
  it("preserves legacy rows as non-dispatchable and emits one card per work item", () => {
    const legacy = legacyTask();
    const legacyBefore = structuredClone(legacy);
    const currentAgentTask = proposedTask({
      workItemId: legacy.id,
      correlationId: legacy.correlationId!,
      proposal: {
        ...proposedTask().proposal,
        title: "Current AgentTask replaces the correlated legacy board row",
      },
    });
    const olderVersion = proposedTask({
      workItemId: legacy.id,
      correlationId: legacy.correlationId!,
      taskVersion: 1,
      timestamps: {
        ...proposedTask().timestamps,
        updatedAt: "2026-07-23T11:00:00.000Z",
      },
    });
    const latestVersion = proposedTask({
      ...currentAgentTask,
      taskVersion: 2,
      timestamps: {
        ...currentAgentTask.timestamps,
        updatedAt: "2026-07-23T12:10:00.000Z",
      },
    });
    const legacyOnly = legacyTask({
      id: "legacy-only",
      correlationId: "correlation-legacy-only",
    });

    const items = mergeAgentTaskBoardItems(
      [legacy, legacyOnly],
      [olderVersion, latestVersion],
    );

    expect(legacy).toEqual(legacyBefore);
    expect(items).toHaveLength(2);
    expect(items.filter((item) => item.workItemId === legacy.id)).toEqual([
      expect.objectContaining({
        sourceKind: "agent_task",
        taskVersion: 2,
        agent: "harness",
      }),
    ]);
    expect(items.find((item) => item.workItemId === legacyOnly.id)).toMatchObject({
      sourceKind: "codex_task",
      nonDispatchable: true,
      missingRequiredAgentTaskFields: expect.arrayContaining([
        "taskIntentRef",
        "approvalPolicyHash",
      ]),
    });

    const board = buildV2BoardSnapshot(
      {
        active: [],
        recent: [],
        codexTasks: { items },
      },
      { now: () => new Date("2026-07-23T12:11:00.000Z") },
    );
    expect(board.cards.filter((card) => card.id === legacy.id)).toHaveLength(1);
    expect(board.cards.find((card) => card.id === legacy.id)).toMatchObject({
      type: "task",
      agentType: "harness",
      taskStatus: "proposed",
      correlationId: legacy.correlationId,
    });
    expect(board.cards.find((card) => card.id === legacyOnly.id)).toMatchObject({
      type: "task",
      agentType: "codex",
      taskStatus: "proposed",
    });
  });
});

class MemoryAgentTaskDatabase {
  readonly rows = new Map<string, MemoryAgentTaskRow>();

  get size(): number {
    return this.rows.size;
  }

  readonly query: AgentTaskStoreQuery = async <T>(
    text: string,
    values: unknown[] = [],
  ): Promise<T[]> => {
    if (/insert into agent_tasks/i.test(text)) {
      const row: MemoryAgentTaskRow = {
        work_item_id: String(values[0]),
        task_version: Number(values[1]),
        correlation_id: String(values[2]),
        lifecycle: String(values[3]),
        executor_kind: String(values[4]),
        approved_task_hash: values[5] === null ? null : String(values[5]),
        deadline: String(values[6]),
        updated_at: String(values[7]),
        task: JSON.parse(String(values[8])) as unknown,
      };
      this.rows.set(key(row.work_item_id, row.task_version), row);
      return [structuredClone(row) as T];
    }

    let rows = [...this.rows.values()];
    if (/where work_item_id = \$1 and task_version = \$2/i.test(text)) {
      rows = rows.filter((row) =>
        row.work_item_id === values[0] && row.task_version === values[1]);
    } else {
      rows = filterColumn(rows, text, values, "work_item_id");
      rows = filterColumn(rows, text, values, "correlation_id");
      rows = filterColumn(rows, text, values, "lifecycle");
      rows = filterColumn(rows, text, values, "executor_kind");
      if (/approved_task_hash is not null/i.test(text)) {
        rows = rows.filter((row) => row.approved_task_hash !== null);
      }
    }
    rows.sort((left, right) => {
      const ascending = /order by updated_at asc/i.test(text);
      const updated = Date.parse(left.updated_at) - Date.parse(right.updated_at);
      return ascending ? updated : -updated;
    });
    const limitMatch = /limit \$(\d+)/i.exec(text);
    const limit = limitMatch ? Number(values[Number(limitMatch[1]) - 1]) : rows.length;
    return rows.slice(0, limit).map((row) => structuredClone(row) as T);
  };

  corruptStoredTask(workItemId: string, taskVersion: number, task: unknown): void {
    const row = this.rows.get(key(workItemId, taskVersion));
    if (!row) throw new Error("missing row");
    row.task = task;
  }
}

interface MemoryAgentTaskRow {
  work_item_id: string;
  task_version: number;
  correlation_id: string;
  lifecycle: string;
  executor_kind: string;
  approved_task_hash: string | null;
  deadline: string;
  updated_at: string;
  task: unknown;
}

function filterColumn(
  rows: MemoryAgentTaskRow[],
  text: string,
  values: unknown[],
  column: keyof MemoryAgentTaskRow,
): MemoryAgentTaskRow[] {
  const match = new RegExp(`${column} = \\$(\\d+)`, "i").exec(text);
  if (!match) return rows;
  return rows.filter((row) => row[column] === values[Number(match[1]) - 1]);
}

function proposedTask(overrides: Partial<AgentTaskV1> = {}): AgentTaskV1 {
  const base = JSON.parse(
    readFileSync(
      new URL("../fixtures/agent-integration/agent-task-v1.json", import.meta.url),
      "utf8",
    ),
  ) as AgentTaskV1;
  return agentTaskV1Schema.parse({ ...base, ...overrides });
}

async function approvedTask(overrides: Partial<AgentTaskV1> = {}): Promise<AgentTaskV1> {
  const proposed = proposedTask(overrides);
  const approvedTaskHash = await hashAgentTaskApprovalPayload(proposed);
  return agentTaskV1Schema.parse({
    ...proposed,
    lifecycle: "approved",
    approval: {
      ...proposed.approval,
      status: "approved",
      actor: { type: "operator", id: "operator-one" },
      decidedAt: "2026-07-23T12:01:00.000Z",
      approvedTaskHash,
    },
    timestamps: {
      ...proposed.timestamps,
      approvedAt: "2026-07-23T12:01:00.000Z",
      updatedAt: "2026-07-23T12:01:00.000Z",
    },
  });
}

function legacyTask(overrides: Partial<CodexTask> = {}): CodexTask {
  return {
    schemaVersion: 1,
    kind: "codex_task",
    id: "work-shared",
    repo: "owner/repo",
    agent: "codex",
    correlationId: "correlation-shared",
    title: "Legacy task",
    prompt: "Preserve this legacy task without rewriting it.",
    requester: "hermes",
    status: "proposed",
    createdAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:00:00.000Z",
    ...overrides,
  };
}

function key(workItemId: string, taskVersion: number): string {
  return `${workItemId}:${taskVersion}`;
}
