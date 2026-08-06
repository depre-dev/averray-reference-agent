import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
} from "vitest";

import {
  getAgentTask,
  putAgentTask,
} from "../../packages/averray-mcp/src/agent-task-store.js";
import {
  deriveIntendedRunId,
  getDispatchClaim,
} from "../../packages/averray-mcp/src/dispatch-claim.js";
import {
  listHermesDecisions,
} from "../../packages/averray-mcp/src/decision-record-store.js";
import {
  bindRunToWorkItem,
  getRunBinding,
} from "../../packages/averray-mcp/src/run-binding-outbox.js";
import { buildTaskIntentArtifact } from "../../packages/averray-mcp/src/task-intent-mapping.js";
import { workspacePathForTask } from "../../packages/averray-mcp/src/workspace-path.js";

const REFERENCE_URL = process.env.INT4C_REFERENCE_DATABASE_URL?.trim();
const HARNESS_URL = process.env.INT4C_HARNESS_DATABASE_URL?.trim();
const RUN = REFERENCE_URL && HARNESS_URL ? describe : describe.skip;
const MUTATION = process.env.INT4C_MUTATION?.trim();
const PRINT_EVIDENCE = process.env.INT4C_PRINT_EVIDENCE === "1";
const CLAIM_TTL_MS = 250;
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

let referencePool: Pool;
let harnessPool: Pool;
let fixture: AgentTaskV1;
let scratchRoot = "";

RUN("INT-4c lease takeover and backpressure drills", () => {
  beforeAll(async () => {
    referencePool = new Pool({ connectionString: REFERENCE_URL });
    harnessPool = new Pool({ connectionString: HARNESS_URL });
    fixture = agentTaskV1Schema.parse(JSON.parse(await readFile(
      new URL("../fixtures/agent-integration/agent-task-v1.json", import.meta.url),
      "utf8",
    )));
    scratchRoot = await mkdtemp(path.join(tmpdir(), "int4c-drill-"));
    for (const migration of [
      "001_init.sql",
      "002_agent_tasks.sql",
      "003_dispatch_claims_outbox_decisions.sql",
      "004_dispatch_quarantines.sql",
      "005_dispatch_claim_expiry_backpressure.sql",
    ]) {
      await referencePool.query(await readFile(
        new URL(`../../ops/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    await harnessPool.query(`
      create table if not exists runs (
        run_id text primary key,
        task_id text not null,
        correlation_id text not null,
        state text not null,
        task jsonb not null,
        manifest jsonb,
        outcome text,
        outcome_reason text,
        attempt integer not null default 1 check (attempt >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null
      )
    `);
  });

  beforeEach(async () => {
    await referencePool.query(`
      truncate table
        harness_dispatch_backpressure,
        hermes_decision_records,
        agent_task_dispatch_quarantines,
        agent_task_run_outbox,
        agent_task_dispatch_claims,
        agent_tasks,
        dispatch_lease
    `);
    await harnessPool.query("truncate table runs");
    await rm(scratchRoot, { recursive: true, force: true });
    await mkdir(scratchRoot, { recursive: true });
  });

  afterAll(async () => {
    await Promise.all([referencePool?.end(), harnessPool?.end()]);
    if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
  });

  it("takes over after-claim-before-submit with one derived Harness run", async () => {
    const task = await seedApprovedTask("before-submit");
    const derivedRunId = runIdFor(task);
    const holder = spawnDispatcher("before-holder", "after-claim-before-submit");
    const holderExit = await waitForExit(holder.child, 8_000);
    expect(holderExit.code, holder.output).toBe(86);
    await expectFaultStamp("before-holder", "after-claim-before-submit");
    expect(await harnessRunCount()).toBe(0);
    await waitForClaimExpiry(task);

    const contender = spawnDispatcher("before-contender");
    const contenderExit = await waitForExit(contender.child, 8_000);
    if (PRINT_EVIDENCE) console.info(contender.output.trim());
    expect(contenderExit.code, contender.output).toBe(0);
    const runs = await harnessRuns();
    expect(runs, "INT4C_BEFORE_SUBMIT_RUN_COUNT").toHaveLength(1);
    expect(runs[0]?.run_id, "INT4C_BEFORE_SUBMIT_CORRELATION_BREAK").toBe(
      derivedRunId,
    );
    expect(runs[0]?.attempt).toBe(1);
    await expectBindingAndClaim(task, derivedRunId, "before-contender", 2);
    await expectNormalHeartbeat("before-contender");
    print(
      `INT4C_DRILL_GREEN before-submit takeover=true runs=1 attempt=1 run_id_equals_derivation=true binding=1 claim_generation=2 holder=before-contender fault_stamp=present normal_stamp=absent`,
    );
  }, 20_000);

  it("takes over after-submit-before-binding by adopting one existing run", async () => {
    const task = await seedApprovedTask("after-submit");
    const derivedRunId = runIdFor(task);
    const holder = spawnDispatcher("after-holder", "after-submit-before-binding");
    const holderExit = await waitForExit(holder.child, 8_000);
    expect(holderExit.code, holder.output).toBe(86);
    await expectFaultStamp("after-holder", "after-submit-before-binding");
    expect(await harnessRuns()).toEqual([
      expect.objectContaining({ run_id: derivedRunId, attempt: 1 }),
    ]);
    await waitForClaimExpiry(task);

    const contender = spawnDispatcher("after-contender");
    const contenderExit = await waitForExit(contender.child, 8_000);
    if (PRINT_EVIDENCE) console.info(contender.output.trim());
    expect(contenderExit.code, contender.output).toBe(0);
    const runs = await harnessRuns();
    expect(runs, "INT4C_AFTER_SUBMIT_DUPLICATE_RUN_COUNT").toHaveLength(1);
    expect(runs[0]).toMatchObject({ run_id: derivedRunId, attempt: 1 });
    await expectBindingAndClaim(task, derivedRunId, "after-contender", 2);
    print(
      "INT4C_DRILL_GREEN after-submit takeover=true adopted_existing=true resubmitted_second_run=false runs=1 attempt=1 binding=1 binding_holder=after-contender claim_generation=2",
    );
  }, 20_000);

  it("does not take over while a healthy holder renews across three TTL windows", async () => {
    const holder = spawnLease("live-holder", "holder");
    let contender: ReturnType<typeof spawnLease> | undefined;
    try {
      await waitForLeaseHolder("live-holder", 5_000);
      contender = spawnLease("live-contender", "contender");
      await delay(3_200);
      const row = await leaseRow();
      expect(row.holder, "INT4C_LIVE_HOLDER_WAS_STOLEN").toBe("live-holder");
      expect(contender.output).not.toContain("holder=live-contender acquired=true");
      print(
        `INT4C_DRILL_GREEN no-takeover-while-alive holder=live-holder contender=live-contender ttl_windows=3 contender_acquired=false holder_pid=${holder.child.pid} contender_pid=${contender.child.pid}`,
      );
    } finally {
      await stopChild(holder.child);
      if (contender) await stopChild(contender.child);
    }
  }, 12_000);

  it("keeps the same-process restart-resume path exactly once", async () => {
    const task = await seedApprovedTask("restart-resume");
    const derivedRunId = runIdFor(task);
    const crashed = spawnDispatcher("restart-holder", "after-submit-before-binding");
    expect((await waitForExit(crashed.child, 8_000)).code, crashed.output).toBe(86);
    await waitForClaimExpiry(task);
    const restarted = spawnDispatcher("restart-holder");
    const restartedExit = await waitForExit(restarted.child, 8_000);
    if (PRINT_EVIDENCE) console.info(restarted.output.trim());
    expect(restartedExit.code, restarted.output).toBe(0);
    expect(await harnessRuns()).toEqual([
      expect.objectContaining({ run_id: derivedRunId, attempt: 1 }),
    ]);
    await expectBindingAndClaim(task, derivedRunId, "restart-holder", 2);
    print(
      "INT4C_DRILL_GREEN restart-resume runs=1 attempt=1 binding=1 same_derived_id=true",
    );
  }, 20_000);

  it("blocks after the one takeover retry and records no third submit", async () => {
    const task = await seedApprovedTask("retry-exhaustion");
    const first = spawnDispatcher("retry-holder-one", "after-claim-before-submit");
    expect((await waitForExit(first.child, 8_000)).code, first.output).toBe(86);
    await waitForClaimExpiry(task);
    const second = spawnDispatcher("retry-holder-two", "after-claim-before-submit");
    const secondExit = await waitForExit(second.child, 8_000);
    if (PRINT_EVIDENCE) console.info(second.output.trim());
    expect(secondExit.code, second.output).toBe(86);
    await waitForClaimExpiry(task);
    const third = spawnDispatcher("retry-holder-three", undefined, MUTATION);
    await waitForExit(third.child, 8_000);

    const stored = await getAgentTask(task.workItemId, 1, refDeps());
    const claim = await getDispatchClaim(task.workItemId, 1, refDeps());
    const alerts = await alertRecords();
    expect(await harnessRunCount(), "INT4C_RETRY_BOUND_REMOVED_THIRD_SUBMIT").toBe(0);
    expect(stored?.lifecycle).toBe("blocked");
    expect(claim).toMatchObject({
      claimGeneration: 2,
      claimState: "exhausted",
    });
    expect(alerts).toContainEqual(expect.objectContaining({
      severity: "critical",
      code: "dispatch_retry_exhausted",
      message: expect.stringContaining("generation 2"),
    }));
    print(
      "INT4C_DRILL_GREEN bounded-retry lifecycle=blocked claim_generation=2 critical_alert=1 third_submit_attempts=0 harness_runs=0",
    );
  }, 25_000);

  it("refuses at the introduced in-flight bound once, exposes status, then clears", async () => {
    const active = await seedRunningTask("backpressure-active");
    const queued = await seedApprovedTask("backpressure-queued");
    const first = spawnDispatcher("backpressure-one", undefined, MUTATION);
    expect((await waitForExit(first.child, 8_000)).code).toBe(0);
    const second = spawnDispatcher("backpressure-two", undefined, MUTATION);
    expect((await waitForExit(second.child, 8_000)).code).toBe(0);

    const decisions = await listHermesDecisions({
      workItemId: queued.workItemId,
      limit: 20,
    }, refDeps());
    const backpressureDecisions = decisions.filter((record) =>
      record.proposal.why.includes("backpressure"));
    const warnings = (await alertRecords()).filter((record) =>
      record.code === "dispatch_backpressure");
    expect(warnings, "INT4C_BACKPRESSURE_ALERT_DEDUP").toHaveLength(1);
    expect(backpressureDecisions, "INT4C_BACKPRESSURE_DECISION_DEDUP").toHaveLength(1);

    const status = runPilotStatus(queued.workItemId);
    expect(status.dispatcherBackpressure).toMatchObject({
      observed: true,
      active: true,
      observedInflight: 1,
      maxInflight: 1,
    });
    print(`INT4C_BACKPRESSURE_STATUS ${JSON.stringify(status.dispatcherBackpressure)}`);
    expect(JSON.stringify(status.recentDecisions)).toContain("backpressure");

    await putAgentTask(agentTaskV1Schema.parse({
      ...active,
      lifecycle: "failed",
      timestamps: {
        ...active.timestamps,
        terminalAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    }), refDeps());
    const cleared = spawnDispatcher("backpressure-clear");
    expect((await waitForExit(cleared.child, 8_000)).code).toBe(0);
    await expect(getAgentTask(queued.workItemId, 1, refDeps())).resolves.toMatchObject({
      lifecycle: "running",
    });
    const clearedStatus = runPilotStatus(queued.workItemId);
    expect(clearedStatus.dispatcherBackpressure).toMatchObject({
      observed: true,
      active: false,
    });
    expect((await alertRecords()).filter((record) =>
      record.code === "dispatch_backpressure")).toHaveLength(1);
    print(
      "INT4C_DRILL_GREEN backpressure introduced_bound=1 refusal_visible=true status_reason=backpressure warn_alerts=1 repeated_cycles=2 cleared=true queued_dispatched=true",
    );
  }, 20_000);
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

async function seedApprovedTask(suffix: string): Promise<AgentTaskV1> {
  const workItemId = `int4c-${suffix}`;
  const approved = agentTaskV1Schema.parse({
    ...fixture,
    workItemId,
    correlationId: workItemId,
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
      actor: { type: "operator", id: "int4c-operator" },
      decidedAt: OLD,
      approvedTaskHash: PLACEHOLDER_HASH,
    },
    timestamps: {
      ...fixture.timestamps,
      approvedAt: OLD,
      updatedAt: OLD,
    },
  });
  const artifact = await buildTaskIntentArtifact(approved, {
    workspacePath: workspacePathForTask(workItemId, 1),
  });
  const withTemplate = agentTaskV1Schema.parse({
    ...approved,
    intent: {
      ...approved.intent,
      templateHash: artifact.templateHash,
      templateRef: {
        ...approved.intent.templateRef,
        uri: `artifact://sha256/${artifact.templateHash.slice("sha256:".length)}`,
        sha256: artifact.templateHash,
      },
    },
  });
  const approvedTaskHash = await hashAgentTaskApprovalPayload(withTemplate);
  const task = agentTaskV1Schema.parse({
    ...withTemplate,
    approval: { ...withTemplate.approval, approvedTaskHash },
  });
  await putAgentTask(task, refDeps());
  return task;
}

async function seedRunningTask(suffix: string): Promise<AgentTaskV1> {
  const approved = await seedApprovedTask(suffix);
  const runId = runIdFor(approved);
  const running = agentTaskV1Schema.parse({
    ...approved,
    lifecycle: "running",
    timestamps: {
      ...approved.timestamps,
      dispatchClaimedAt: OLD,
      runBoundAt: OLD,
      updatedAt: OLD,
    },
    bindings: { harnessRunId: runId },
  });
  await putAgentTask(running, refDeps());
  await bindRunToWorkItem({
    workItemId: running.workItemId,
    harnessRunId: runId,
  }, refDeps());
  await harnessPool.query(
    `insert into runs (
       run_id, task_id, correlation_id, state, task, manifest,
       outcome, outcome_reason, attempt, created_at, updated_at
     ) values ($1, $2, $2, 'executing', '{}'::jsonb, null,
       null, null, 1, now(), now())`,
    [runId, `task-${runId}`],
  );
  return running;
}

function runIdFor(task: AgentTaskV1): string {
  return deriveIntendedRunId(
    task.workItemId,
    task.taskVersion,
    task.approval.approvedTaskHash!,
  );
}

function spawnDispatcher(
  dispatcherId: string,
  crashPoint?: "after-claim-before-submit" | "after-submit-before-binding",
  mutation?: string,
) {
  const heartbeatPath = path.join(scratchRoot, `${dispatcherId}-heartbeat.json`);
  const child = spawn(process.execPath, [
    "test/fixtures/agent-integration/int4c-dispatch-process.mjs",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: REFERENCE_URL,
      INT4C_HARNESS_DATABASE_URL: HARNESS_URL,
      INT4C_DISPATCHER_ID: dispatcherId,
      HARNESS_DISPATCH_CLAIM_TTL_MS: String(CLAIM_TTL_MS),
      HARNESS_DISPATCH_MAX_INFLIGHT: "1",
      HARNESS_DISPATCH_ALERTS_PATH: alertsPath(),
      HARNESS_DISPATCH_HEARTBEAT_PATH: heartbeatPath,
      ...(crashPoint
        ? {
            HARNESS_DISPATCH_FAULT_INJECTION: "enabled",
            HARNESS_DISPATCH_CRASH_POINT: crashPoint,
          }
        : {}),
      ...(mutation ? { INT4C_MUTATION: mutation } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { child, output: "", heartbeatPath };
  child.stdout.on("data", (chunk) => {
    record.output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    record.output += String(chunk);
  });
  return record;
}

function spawnLease(holder: string, mode: "holder" | "contender") {
  const child = spawn(process.execPath, [
    "test/fixtures/agent-integration/int4c-lease-process.mjs",
    holder,
    mode,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: REFERENCE_URL,
      ...(MUTATION ? { INT4C_MUTATION: MUTATION } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { child, output: "" };
  child.stdout.on("data", (chunk) => {
    record.output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    record.output += String(chunk);
  });
  return record;
}

async function expectFaultStamp(
  dispatcherId: string,
  crashPoint: string,
): Promise<void> {
  const heartbeat = JSON.parse(await readFile(
    path.join(scratchRoot, `${dispatcherId}-heartbeat.json`),
    "utf8",
  )) as Record<string, unknown>;
  expect(heartbeat).toMatchObject({
    dispatcherId,
    faultInjection: { enabled: true, crashPoint },
  });
  print(
    `INT4C_FAULT_HEARTBEAT dispatcher=${dispatcherId} fault_injection=enabled crash_point=${crashPoint}`,
  );
}

async function expectNormalHeartbeat(dispatcherId: string): Promise<void> {
  const heartbeat = JSON.parse(await readFile(
    path.join(scratchRoot, `${dispatcherId}-heartbeat.json`),
    "utf8",
  )) as Record<string, unknown>;
  expect(heartbeat).not.toHaveProperty("faultInjection");
  print(`INT4C_NORMAL_HEARTBEAT dispatcher=${dispatcherId} fault_injection=absent`);
}

async function expectBindingAndClaim(
  task: AgentTaskV1,
  runId: string,
  holder: string,
  generation: number,
): Promise<void> {
  await expect(getRunBinding(task.workItemId, refDeps())).resolves.toMatchObject({
    harnessRunId: runId,
  });
  await expect(getDispatchClaim(task.workItemId, 1, refDeps())).resolves.toMatchObject({
    claimState: "bound",
    claimHolder: holder,
    claimGeneration: generation,
  });
  await expect(getAgentTask(task.workItemId, 1, refDeps())).resolves.toMatchObject({
    lifecycle: "running",
    bindings: { harnessRunId: runId },
  });
}

async function harnessRuns(): Promise<Array<{ run_id: string; attempt: number }>> {
  return (await harnessPool.query<{ run_id: string; attempt: number }>(
    "select run_id, attempt from runs order by created_at, run_id",
  )).rows;
}

async function harnessRunCount(): Promise<number> {
  const row = (await harnessPool.query<{ count: number }>(
    "select count(*)::integer as count from runs",
  )).rows[0];
  return row?.count ?? -1;
}

async function alertRecords(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(alertsPath(), "utf8").catch(() => "");
  return raw.trim()
    ? raw.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

function alertsPath(): string {
  return path.join(scratchRoot, "alerts.jsonl");
}

function runPilotStatus(workItemId: string): Record<string, any> {
  const result = spawnSync(process.execPath, [
    "scripts/ops/harness-pilot.mjs",
    "status",
    "--work-item",
    workItemId,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: REFERENCE_URL,
      HARNESS_DISPATCH_ALERTS_PATH: alertsPath(),
      HARNESS_DISPATCH_HEARTBEAT_PATH: path.join(
        scratchRoot,
        "backpressure-two-heartbeat.json",
      ),
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, any>;
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs).then(() => {
      child.kill("SIGKILL");
      throw new Error(`INT4C child did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

async function waitForLeaseHolder(holder: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await leaseRow().catch(() => undefined);
    if (row?.holder === holder) return;
    await delay(50);
  }
  throw new Error(`INT4C lease holder ${holder} was not observed`);
}

async function waitForClaimExpiry(
  task: Pick<AgentTaskV1, "workItemId" | "taskVersion">,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await referencePool.query<{ expired: boolean }>(
      `select lease_expires_at < now() as expired
       from agent_task_dispatch_claims
       where work_item_id = $1 and task_version = $2`,
      [task.workItemId, task.taskVersion],
    )).rows[0];
    if (row?.expired) return;
    await delay(25);
  }
  throw new Error(`INT4C claim ${task.workItemId}@${task.taskVersion} did not expire`);
}

async function leaseRow(): Promise<{ holder: string }> {
  const row = (await referencePool.query<{ holder: string }>(
    "select holder from dispatch_lease where lease_id = 'global'",
  )).rows[0];
  if (!row) throw new Error("INT4C global lease row is absent");
  return row;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(1_000).then(() => child.kill("SIGKILL")),
  ]);
}

function print(line: string): void {
  if (PRINT_EVIDENCE) console.info(line);
}
