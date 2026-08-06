import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

import { runPilotCli } from "../../scripts/ops/harness-pilot.mjs";
import {
  getAgentTask,
  listAgentTasks,
  putAgentTask,
} from "../../packages/averray-mcp/src/agent-task-store.js";
import {
  getDispatchPolicyDrift,
  listDispatchPolicyDrifts,
  transitionDispatchPolicyDrift,
} from "../../packages/averray-mcp/src/dispatch-policy-drift.js";
import {
  getActiveDispatchQuarantine,
  listRunBindingAuditRows,
  markDispatchQuarantine,
} from "../../packages/averray-mcp/src/dispatch-quarantine.js";
import {
  deriveIntendedRunId,
} from "../../packages/averray-mcp/src/dispatch-claim.js";
import {
  listHermesDecisions,
  recordHermesDecision,
} from "../../packages/averray-mcp/src/decision-record-store.js";
import {
  createHarnessCliReadPort,
  HarnessReadError,
  type HarnessCommandExecutor,
  type HarnessRunReadSnapshot,
} from "../../packages/averray-mcp/src/harness-read-port.js";
import {
  bindRunToWorkItem,
  getRunBinding,
} from "../../packages/averray-mcp/src/run-binding-outbox.js";
import {
  buildTaskIntentArtifact,
} from "../../packages/averray-mcp/src/task-intent-mapping.js";
import {
  workspacePathForTask,
} from "../../packages/averray-mcp/src/workspace-path.js";
import {
  mergeAgentTaskBoardItems,
} from "../../services/slack-operator/src/agent-task-board.js";
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
import {
  createWatchdogProcess,
} from "../../services/harness-watchdog/src/watchdog.js";

const REFERENCE_URL = process.env.INT4D_REFERENCE_DATABASE_URL?.trim();
const HARNESS_URL = process.env.INT4D_HARNESS_DATABASE_URL?.trim();
const HARNESS_CHECKOUT = process.env.HARNESS_CHECKOUT?.trim();
const RUN = REFERENCE_URL && HARNESS_URL ? describe : describe.skip;
const MUTATION = process.env.INT4D_MUTATION?.trim();
const PRINT_EVIDENCE = process.env.INT4D_PRINT_EVIDENCE === "1";
const ALLOWED_MUTATIONS = new Set([
  "non-idempotent-projection",
  "duplicate-worker-effect",
  "board-replay-write",
  "skip-policy-recheck",
  "disable-size-gate",
]);
if (MUTATION && !ALLOWED_MUTATIONS.has(MUTATION)) {
  throw new Error(`INT4D_UNKNOWN_MUTATION name=${MUTATION}`);
}

const NOW = new Date("2026-08-06T12:00:00.000Z");
const OLD = "2026-08-06T11:00:00.000Z";
const DEADLINE = "2027-08-06T12:00:00.000Z";
const MANIFEST_HASH = `sha256:${"d".repeat(64)}`;
const MANIFEST_REF = {
  uri: `artifact://sha256/${"d".repeat(64)}`,
  sha256: MANIFEST_HASH,
  mediaType: "application/json",
} as const;
const ACTIVE_DRIFT_HASH = `sha256:${"e".repeat(64)}`;
const SENTINEL = "token=INT4D_SECRET_SENTINEL_0123456789";
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

RUN("INT-4d full drill matrix", () => {
  beforeAll(async () => {
    referencePool = new Pool({ connectionString: REFERENCE_URL });
    harnessPool = new Pool({ connectionString: HARNESS_URL });
    fixture = agentTaskV1Schema.parse(JSON.parse(await readFile(
      new URL("../fixtures/agent-integration/agent-task-v1.json", import.meta.url),
      "utf8",
    )));
    scratchRoot = await mkdtemp(path.join(tmpdir(), "int4d-drill-"));
    for (const migration of [
      "001_init.sql",
      "002_agent_tasks.sql",
      "003_dispatch_claims_outbox_decisions.sql",
      "004_dispatch_quarantines.sql",
      "005_dispatch_claim_expiry_backpressure.sql",
      "006_dispatch_policy_drift.sql",
    ]) {
      await referencePool.query(await readFile(
        new URL(`../../ops/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
  });

  beforeEach(async () => {
    await referencePool.query(`
      truncate table
        harness_dispatch_policy_drift,
        harness_dispatch_backpressure,
        hermes_decision_records,
        agent_task_dispatch_quarantines,
        agent_task_run_outbox,
        agent_task_dispatch_claims,
        agent_tasks,
        dispatch_lease
    `);
    await rm(scratchRoot, { recursive: true, force: true });
    await mkdir(scratchRoot, { recursive: true });
  });

  afterAll(async () => {
    await Promise.all([referencePool?.end(), harnessPool?.end()]);
    if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
  });

  it("records the pre-seam policy silence with a live reconciliation loop", async () => {
    const task = await seedApprovedTask("policy-d0-silence");
    const heartbeats: DispatcherHeartbeat[] = [];
    const process = createDispatcherProcess({
      dispatcherId: "int4d-policy-d0",
      pollIntervalMs: 5_000,
      leaseTtlSeconds: 30,
      claimTtlMs: 600_000,
      maxInflight: 1,
      readTimeoutMs: 1_000,
      poisonThreshold: 3,
      intentDir: path.join(scratchRoot, "d0-intents"),
      heartbeatPath: path.join(scratchRoot, "d0-heartbeat.json"),
      harnessBin: "harness",
    }, {
      runReconcile: async () => [],
      // This is the exact pre-amendment shape: the loop is live, but neither
      // callback has an active-policy input to compare with the recorded hash.
      runAttempt: async () => ({ outcome: "idle" }),
      isDispatchEnabled: () => true,
      isHalted: () => false,
      releaseLease: async () => true,
      writeHeartbeat: async (heartbeat) => { heartbeats.push(heartbeat); },
      now: () => NOW,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      scheduler: {
        setTimeout: () => { throw new Error("INT4D_D0 unexpected timer"); },
        clearTimeout: vi.fn(),
      },
    });
    await process.tick();
    await process.tick();
    await process.tick();
    const decisionCount = Number((await referencePool.query<{ count: number }>(
      "select count(*)::int as count from hermes_decision_records where work_item_id = $1",
      [task.workItemId],
    )).rows[0]?.count ?? -1);
    expect(heartbeats.at(-1)).toMatchObject({ cycleCount: 3, status: "idle" });
    expect(decisionCount).toBe(0);
    expect(await getAgentTask(task.workItemId, 1, refDeps())).toMatchObject({
      lifecycle: "approved",
      approval: { policyHash: task.approval.policyHash },
    });
    print(`INT4D_D0_POLICY_SILENCE recorded_hash=${task.approval.policyHash} active_hash=${ACTIVE_DRIFT_HASH} heartbeat_cycle=3 loop_status=idle decisions=0 alerts=0 observation=nothing_read_active_policy`);
  });

  it("replays duplicate and out-of-order events without duplicate control effects", async () => {
    const started = Date.now();
    const task = await seedRunningTask("duplicate-events");
    const read = terminalRead(task.bindings!.harnessRunId!);
    const alerts: Array<Record<string, unknown>> = [];
    const fixedCandidate = MUTATION === "non-idempotent-projection" ? task : undefined;
    if (fixedCandidate) print("INT4D_MUTATION_APPLIED=non-idempotent-projection");
    const deps = reconcileDeps(task, read, alerts, {
      ...(fixedCandidate
        ? { listTasks: async () => [fixedCandidate] }
        : {}),
    });

    await reconcileDispatchedRuns(deps);
    await reconcileDispatchedRuns(deps);

    const stored = await getAgentTask(task.workItemId, task.taskVersion, refDeps());
    const bindingCount = Number((await referencePool.query<{ count: number }>(
      "select count(*)::int as count from agent_task_run_outbox where work_item_id = $1",
      [task.workItemId],
    )).rows[0]?.count ?? -1);
    const decisions = await listHermesDecisions({ workItemId: task.workItemId }, refDeps());
    const handoffs = decisions.filter((record) => record.decisionType === "handoff");
    expect(handoffs, "INT4D_DUPLICATE_DECISION_COUNT").toHaveLength(1);
    expect(bindingCount).toBe(1);
    expect(stored?.lifecycle).toBe("handoff_ready");
    expect(alerts).toHaveLength(0);
    print(`INT4D_DRILL_GREEN duplicate-event lifecycle=handoff_ready bindings=1 handoff_decisions=1 alerts=0 duplicate_events=2 out_of_order=true detection_ms=${Date.now() - started}`);
  });

  it("kills and restarts the pinned Harness worker without duplicating a protected effect", async () => {
    if (!HARNESS_CHECKOUT) throw new Error("INT4D_HARNESS_CHECKOUT_REQUIRED");
    const started = Date.now();
    const result = spawnSync(
      "uv",
      [
        "run",
        "pytest",
        "-q",
        "-s",
        "tests/acceptance/test_durability.py::test_seeded_chaos_kills_preserve_exactly_once_invariants",
      ],
      {
        cwd: HARNESS_CHECKOUT,
        env: {
          ...process.env,
          HARNESS_TEST_DATABASE_URL: HARNESS_URL,
          HARNESS_ACCEPTANCE_CHAOS_CYCLES: "1",
          HARNESS_ACCEPTANCE_CHAOS_SEED: "9009",
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const run = (await harnessPool.query<{ run_id: string; state: string }>(
      "select run_id, state from runs order by created_at desc limit 1",
    )).rows[0];
    expect(run).toBeDefined();
    if (MUTATION === "duplicate-worker-effect") {
      print("INT4D_MUTATION_APPLIED=duplicate-worker-effect");
      await harnessPool.query(
        `insert into domain_events (
           event_id, event_schema_version, event_type, run_id, attempt_id,
           parent_event_id, causation_id, correlation_id, ts, actor_kind,
           actor_id, payload, payload_ref, content_hash
         ) select
           event_id || '-int4d-reexecuted', event_schema_version, event_type,
           run_id, attempt_id, parent_event_id, causation_id, correlation_id,
           ts + interval '1 millisecond', actor_kind, actor_id, payload,
           payload_ref, content_hash
         from domain_events
         where run_id = $1 and event_type = 'CapabilityCompleted'
         order by seq limit 1`,
        [run!.run_id],
      );
    }
    const effects = (await harnessPool.query<{
      invocation_id: string;
      count: number;
    }>(
      `select payload->>'invocation_id' as invocation_id, count(*)::int as count
       from domain_events
       where run_id = $1 and event_type = 'CapabilityCompleted'
       group by payload->>'invocation_id'
       order by invocation_id`,
      [run!.run_id],
    )).rows;
    expect(effects.length).toBeGreaterThan(0);
    expect(effects.filter(({ count }) => count !== 1), "INT4D_PROTECTED_EFFECT_DUPLICATED")
      .toEqual([]);
    const watchdogRoot = path.join(scratchRoot, "worker-watchdog");
    await mkdir(watchdogRoot, { recursive: true });
    const watchdog = createWatchdogProcess({
      pollIntervalMs: 1_000,
      dispatcherStaleMs: 90_000,
      harnessSourceStaleMs: 1,
      databaseTimeoutMs: 1_000,
      orphanAgeMs: 60_000,
      alertsPath: path.join(watchdogRoot, "alerts.jsonl"),
      heartbeatPath: path.join(watchdogRoot, "heartbeat.json"),
      statusPath: path.join(watchdogRoot, "status.json"),
      dispatcherHeartbeatPath: path.join(watchdogRoot, "dispatcher.json"),
    }, {
      probeReferenceDatabase: async () => undefined,
      probeHarnessDatabase: async () => ({
        liveRun: true,
        newestEventAt: new Date(NOW.getTime() - 10_000),
      }),
      readReferenceBindings: async () => [],
      readHarnessRuns: async () => [],
      forwarders: [],
      now: () => NOW,
      logger: { info: vi.fn(), warn: vi.fn() },
      scheduler: { setTimeout: vi.fn(), clearTimeout: vi.fn() },
    });
    const watchdogStatus = await watchdog.tick();
    expect(watchdogStatus.activeIssues).toContain("watchdog_harness_source_stale");
    print(`INT4D_DRILL_GREEN worker-kill run_id=${run!.run_id} terminal_state=${run!.state} capability_completion_rows=${effects.length} duplicate_invocations=0 watchdog_gap_alert=true detection_ms=${Date.now() - started}`);
  }, 150_000);

  it("keeps execution durable through board outage and replays with zero writes", async () => {
    const started = Date.now();
    const task = await seedRunningTask("board-outage");
    const alerts: Array<Record<string, unknown>> = [];
    await reconcileDispatchedRuns(reconcileDeps(
      task,
      terminalRead(task.bindings!.harnessRunId!),
      alerts,
    ));
    const before = await controlStoreFingerprint();
    const tasks = await listAgentTasks({ workItemId: task.workItemId }, refDeps());
    const board = mergeAgentTaskBoardItems([], tasks);
    if (MUTATION === "board-replay-write") {
      print("INT4D_MUTATION_APPLIED=board-replay-write");
      await putAgentTask(tasks[0]!, refDeps());
    }
    const after = await controlStoreFingerprint();
    expect(after, "INT4D_BOARD_READ_PATH_WROTE_CONTROL_STATE").toBe(before);
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({
      workItemId: task.workItemId,
      status: "completed",
      agentTaskLifecycle: "handoff_ready",
    });
    print(`INT4D_DRILL_GREEN board-outage execution_continued=true replay_cards=1 control_writes=0 lifecycle=handoff_ready detection_ms=${Date.now() - started}`);
  });

  it("refuses pre-submit policy drift and flags a bound run without cancelling", async () => {
    const started = Date.now();
    const approved = await seedApprovedTask("policy-before-submit");
    const activePolicy = MUTATION === "skip-policy-recheck"
      ? {
          version: approved.approval.policyVersion,
          hash: approved.approval.policyHash,
        }
      : { version: "dispatch-policy-v2", hash: ACTIVE_DRIFT_HASH };
    if (MUTATION === "skip-policy-recheck") {
      print("INT4D_MUTATION_APPLIED=skip-policy-recheck");
    }
    const alerts: Array<Record<string, unknown>> = [];
    const submitted: string[] = [];
    const attempt = await runSingleDispatch(dispatchDeps(
      approved,
      activePolicy,
      alerts,
      submitted,
    ));
    expect(attempt).toMatchObject({ outcome: "refused", reason: "policy_drift" });
    expect(submitted).toHaveLength(0);
    expect(JSON.stringify(alerts)).toContain(approved.approval.policyHash);
    expect(JSON.stringify(alerts)).toContain(ACTIVE_DRIFT_HASH);

    const bound = await seedRunningTask("policy-bound");
    const boundAlerts: Array<Record<string, unknown>> = [];
    const cancels: string[] = [];
    const deps = reconcileDeps(
      bound,
      activeRead(bound.bindings!.harnessRunId!),
      boundAlerts,
      {
        activePolicyIdentity: { version: "dispatch-policy-v2", hash: ACTIVE_DRIFT_HASH },
        controlPort: { cancel: async (runId) => { cancels.push(runId); } },
      },
    );
    await reconcileDispatchedRuns(deps);
    await reconcileDispatchedRuns(deps);
    expect(cancels).toHaveLength(0);
    expect(await getAgentTask(bound.workItemId, 1, refDeps())).toMatchObject({
      lifecycle: "running",
    });
    expect(boundAlerts.filter(({ code }) => code === "policy_drift")).toHaveLength(1);
    expect(await getDispatchPolicyDrift(bound.workItemId, 1, refDeps())).toMatchObject({
      active: true,
      approvedPolicy: { hash: bound.approval.policyHash },
      activePolicy: { hash: ACTIVE_DRIFT_HASH },
    });
    const statusOutput: string[] = [];
    const statusExit = await runPilotCli(["status", "--work-item", bound.workItemId], {
      environment: { DATABASE_URL: REFERENCE_URL! },
      services: pilotStatusServices(),
      output: (line: string) => statusOutput.push(line),
    });
    expect(statusExit).toBe(0);
    const status = JSON.parse(statusOutput.join("")) as {
      tasks: Array<{ policyDrift: { active: boolean } }>;
    };
    expect(status.tasks[0]?.policyDrift.active).toBe(true);
    print(`INT4D_DRILL_GREEN policy-drift pre_submit=refused approved_hash=${approved.approval.policyHash} active_hash=${ACTIVE_DRIFT_HASH} bound_lifecycle=running bound_cancelled=false warn_alerts=1 status_active=true detection_ms=${Date.now() - started}`);
  });

  it("quarantines oversized secret-shaped output without leaking to sinks", async () => {
    const started = Date.now();
    const task = await seedRunningTask("oversized-event");
    const adapterSink: string[] = [];
    const oversized = `${statusText(task.bindings!.harnessRunId!)}outcome_reason=${SENTINEL}${"x".repeat(300_000)}\n`;
    const execute: HarnessCommandExecutor = async (_command, args, options) => {
      const stdout = args[1] === "status" ? oversized : "[]\n";
      if (Buffer.byteLength(stdout) > options.maxOutputBytes) {
        throw new HarnessReadError(
          "cli_output_too_large",
          "Harness read command exceeded the output limit",
          false,
        );
      }
      adapterSink.push(stdout);
      return { code: 0, stdout, stderr: "" };
    };
    const readPort = createHarnessCliReadPort({
      execute,
      maxOutputBytes: MUTATION === "disable-size-gate" ? 1_000_000 : 256 * 1024,
    });
    if (MUTATION === "disable-size-gate") {
      print("INT4D_MUTATION_APPLIED=disable-size-gate");
    }
    const alerts: Array<Record<string, unknown>> = [];
    const deps = reconcileDeps(task, activeRead(task.bindings!.harnessRunId!), alerts, {
      readPort,
      poisonThreshold: 3,
    });
    await reconcileDispatchedRuns(deps);
    await reconcileDispatchedRuns(deps);
    await reconcileDispatchedRuns(deps);
    expect(adapterSink.join(""), "INT4D_OVERSIZED_SENTINEL_REACHED_ADAPTER_SINK")
      .not.toContain(SENTINEL);
    expect(await getActiveDispatchQuarantine(task.workItemId, 1, refDeps()))
      .toMatchObject({ reason: "poison_read", cycleCount: 3 });
    const statusOutput: string[] = [];
    await runPilotCli(["status", "--work-item", task.workItemId], {
      environment: { DATABASE_URL: REFERENCE_URL! },
      services: pilotStatusServices(),
      output: (line: string) => statusOutput.push(line),
    });
    const watchdogRoot = path.join(scratchRoot, "malicious-watchdog");
    await mkdir(watchdogRoot, { recursive: true });
    const watchdog = createWatchdogProcess({
      pollIntervalMs: 1_000,
      dispatcherStaleMs: 90_000,
      harnessSourceStaleMs: 90_000,
      databaseTimeoutMs: 1_000,
      orphanAgeMs: 60_000,
      alertsPath: path.join(watchdogRoot, "alerts.jsonl"),
      heartbeatPath: path.join(watchdogRoot, "heartbeat.json"),
      statusPath: path.join(watchdogRoot, "status.json"),
      dispatcherHeartbeatPath: path.join(watchdogRoot, "dispatcher.json"),
    }, {
      probeReferenceDatabase: async () => undefined,
      probeHarnessDatabase: async () => ({ liveRun: false, newestEventAt: null }),
      readReferenceBindings: async () => [],
      readHarnessRuns: async () => [],
      forwarders: [],
      now: () => NOW,
      logger: { info: vi.fn(), warn: vi.fn() },
      scheduler: { setTimeout: vi.fn(), clearTimeout: vi.fn() },
    });
    const watchdogStatus = await watchdog.tick();
    const sinks = `${JSON.stringify(alerts)}${statusOutput.join("")}${JSON.stringify(watchdogStatus)}`;
    expect(sinks).not.toContain(SENTINEL);
    print(`INT4D_DRILL_GREEN malicious-oversized quarantine=poison_read cycles=3 sentinel_in_sink=false pilot_available=true watchdog_available=true detection_ms=${Date.now() - started}`);
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

async function seedApprovedTask(suffix: string): Promise<AgentTaskV1> {
  const workItemId = `int4d-${suffix}`;
  const candidate = agentTaskV1Schema.parse({
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
      actor: { type: "operator", id: "int4d-operator" },
      decidedAt: OLD,
      approvedTaskHash: `sha256:${"f".repeat(64)}`,
    },
    timestamps: {
      ...fixture.timestamps,
      approvedAt: OLD,
      updatedAt: OLD,
    },
    bindings: undefined,
  });
  const artifact = await buildTaskIntentArtifact(candidate, {
    workspacePath: workspacePathForTask(workItemId, 1),
  });
  const withTemplate = agentTaskV1Schema.parse({
    ...candidate,
    intent: {
      ...candidate.intent,
      templateHash: artifact.templateHash,
      templateRef: {
        uri: `artifact://sha256/${artifact.templateHash.slice(7)}`,
        sha256: artifact.templateHash,
      },
    },
  });
  const task = agentTaskV1Schema.parse({
    ...withTemplate,
    approval: {
      ...withTemplate.approval,
      approvedTaskHash: await hashAgentTaskApprovalPayload(withTemplate),
    },
  });
  await putAgentTask(task, refDeps());
  return task;
}

async function seedRunningTask(suffix: string): Promise<AgentTaskV1> {
  const approved = await seedApprovedTask(suffix);
  const runId = deriveIntendedRunId(
    approved.workItemId,
    approved.taskVersion,
    approved.approval.approvedTaskHash!,
  );
  const running = agentTaskV1Schema.parse({
    ...approved,
    lifecycle: "running",
    timestamps: {
      ...approved.timestamps,
      dispatchClaimedAt: OLD,
      runBoundAt: OLD,
      updatedAt: OLD,
    },
    bindings: {
      harnessRunId: runId,
      runManifestRef: MANIFEST_REF,
      runManifestHash: MANIFEST_HASH,
    },
  });
  await putAgentTask(running, refDeps());
  await bindRunToWorkItem({
    workItemId: running.workItemId,
    harnessRunId: runId,
    runManifestRef: MANIFEST_REF,
    runManifestHash: MANIFEST_HASH,
  }, refDeps());
  return running;
}

function reconcileDeps(
  task: AgentTaskV1,
  read: HarnessRunReadSnapshot,
  alerts: Array<Record<string, unknown>>,
  overrides: Partial<ReconcileRunDeps> = {},
): ReconcileRunDeps {
  let clock = NOW.getTime();
  return {
    now: overrides.now ?? (() => new Date(clock += 1_000)),
    isHalted: overrides.isHalted ?? (() => false),
    activePolicyIdentity: overrides.activePolicyIdentity ?? {
      version: task.approval.policyVersion,
      hash: task.approval.policyHash,
    },
    listTasks: overrides.listTasks ?? (() => listAgentTasks({
      executorKind: "harness",
      limit: 1_000,
    }, refDeps())),
    saveTask: overrides.saveTask ?? ((candidate) => putAgentTask(candidate, refDeps())),
    getRunBinding: overrides.getRunBinding ?? ((workItemId) => getRunBinding(workItemId, refDeps())),
    getPolicyDrift: overrides.getPolicyDrift ?? ((workItemId, taskVersion) =>
      getDispatchPolicyDrift(workItemId, taskVersion, refDeps())),
    transitionPolicyDrift: overrides.transitionPolicyDrift ?? ((input) =>
      transitionDispatchPolicyDrift(input, refDeps())),
    getActiveQuarantine: overrides.getActiveQuarantine ?? ((workItemId, taskVersion) =>
      getActiveDispatchQuarantine(workItemId, taskVersion, refDeps())),
    markQuarantine: overrides.markQuarantine ?? ((input) => markDispatchQuarantine(input, refDeps())),
    listBindingAuditRows: overrides.listBindingAuditRows ?? (() => listRunBindingAuditRows(refDeps())),
    bindRun: overrides.bindRun ?? ((input) => bindRunToWorkItem(input, refDeps())),
    readPort: overrides.readPort ?? { readRun: async () => read },
    controlPort: overrides.controlPort ?? { cancel: async () => undefined },
    recordDecision: overrides.recordDecision ?? ((record) => recordHermesDecision(record, refDeps())),
    alertSink: overrides.alertSink ?? (async (alert) => { alerts.push(alert); }),
    poisonThreshold: overrides.poisonThreshold ?? 3,
    poisonFailures: overrides.poisonFailures ?? createPoisonFailureTracker(),
    logger: overrides.logger ?? { warn: vi.fn() },
    ...(overrides.projectRun ? { projectRun: overrides.projectRun } : {}),
  };
}

function dispatchDeps(
  task: AgentTaskV1,
  activePolicyIdentity: { version: string; hash: string },
  alerts: Array<Record<string, unknown>>,
  submitted: string[],
): DispatchDeps {
  return {
    now: () => NOW,
    dispatcherId: "int4d-policy-dispatcher",
    leaseTtlSeconds: 30,
    claimTtlMs: 600_000,
    maxInflight: 1,
    activePolicyIdentity,
    isDispatchEnabled: () => true,
    isHalted: () => false,
    listDispatchable: async () => [task],
    getTask: async () => task,
    saveTask: (candidate) => putAgentTask(candidate, refDeps()),
    acquireLease: async () => true,
    renewLease: async () => true,
    releaseLease: async () => true,
    claimDispatch: async (input) => ({
      created: true,
      acquired: true,
      claim: {
        workItemId: input.workItemId,
        taskVersion: input.taskVersion,
        approvedTaskHash: input.approvedTaskHash,
        intendedRunId: input.intendedRunId,
        claimState: "claimed",
        claimHolder: input.holder,
        claimGeneration: 1,
        claimedAt: NOW,
        leaseExpiresAt: new Date(NOW.getTime() + 600_000),
      },
    }),
    getNextExpiredClaim: async () => undefined,
    acquireNextExpiredClaim: async () => undefined,
    recordClaimProgress: async (input) => ({
      workItemId: input.workItemId,
      taskVersion: input.taskVersion,
      approvedTaskHash: task.approval.approvedTaskHash!,
      intendedRunId: deriveIntendedRunId(
        task.workItemId,
        task.taskVersion,
        task.approval.approvedTaskHash!,
      ),
      claimState: input.progress,
      claimHolder: input.holder,
      claimGeneration: input.claimGeneration,
      claimedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 600_000),
    }),
    countInflight: async () => 0,
    transitionBackpressure: async (input) => ({
      state: { ...input, changedAt: NOW.toISOString() },
      changed: false,
    }),
    getRunBinding: async () => undefined,
    bindRun: async () => undefined,
    loadProfileManifest: async (profileId) => ({
      profileId,
      strategies: ["direct_execution"],
      capabilities: CAPABILITIES,
    }),
    prepareWorkspace: async (candidate) => workspacePathForTask(
      candidate.workItemId,
      candidate.taskVersion,
    ),
    writeIntentArtifact: async () => "/tmp/int4d-policy-intent.json",
    controlPort: {
      submit: async (runId) => {
        submitted.push(runId);
        return runId;
      },
      cancel: async () => undefined,
    },
    recordDecision: (record) => recordHermesDecision(record, refDeps()),
    alertSink: async (alert) => { alerts.push(alert); },
    logger: { info: vi.fn(), warn: vi.fn() },
  };
}

function pilotStatusServices() {
  return {
    listAgentTasks: (filter: Record<string, unknown>) => listAgentTasks(filter, refDeps()),
    listDispatchQuarantines: async (filter: { workItemId?: string }) => {
      if (!filter.workItemId) return [];
      const tasks = await listAgentTasks({ workItemId: filter.workItemId }, refDeps());
      const markers = await Promise.all(tasks.map((task) =>
        getActiveDispatchQuarantine(task.workItemId, task.taskVersion, refDeps())));
      return markers.filter(Boolean);
    },
    listHermesDecisions: (filter: Record<string, unknown>) => listHermesDecisions(filter, refDeps()),
    listDispatchPolicyDrifts: (filter: Record<string, unknown>) => listDispatchPolicyDrifts(filter, refDeps()),
    getDispatchBackpressure: async () => undefined,
    readTextFile: async () => { throw new Error("not configured"); },
  };
}

function activeRead(runId: string): HarnessRunReadSnapshot {
  return {
    status: {
      runId,
      state: "executing",
      attempt: 1,
      egressPolicy: "deny",
      createdAt: OLD,
      updatedAt: NOW.toISOString(),
    },
    events: [],
    deliverables: [],
  };
}

function terminalRead(runId: string): HarnessRunReadSnapshot {
  const verification = {
    seq: 9,
    type: "VerificationCompleted",
    payload: {
      passed: true,
      verdict: "completed",
      report_ref: `artifact://sha256/${"6".repeat(64)}`,
    },
  };
  return {
    status: {
      runId,
      state: "completed",
      attempt: 1,
      outcome: "completed",
      egressPolicy: "deny",
      createdAt: OLD,
      updatedAt: NOW.toISOString(),
    },
    events: [
      verification,
      { seq: 2, type: "EnvironmentPrepared", payload: { manifest_hash: MANIFEST_HASH } },
      { ...verification, seq: 8 },
      { seq: 1, type: "ContractCompiled", payload: { risk_class: "low" } },
    ],
    deliverables: [
      deliverable("workspace_patch", "1"),
      deliverable("change_summary", "2"),
      deliverable("verification_report", "6"),
    ],
  };
}

function deliverable(deliverableType: string, digit: string) {
  const digest = digit.repeat(64);
  return {
    deliverableType,
    artifact: {
      uri: `artifact://sha256/${digest}`,
      sha256: `sha256:${digest}`,
    },
  };
}

function statusText(runId: string): string {
  return `run_id=${runId}\nstate=failed\nattempt=1\noutcome=failed\ncreated_at=${OLD}\nupdated_at=${NOW.toISOString()}\n`;
}

async function controlStoreFingerprint(): Promise<string> {
  const tables = [
    "agent_tasks",
    "agent_task_run_outbox",
    "agent_task_dispatch_claims",
    "agent_task_dispatch_quarantines",
    "hermes_decision_records",
    "harness_dispatch_policy_drift",
    "harness_dispatch_backpressure",
    "dispatch_lease",
  ];
  const rows: Record<string, unknown[]> = {};
  for (const table of tables) {
    rows[table] = (await referencePool.query(
      `select to_jsonb(candidate) || jsonb_build_object('_xmin', xmin::text) as row
       from ${table} candidate order by to_jsonb(candidate)::text`,
    )).rows.map((entry) => entry.row);
  }
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

function print(line: string): void {
  if (PRINT_EVIDENCE) console.info(line);
}
