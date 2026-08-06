import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  agentTaskV1Schema,
  hashAgentTaskApprovalPayload,
  type AgentTaskV1,
  type PilotProfileManifest,
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
  listDispatchableAgentTasks,
  putAgentTask,
} from "../../packages/averray-mcp/src/agent-task-store.js";
import {
  acquireDispatchLease,
  claimDispatch,
  deriveIntendedRunId,
  getDispatchClaim,
  releaseDispatchLease,
  renewDispatchLease,
} from "../../packages/averray-mcp/src/dispatch-claim.js";
import {
  getActiveDispatchQuarantine,
  listRunBindingAuditRows,
  markDispatchQuarantine,
} from "../../packages/averray-mcp/src/dispatch-quarantine.js";
import { HarnessReadError } from "../../packages/averray-mcp/src/harness-read-port.js";
import {
  bindRunToWorkItem,
  getRunBinding,
} from "../../packages/averray-mcp/src/run-binding-outbox.js";
import { buildTaskIntentArtifact } from "../../packages/averray-mcp/src/task-intent-mapping.js";
import { workspacePathForTask } from "../../packages/averray-mcp/src/workspace-path.js";
import {
  createDispatcherProcess,
  type DispatcherHeartbeat,
} from "../../services/harness-dispatcher/src/index.js";
import {
  runSingleDispatch,
  type DispatchDeps,
} from "../../services/harness-dispatcher/src/dispatch-attempt.js";
import {
  createPoisonFailureTracker,
  reconcileDispatchedRuns,
  type ReconcileRunDeps,
} from "../../services/harness-dispatcher/src/reconcile-run.js";

const DATABASE_URL = process.env.INT4C_REFERENCE_DATABASE_URL?.trim();
const RUN = DATABASE_URL ? describe : describe.skip;
const NOW = new Date("2026-08-06T12:00:00.000Z");
const OLD = "2026-08-06T10:00:00.000Z";
const DEADLINE = "2026-08-07T12:00:00.000Z";
const PLACEHOLDER_HASH = `sha256:${"f".repeat(64)}`;
const CAPABILITIES: PilotProfileManifest["capabilities"] = [
  { id: "fs.read_file", effectClass: "none", delegable: false },
  { id: "fs.write_file", effectClass: "local", delegable: false },
  { id: "fs.list_files", effectClass: "none", delegable: false },
  { id: "shell.run", effectClass: "local", delegable: false },
  { id: "git.status", effectClass: "none", delegable: false },
  { id: "git.diff", effectClass: "none", delegable: false },
  { id: "artifact.put", effectClass: "local", delegable: false },
  { id: "artifact.get", effectClass: "none", delegable: false },
];

let pool: Pool;
let fixture: AgentTaskV1;

RUN("INT-4c exact-main D0", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    fixture = agentTaskV1Schema.parse(JSON.parse(await readFile(
      new URL("../fixtures/agent-integration/agent-task-v1.json", import.meta.url),
      "utf8",
    )));
    for (const migration of [
      "001_init.sql",
      "002_agent_tasks.sql",
      "003_dispatch_claims_outbox_decisions.sql",
      "004_dispatch_quarantines.sql",
    ]) {
      await pool.query(await readFile(
        new URL(`../../ops/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
  });

  beforeEach(async () => {
    await pool.query(`
      truncate table
        hermes_decision_records,
        agent_task_dispatch_quarantines,
        agent_task_run_outbox,
        agent_task_dispatch_claims,
        agent_tasks,
        dispatch_lease
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("records the orphaned claim silence with a live restarted loop", async () => {
    const task = await taskFor("orphaned-claim", "dispatching");
    await putAgentTask(task, deps());
    const runId = deriveIntendedRunId(
      task.workItemId,
      task.taskVersion,
      task.approval.approvedTaskHash!,
    );
    await claimDispatch({
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      approvedTaskHash: task.approval.approvedTaskHash!,
      intendedRunId: runId,
    }, deps());

    const heartbeats: DispatcherHeartbeat[] = [];
    let now = new Date(NOW);
    let runReads = 0;
    const reconcileDeps: ReconcileRunDeps = {
      now: () => now,
      isHalted: () => false,
      listTasks: () => listAgentTasks({ executorKind: "harness", limit: 1_000 }, deps()),
      saveTask: (candidate) => putAgentTask(candidate, deps()),
      getRunBinding: (workItemId) => getRunBinding(workItemId, deps()),
      getActiveQuarantine: (workItemId, taskVersion) =>
        getActiveDispatchQuarantine(workItemId, taskVersion, deps()),
      markQuarantine: (input) => markDispatchQuarantine(input, deps()),
      listBindingAuditRows: () => listRunBindingAuditRows(deps()),
      bindRun: (input) => bindRunToWorkItem(input, deps()),
      readPort: {
        async readRun() {
          runReads += 1;
          throw new HarnessReadError("run_not_started", "run is absent", true);
        },
      },
      controlPort: { cancel: vi.fn(async () => undefined) },
      recordDecision: vi.fn(async () => undefined),
      alertSink: vi.fn(async () => undefined),
      poisonThreshold: 5,
      poisonFailures: createPoisonFailureTracker(),
      logger: { warn: vi.fn() },
    };
    const restarted = createDispatcherProcess(processConfig("d0-restarted"), {
      runReconcile: () => reconcileDispatchedRuns(reconcileDeps),
      runAttempt: async () => ({ outcome: "idle" }),
      isDispatchEnabled: () => true,
      isHalted: () => false,
      releaseLease: async () => true,
      writeHeartbeat: async (heartbeat) => {
        heartbeats.push(heartbeat);
      },
      now: () => now,
      logger: { info: vi.fn(), warn: vi.fn() },
      scheduler: unexpectedScheduler(),
    });

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      now = new Date(NOW.getTime() + cycle * 1_000);
      await restarted.tick();
    }
    const claim = await getDispatchClaim(task.workItemId, 1, deps());
    const stored = (await listAgentTasks({ workItemId: task.workItemId }, deps()))[0]!;
    const decisions = await pool.query("select count(*)::int as count from hermes_decision_records");

    expect(heartbeats.map(({ cycleCount }) => cycleCount)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(runReads).toBe(3);
    expect(claim?.leaseExpiresAt).toBeUndefined();
    expect(stored.lifecycle).toBe("dispatching");
    expect(decisions.rows[0]?.count).toBe(0);
    console.info(
      `INT4C_D0_SILENCE orphaned_claim lifecycle=${stored.lifecycle} claim_lease=null run_reads=${runReads} alerts=0 heartbeats=${[...new Set(heartbeats.map(({ cycleCount }) => cycleCount))].join(",")}`,
    );
  });

  it("records dead-holder takeover and the live-holder negative with two processes", async () => {
    const holder = spawnLeaseProcess("d0-holder", "renew");
    let contender: ReturnType<typeof spawnLeaseProcess> | undefined;
    try {
      await waitForHolder("d0-holder", 5_000);
      contender = spawnLeaseProcess("d0-contender", "contend");
      await delay(3_200);
      const liveRow = await leaseRow();
      expect(liveRow.holder).toBe("d0-holder");
      expect(contender.output).not.toContain("holder=d0-contender acquired=true");
      console.info(
        `INT4C_D0_LEASE_LIVE holder=${liveRow.holder} contender=d0-contender ttl_windows=3 contender_acquired=false holder_pid=${holder.child.pid} contender_pid=${contender.child.pid}`,
      );

      holder.child.kill("SIGKILL");
      await waitForHolder("d0-contender", 5_000);
      const takeoverRow = await leaseRow();
      expect(takeoverRow.holder).toBe("d0-contender");
      expect(contender.output).toContain("holder=d0-contender acquired=true");
      console.info(
        `INT4C_D0_LEASE_TAKEOVER dead_holder=d0-holder new_holder=${takeoverRow.holder} fired=true identities_visible=d0-holder,d0-contender`,
      );
    } finally {
      await stopChild(holder.child);
      if (contender) await stopChild(contender.child);
    }
  }, 20_000);

  it("records missing backpressure with one live binding already present", async () => {
    const active = await taskFor("active", "running");
    const activeRunId = deriveIntendedRunId(
      active.workItemId,
      active.taskVersion,
      active.approval.approvedTaskHash!,
    );
    await putAgentTask(active, deps());
    await bindRunToWorkItem({
      workItemId: active.workItemId,
      harnessRunId: activeRunId,
    }, deps());

    const queued = await taskFor("queued", "approved");
    await putAgentTask(queued, deps());
    const alerts: Array<Record<string, unknown>> = [];
    const submitted: string[] = [];
    const result = await runSingleDispatch(dispatchDeps(alerts, submitted));
    const decisions = await pool.query<{ decision_type: string; record: unknown }>(
      "select decision_type, record from hermes_decision_records order by generated_at",
    );

    expect(result.outcome).toBe("dispatched");
    expect(submitted).toHaveLength(1);
    expect(JSON.stringify(decisions.rows)).not.toContain("backpressure");
    expect(JSON.stringify(alerts)).not.toContain("backpressure");
    console.info(
      `INT4C_D0_SILENCE backpressure active_bound=1 queued_attempt=${result.outcome} named_refusal=false operator_signal=false alerts=${alerts.length}`,
    );
  });
});

function deps() {
  return { query };
}

async function query<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  return (await pool.query(text, values)).rows as T[];
}

async function taskFor(
  suffix: string,
  lifecycle: "approved" | "dispatching" | "running",
): Promise<AgentTaskV1> {
  const withApproval = agentTaskV1Schema.parse({
    ...fixture,
    workItemId: `int4c-d0-${suffix}`,
    correlationId: `int4c-d0-${suffix}`,
    lifecycle: "approved",
    deadline: DEADLINE,
    requestedAuthority: {
      ...fixture.requestedAuthority,
      grants: CAPABILITIES.map((capability) => ({
        capabilityId: capability.id,
        resource: fixture.repository.nameWithOwner,
        constraints: {},
      })),
    },
    approval: {
      ...fixture.approval,
      status: "approved",
      actor: { type: "operator", id: "int4c-d0-operator" },
      decidedAt: OLD,
      approvedTaskHash: PLACEHOLDER_HASH,
    },
    timestamps: {
      ...fixture.timestamps,
      approvedAt: OLD,
      updatedAt: OLD,
    },
  });
  const artifact = await buildTaskIntentArtifact(withApproval, {
    workspacePath: workspacePathForTask(withApproval.workItemId, 1),
  });
  const withTemplate = agentTaskV1Schema.parse({
    ...withApproval,
    intent: {
      ...withApproval.intent,
      templateHash: artifact.templateHash,
      templateRef: {
        ...withApproval.intent.templateRef,
        uri: `artifact://sha256/${artifact.templateHash.slice("sha256:".length)}`,
        sha256: artifact.templateHash,
      },
    },
  });
  const approvedTaskHash = await hashAgentTaskApprovalPayload(withTemplate);
  const approved = agentTaskV1Schema.parse({
    ...withTemplate,
    approval: { ...withTemplate.approval, approvedTaskHash },
  });
  if (lifecycle === "approved") return approved;
  const runId = deriveIntendedRunId(
    approved.workItemId,
    approved.taskVersion,
    approvedTaskHash,
  );
  return agentTaskV1Schema.parse({
    ...approved,
    lifecycle,
    timestamps: {
      ...approved.timestamps,
      dispatchClaimedAt: OLD,
      ...(lifecycle === "running" ? { runBoundAt: OLD } : {}),
      updatedAt: OLD,
    },
    ...(lifecycle === "running" ? { bindings: { harnessRunId: runId } } : {}),
  });
}

function dispatchDeps(
  alerts: Array<Record<string, unknown>>,
  submitted: string[],
): DispatchDeps {
  return {
    now: () => NOW,
    dispatcherId: "d0-backpressure",
    leaseTtlSeconds: 30,
    isDispatchEnabled: () => true,
    isHalted: () => false,
    listDispatchable: () => listDispatchableAgentTasks(deps()),
    saveTask: (task) => putAgentTask(task, deps()),
    acquireLease: (input) => acquireDispatchLease(input, deps()),
    renewLease: (input) => renewDispatchLease(input, deps()),
    releaseLease: (holder) => releaseDispatchLease(holder, deps()),
    claimDispatch: (input) => claimDispatch(input, deps()),
    getRunBinding: (workItemId) => getRunBinding(workItemId, deps()),
    bindRun: (input) => bindRunToWorkItem(input, deps()),
    loadProfileManifest: async (profileId) => ({
      profileId,
      strategies: ["direct_execution"],
      capabilities: CAPABILITIES,
    }),
    prepareWorkspace: async (task) =>
      workspacePathForTask(task.workItemId, task.taskVersion),
    writeIntentArtifact: async (_bytes, workItemId) => `/tmp/${workItemId}.json`,
    controlPort: {
      submit: async (runId) => {
        submitted.push(runId);
        return runId;
      },
      cancel: async () => undefined,
    },
    recordDecision: async (record) => {
      await pool.query(
        `insert into hermes_decision_records (
           decision_id, correlation_id, work_item_id, decision_type, generated_at, record
         ) values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          record.decisionId,
          record.correlationId,
          record.workItemId ?? null,
          record.decisionType,
          record.generatedAt,
          JSON.stringify(record),
        ],
      );
    },
    alertSink: async (alert) => {
      alerts.push(alert);
    },
    logger: { warn: vi.fn() },
  };
}

function processConfig(dispatcherId: string) {
  return {
    dispatcherId,
    pollIntervalMs: 5_000,
    leaseTtlSeconds: 30,
    readTimeoutMs: 1_000,
    poisonThreshold: 5,
    intentDir: "/tmp/int4c-d0-intents",
    heartbeatPath: "/tmp/int4c-d0-heartbeat.json",
    harnessBin: "harness",
  };
}

function unexpectedScheduler() {
  return {
    setTimeout: () => {
      throw new Error("INT4C_D0 unexpected timer");
    },
    clearTimeout: vi.fn(),
  };
}

function spawnLeaseProcess(holder: string, mode: "renew" | "contend") {
  const child = spawn(
    process.execPath,
    [
      "test/fixtures/agent-integration/int4c-d0-lease-process.mjs",
      holder,
      mode,
      "1",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const record = { child, output: "" };
  child.stdout.on("data", (chunk) => {
    record.output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    record.output += String(chunk);
  });
  return record;
}

async function waitForHolder(holder: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await leaseRow().catch(() => undefined);
    if (row?.holder === holder) return;
    await delay(50);
  }
  throw new Error(`INT4C_D0 lease holder ${holder} was not observed`);
}

async function leaseRow(): Promise<{ holder: string; expires_at: Date }> {
  const result = await pool.query<{ holder: string; expires_at: Date }>(
    "select holder, expires_at from dispatch_lease where lease_id = 'global'",
  );
  const row = result.rows[0];
  if (!row) throw new Error("INT4C_D0 global lease row missing");
  return row;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(1_000).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}
