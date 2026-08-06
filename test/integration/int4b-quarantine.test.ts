import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  agentTaskV1Schema,
  hashAgentTaskApprovalPayload,
  type AgentTaskV1,
} from "@avg/schemas";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  listAgentTasks,
  putAgentTask,
} from "../../packages/averray-mcp/src/agent-task-store.js";
import {
  deriveIntendedRunId,
} from "../../packages/averray-mcp/src/dispatch-claim.js";
import {
  getActiveDispatchQuarantine,
  listRunBindingAuditRows,
  markDispatchQuarantine,
} from "../../packages/averray-mcp/src/dispatch-quarantine.js";
import {
  HarnessReadError,
  type HarnessRunReadSnapshot,
} from "../../packages/averray-mcp/src/harness-read-port.js";
import {
  bindRunToWorkItem,
  getRunBinding,
} from "../../packages/averray-mcp/src/run-binding-outbox.js";
import {
  createDispatcherProcess,
  type DispatcherHeartbeat,
  type DispatcherProcess,
} from "../../services/harness-dispatcher/src/index.js";
import {
  createPoisonFailureTracker,
  reconcileDispatchedRuns,
  type ReconcileRunDeps,
} from "../../services/harness-dispatcher/src/reconcile-run.js";
import { createPostgresWatchdogProbes } from "../../services/harness-watchdog/src/postgres-probes.js";
import {
  createWatchdogProcess,
  detectOrphans,
  type WatchdogDetection,
} from "../../services/harness-watchdog/src/watchdog.js";

const REFERENCE_URL = process.env.INT4B_REFERENCE_DATABASE_URL?.trim();
const HARNESS_URL = process.env.INT4B_HARNESS_DATABASE_URL?.trim();
const RUN = REFERENCE_URL && HARNESS_URL ? describe : describe.skip;
const MUTATION = process.env.INT4B_MUTATION?.trim();
const NOW = new Date("2026-08-06T12:00:00.000Z");
const OLD = "2026-08-06T10:00:00.000Z";
const FRESH = "2026-08-06T11:59:30.000Z";
const SHA = `sha256:${"f".repeat(64)}`;

let referencePool: Pool;
let harnessPool: Pool;
let fixture: AgentTaskV1;
let scratchRoot = "";

RUN("INT-4b quarantine and orphan drills", () => {
  beforeAll(async () => {
    referencePool = new Pool({ connectionString: REFERENCE_URL });
    harnessPool = new Pool({ connectionString: HARNESS_URL });
    fixture = agentTaskV1Schema.parse(JSON.parse(await readFile(
      new URL("../fixtures/agent-integration/agent-task-v1.json", import.meta.url),
      "utf8",
    )));
    scratchRoot = await mkdtemp(path.join(tmpdir(), "int4b-drill-"));
    for (const migration of [
      "001_init.sql",
      "002_agent_tasks.sql",
      "003_dispatch_claims_outbox_decisions.sql",
      "004_dispatch_quarantines.sql",
    ]) {
      await referencePool.query(await readFile(
        new URL(`../../ops/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    await harnessPool.query(`
      create table if not exists runs (
        run_id text primary key,
        outcome text,
        state text not null default 'executing',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        mode text not null default 'healthy'
      );
      create table if not exists domain_events (
        seq bigint generated always as identity primary key,
        run_id text not null,
        ts timestamptz not null default now()
      );
    `);
  });

  beforeEach(async () => {
    await referencePool.query(`
      truncate table
        hermes_decision_records,
        agent_task_dispatch_quarantines,
        agent_task_run_outbox,
        agent_task_dispatch_claims,
        agent_tasks,
        dispatch_lease
    `);
    await harnessPool.query("truncate table domain_events, runs restart identity");
  });

  afterAll(async () => {
    await Promise.all([referencePool?.end(), harnessPool?.end()]);
    if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
  });

  it("quarantines a stable poison fingerprint once and keeps other bindings live", async () => {
    const poison = await seedTask("poison", "running", { bind: true });
    const healthy = await seedTask("healthy", "running", { bind: true });
    await seedHarnessRun(poison.runId, "poison");
    await seedHarnessRun(healthy.runId, "healthy");
    const harness = dispatcherHarness({
      includeTimestampInFingerprint: MUTATION === "timestamp-fingerprint",
    });
    if (MUTATION === "timestamp-fingerprint") {
      console.info("INT4B_MUTATION_APPLIED=timestamp-fingerprint");
    }

    await harness.tick(3);
    const marker = await getActiveDispatchQuarantine(
      poison.task.workItemId,
      1,
      refDeps(),
    );
    expect(marker, "INT4B_POISON_MARKER_MISSING").toMatchObject({
      reason: "poison_read",
      cycleCount: 3,
    });
    expect(harness.alerts.filter(({ code }) => code === "poison_read_quarantined"))
      .toHaveLength(1);
    expect(harness.reads.get(poison.runId)).toBe(3);
    expect(harness.reads.get(healthy.runId)).toBe(3);

    await harness.tick(1);
    expect(harness.reads.get(poison.runId), "quarantine must stop poison rereads")
      .toBe(3);
    expect(harness.reads.get(healthy.runId), "other bindings must keep reconciling")
      .toBe(4);
    print(
      "INT4B_DRILL_GREEN poison-quarantine marker=durable cycles=3 critical_alerts=1 poison_reads=3 other_reads=4",
    );
  });

  it("honors the durable marker after a dispatcher restart", async () => {
    const poison = await seedTask("restart", "running", { bind: true });
    await seedHarnessRun(poison.runId, "poison");
    const first = dispatcherHarness({
      skipMarkerWrite: MUTATION === "skip-marker-write",
    });
    if (MUTATION === "skip-marker-write") {
      console.info("INT4B_MUTATION_APPLIED=skip-marker-write");
    }
    await first.tick(3);
    const beforeRestart = await getActiveDispatchQuarantine(
      poison.task.workItemId,
      1,
      refDeps(),
    );
    expect(beforeRestart, "INT4B_RESTART_MARKER_NOT_DURABLE").toBeDefined();

    const restarted = dispatcherHarness();
    await restarted.tick(1);
    expect(restarted.reads.get(poison.runId) ?? 0, "restart resumed poison reads")
      .toBe(0);
    print(
      "INT4B_DRILL_GREEN quarantine-restart marker=honored post_restart_reads=0 retry_storm=false",
    );
  });

  it("does not count a transient database outage toward quarantine", async () => {
    const transient = await seedTask("transient", "running", { bind: true });
    await seedHarnessRun(transient.runId, "transient");
    const harness = dispatcherHarness({
      countTransientFailures: MUTATION === "count-transient",
      transientFailures: 4,
    });
    if (MUTATION === "count-transient") {
      console.info("INT4B_MUTATION_APPLIED=count-transient");
    }
    await harness.tick(4);
    expect(
      await getActiveDispatchQuarantine(
        transient.task.workItemId,
        1,
        refDeps(),
      ),
      "INT4B_NEGATIVE_DRILL_TRANSIENT_WAS_QUARANTINED",
    ).toBeUndefined();
    await harness.tick(1);
    expect(harness.reads.get(transient.runId)).toBe(5);
    expect(harness.heartbeats.at(-1)).toMatchObject({ cycleCount: 5 });
    print(
      "INT4B_DRILL_GREEN transient-not-poison outage_cycles=4 quarantine=false resumed=true heartbeat_cycle=5",
    );
  });

  it("marks a conflicting binding while the independent watchdog alerts", async () => {
    const conflict = await seedTask("binding-conflict", "dispatching", {
      bind: false,
    });
    const wrongRunId = "00000000-0000-5000-8000-000000000099";
    await bindRunToWorkItem({
      workItemId: conflict.task.workItemId,
      harnessRunId: wrongRunId,
    }, refDeps());
    await seedHarnessRun(wrongRunId, "healthy");
    const dispatcher = dispatcherHarness();
    await dispatcher.tick(1);
    const marker = await getActiveDispatchQuarantine(
      conflict.task.workItemId,
      1,
      refDeps(),
    );
    expect(marker).toMatchObject({ reason: "binding_integrity" });

    const watchdog = await watchdogHarness();
    try {
      await watchdog.process.tick();
      const records = await alertRecords(watchdog.alertsPath);
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({
          severity: "critical",
          code: "watchdog_binding_integrity_violation",
        }),
      ]));
      expect(JSON.stringify(records)).toContain(wrongRunId);
      expect(JSON.stringify(records)).toContain(conflict.runId);
    } finally {
      await watchdog.close();
    }
    print(
      `INT4B_DRILL_GREEN conflicting-binding dispatcher_marker=present watchdog_alert=critical actual=${wrongRunId} intended=${conflict.runId}`,
    );
  });

  it("warns once for both age-gated orphan classes", async () => {
    const missing = await seedTask("missing-run", "running", { bind: true });
    const terminal = await seedTask("terminal-task", "failed", { bind: true });
    const fresh = await seedTask("fresh-missing", "running", { bind: true });
    await referencePool.query(
      "update agent_task_run_outbox set bound_at = $1 where work_item_id in ($2, $3)",
      [OLD, missing.task.workItemId, terminal.task.workItemId],
    );
    await referencePool.query(
      "update agent_task_run_outbox set bound_at = $1 where work_item_id = $2",
      [FRESH, fresh.task.workItemId],
    );
    await seedHarnessRun(terminal.runId, "healthy", { updatedAt: OLD });

    const watchdog = await watchdogHarness({
      detectOrphans: MUTATION === "drop-orphan-class"
        ? (bindings, runs, now, age) => {
            console.info("INT4B_MUTATION_APPLIED=drop-orphan-class");
            return detectOrphans(bindings, runs, now, age).filter(
              ({ code }) => code !== "watchdog_harness_run_orphan",
            );
          }
        : undefined,
    });
    try {
      await watchdog.process.tick();
      await watchdog.process.tick();
      const records = await alertRecords(watchdog.alertsPath);
      const orphanRecords = records.filter((record) =>
        String(record.code).includes("orphan"));
      expect(orphanRecords, "INT4B_ORPHAN_CLASS_MISSING").toHaveLength(2);
      expect(orphanRecords.map(({ code }) => code).sort()).toEqual([
        "watchdog_harness_run_orphan",
        "watchdog_task_run_orphan",
      ]);
      expect(JSON.stringify(orphanRecords)).not.toContain(fresh.task.workItemId);
    } finally {
      await watchdog.close();
    }
    print(
      "INT4B_DRILL_GREEN orphan-pair task_without_run=warn run_with_terminal_task=warn deduplicated=2 age_gate=fresh_excluded",
    );
  });
});

function refDeps() {
  return { query: referenceQuery };
}

async function referenceQuery<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await referencePool.query(text, values)).rows as T[];
}

async function seedTask(
  suffix: string,
  lifecycle: "dispatching" | "running" | "failed",
  options: { bind: boolean },
): Promise<{ task: AgentTaskV1; runId: string }> {
  const workItemId = `int4b-${suffix}`;
  const approvedAt = OLD;
  const candidate = {
    ...fixture,
    workItemId,
    correlationId: workItemId,
    lifecycle,
    deadline: "2026-08-07T12:00:00.000Z",
    approval: {
      ...fixture.approval,
      status: "approved" as const,
      actor: { type: "operator" as const, id: "int4b-operator" },
      decidedAt: approvedAt,
      approvedTaskHash: SHA,
    },
    timestamps: {
      ...fixture.timestamps,
      proposedAt: OLD,
      approvedAt,
      dispatchClaimedAt: OLD,
      runBoundAt: OLD,
      ...(lifecycle === "failed" ? { terminalAt: OLD } : {}),
      updatedAt: lifecycle === "failed" ? OLD : OLD,
    },
    bindings: { harnessRunId: "11111111-1111-5111-8111-111111111111" },
  };
  const approvedTaskHash = await hashAgentTaskApprovalPayload(
    candidate as AgentTaskV1,
  );
  const runId = deriveIntendedRunId(workItemId, 1, approvedTaskHash);
  const task = agentTaskV1Schema.parse({
    ...candidate,
    approval: { ...candidate.approval, approvedTaskHash },
    bindings: options.bind ? { harnessRunId: runId } : undefined,
  });
  await putAgentTask(task, refDeps());
  if (options.bind) {
    await bindRunToWorkItem({ workItemId, harnessRunId: runId }, refDeps());
    await referencePool.query(
      "update agent_task_run_outbox set bound_at = $1 where work_item_id = $2",
      [OLD, workItemId],
    );
  }
  return { task, runId };
}

async function seedHarnessRun(
  runId: string,
  mode: "healthy" | "poison" | "transient",
  options: { updatedAt?: string } = {},
): Promise<void> {
  await harnessPool.query(
    `insert into runs (run_id, outcome, state, created_at, updated_at, mode)
     values ($1, null, 'executing', $2, $2, $3)`,
    [runId, options.updatedAt ?? OLD, mode],
  );
}

function dispatcherHarness(options: {
  includeTimestampInFingerprint?: boolean;
  countTransientFailures?: boolean;
  skipMarkerWrite?: boolean;
  transientFailures?: number;
} = {}): {
  process: DispatcherProcess;
  alerts: Array<Record<string, unknown>>;
  reads: Map<string, number>;
  heartbeats: DispatcherHeartbeat[];
  tick(count: number): Promise<void>;
} {
  const alerts: Array<Record<string, unknown>> = [];
  const reads = new Map<string, number>();
  const heartbeats: DispatcherHeartbeat[] = [];
  let now = new Date(NOW);
  let transientFailures = options.transientFailures ?? 0;
  const deps: ReconcileRunDeps = {
    now: () => now,
    isHalted: () => false,
    activePolicyIdentity: undefined,
    listTasks: () => listAgentTasks({ executorKind: "harness", limit: 1_000 }, refDeps()),
    saveTask: (task) => putAgentTask(task, refDeps()),
    getRunBinding: (workItemId) => getRunBinding(workItemId, refDeps()),
    getPolicyDrift: async () => undefined,
    transitionPolicyDrift: async (input) => ({
      state: {
        workItemId: input.workItemId,
        taskVersion: input.taskVersion,
        active: input.active,
        approvedPolicy: input.approvedPolicy,
        activePolicy: input.activePolicy,
        changedAt: now.toISOString(),
      },
      notify: input.active,
    }),
    getActiveQuarantine: (workItemId, taskVersion) =>
      getActiveDispatchQuarantine(workItemId, taskVersion, refDeps()),
    markQuarantine: options.skipMarkerWrite
      ? async (input) => ({
          marker: { ...input, quarantinedAt: now.toISOString() },
          activated: true,
        })
      : (input) => markDispatchQuarantine(input, refDeps()),
    listBindingAuditRows: () => listRunBindingAuditRows(refDeps()),
    bindRun: (input) => bindRunToWorkItem(input, refDeps()),
    readPort: {
      async readRun({ harnessRunId }): Promise<HarnessRunReadSnapshot> {
        reads.set(harnessRunId, (reads.get(harnessRunId) ?? 0) + 1);
        const row = (await harnessPool.query<{ mode: string }>(
          "select mode from runs where run_id = $1",
          [harnessRunId],
        )).rows[0];
        if (!row) {
          throw new HarnessReadError(
            "run_not_started",
            "Harness run record is unavailable",
            true,
          );
        }
        if (row.mode === "poison") {
          throw new HarnessReadError(
            "status_malformed",
            "Harness status response is malformed",
            false,
          );
        }
        if (row.mode === "transient" && transientFailures > 0) {
          transientFailures -= 1;
          throw new HarnessReadError(
            "cli_failed",
            "Harness data source is unavailable",
            true,
          );
        }
        return snapshot(harnessRunId, now);
      },
    },
    controlPort: { cancel: vi.fn(async () => undefined) },
    recordDecision: vi.fn(async () => undefined),
    alertSink: async (alert) => {
      alerts.push(alert);
    },
    poisonThreshold: 3,
    poisonFailures: createPoisonFailureTracker({
      includeTimestampInFingerprint: options.includeTimestampInFingerprint,
      countTransientFailures: options.countTransientFailures,
    }),
    logger: { warn: vi.fn() },
  };
  const process = createDispatcherProcess({
    dispatcherId: "int4b-dispatcher",
    pollIntervalMs: 5_000,
    leaseTtlSeconds: 120,
    readTimeoutMs: 1_000,
    poisonThreshold: 3,
    intentDir: path.join(scratchRoot, "intents"),
    heartbeatPath: path.join(scratchRoot, "dispatcher-heartbeat.json"),
    harnessBin: "harness",
  }, {
    runReconcile: () => reconcileDispatchedRuns(deps),
    runAttempt: async () => ({ outcome: "disabled" }),
    isDispatchEnabled: () => false,
    isHalted: () => false,
    releaseLease: async () => true,
    writeHeartbeat: async (heartbeat) => {
      heartbeats.push(heartbeat);
    },
    now: () => now,
    logger: { info: vi.fn(), warn: vi.fn() },
    scheduler: {
      setTimeout: () => {
        throw new Error("INT4B unexpected dispatcher timer");
      },
      clearTimeout: vi.fn(),
    },
  });
  return {
    process,
    alerts,
    reads,
    heartbeats,
    async tick(count) {
      for (let index = 0; index < count; index += 1) {
        now = new Date(now.getTime() + 1_000);
        await process.tick();
      }
    },
  };
}

async function watchdogHarness(options: {
  detectOrphans?: (
    bindings: Parameters<typeof detectOrphans>[0],
    runs: Parameters<typeof detectOrphans>[1],
    now: Date,
    age: number,
  ) => WatchdogDetection[];
} = {}) {
  const root = await mkdtemp(path.join(scratchRoot, "watchdog-"));
  const alertsPath = path.join(root, "alerts.jsonl");
  const heartbeatPath = path.join(root, "watchdog-heartbeat.json");
  const statusPath = path.join(root, "watchdog-status.json");
  const dispatcherHeartbeatPath = path.join(root, "dispatcher-heartbeat.json");
  await writeFile(dispatcherHeartbeatPath, JSON.stringify({
    updatedAt: NOW.toISOString(),
  }));
  const probes = createPostgresWatchdogProbes({
    referenceDatabaseUrl: REFERENCE_URL,
    harnessDatabaseUrl: HARNESS_URL,
    connectionTimeoutMs: 1_000,
  });
  const process = createWatchdogProcess({
    pollIntervalMs: 10,
    dispatcherStaleMs: 90_000,
    harnessSourceStaleMs: 900_000,
    databaseTimeoutMs: 1_000,
    orphanAgeMs: 60_000,
    alertsPath,
    dispatcherHeartbeatPath,
    heartbeatPath,
    statusPath,
  }, {
    ...probes,
    forwarders: [],
    now: () => NOW,
    logger: { info: vi.fn(), warn: vi.fn() },
    scheduler: {
      setTimeout: () => {
        throw new Error("INT4B unexpected watchdog timer");
      },
      clearTimeout: vi.fn(),
    },
    ...(options.detectOrphans ? { detectOrphans: options.detectOrphans } : {}),
  });
  return {
    process,
    alertsPath,
    async close() {
      await process.shutdown();
      await probes.close();
    },
  };
}

function snapshot(runId: string, now: Date): HarnessRunReadSnapshot {
  return {
    status: {
      runId,
      state: "executing",
      attempt: 1,
      egressPolicy: "deny",
      createdAt: OLD,
      updatedAt: now.toISOString(),
    },
    events: [],
    deliverables: [],
  };
}

async function alertRecords(target: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(target, "utf8").catch(() => "");
  return raw.trim()
    ? raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

function print(line: string): void {
  if (process.env.INT4B_PRINT_EVIDENCE === "1") console.info(line);
}
