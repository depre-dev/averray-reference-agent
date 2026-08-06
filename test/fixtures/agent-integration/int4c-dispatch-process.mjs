import { setTimeout as delay } from "node:timers/promises";

import {
  getAgentTask,
  listDispatchableAgentTasks,
  putAgentTask,
} from "../../../packages/averray-mcp/dist/agent-task-store.js";
import {
  countInflightHarnessRuns,
  transitionDispatchBackpressure,
} from "../../../packages/averray-mcp/dist/dispatch-backpressure.js";
import {
  acquireDispatchLease,
  acquireNextExpiredDispatchClaim,
  claimDispatch,
  getNextExpiredDispatchClaim,
  recordDispatchClaimProgress,
  releaseDispatchLease,
  renewDispatchLease,
} from "../../../packages/averray-mcp/dist/dispatch-claim.js";
import {
  recordHermesDecision,
} from "../../../packages/averray-mcp/dist/decision-record-store.js";
import {
  bindRunToWorkItem,
  getRunBinding,
} from "../../../packages/averray-mcp/dist/run-binding-outbox.js";
import {
  workspacePathForTask,
} from "../../../packages/averray-mcp/dist/workspace-path.js";
import { closePool } from "../../../packages/mcp-common/dist/index.js";
import {
  createDispatchAlertSink,
} from "../../../services/harness-dispatcher/dist/alerts.js";
import {
  runSingleDispatch,
} from "../../../services/harness-dispatcher/dist/dispatch-attempt.js";
import {
  createDispatcherProcess,
  createFaultInjectionCrash,
  createHeartbeatWriter,
} from "../../../services/harness-dispatcher/dist/index.js";

const dispatcherId = required("INT4C_DISPATCHER_ID");
const harnessDatabaseUrl = required("INT4C_HARNESS_DATABASE_URL");
const heartbeatPath = required("HARNESS_DISPATCH_HEARTBEAT_PATH");
const claimTtlMs = Number(process.env.HARNESS_DISPATCH_CLAIM_TTL_MS ?? "250");
const mutation = process.env.INT4C_MUTATION?.trim();
const crashPoint = process.env.HARNESS_DISPATCH_CRASH_POINT?.trim();
const faultInjection = process.env.HARNESS_DISPATCH_FAULT_INJECTION === "enabled"
  ? { enabled: true, crashPoint }
  : undefined;

if (
  faultInjection
  && crashPoint !== "after-claim-before-submit"
  && crashPoint !== "after-submit-before-binding"
) {
  throw new Error("INT4C child received an invalid fenced crash point");
}

const logger = {
  info(fields, message) {
    process.stdout.write(`INT4C_CHILD_INFO ${message} ${JSON.stringify(fields)}\n`);
  },
  warn(fields, message) {
    process.stdout.write(`INT4C_CHILD_WARN ${message} ${JSON.stringify(fields)}\n`);
  },
  error(fields, message) {
    process.stdout.write(`INT4C_CHILD_ERROR ${message} ${JSON.stringify(fields)}\n`);
  },
};
const alertSink = createDispatchAlertSink({ environment: process.env, logger });

const acquireExpired = async (input) => {
  const claim = await acquireNextExpiredDispatchClaim(input);
  if (mutation === "remove-retry-bound" && claim?.claimState === "exhausted") {
    process.stdout.write("INT4C_MUTATION_APPLIED=remove-retry-bound\n");
    return { ...claim, claimState: "claimed", leaseExpiresAt: new Date(Date.now() + claimTtlMs).toISOString() };
  }
  return claim;
};
const transitionBackpressure = async (input) => {
  const result = await transitionDispatchBackpressure(input);
  if (mutation === "alert-dedup" && input.active) {
    process.stdout.write("INT4C_MUTATION_APPLIED=alert-dedup\n");
    return { ...result, changed: true };
  }
  return result;
};

const dispatchDeps = {
  now: () => new Date(),
  dispatcherId,
  leaseTtlSeconds: 1,
  claimTtlMs,
  maxInflight: Number(process.env.HARNESS_DISPATCH_MAX_INFLIGHT ?? "1"),
  isDispatchEnabled: () => true,
  isHalted: () => false,
  listDispatchable: listDispatchableAgentTasks,
  getTask: getAgentTask,
  saveTask: putAgentTask,
  acquireLease: acquireDispatchLease,
  renewLease: renewDispatchLease,
  releaseLease: releaseDispatchLease,
  claimDispatch,
  getNextExpiredClaim: getNextExpiredDispatchClaim,
  acquireNextExpiredClaim: acquireExpired,
  recordClaimProgress: recordDispatchClaimProgress,
  countInflight: countInflightHarnessRuns,
  transitionBackpressure,
  getRunBinding,
  bindRun: bindRunToWorkItem,
  loadProfileManifest: async (profileId) => ({
    profileId,
    strategies: ["direct_execution"],
    capabilities: [
      { id: "fs.read_file", effectClass: "none", delegable: false },
      { id: "fs.write_file", effectClass: "local", delegable: false },
      { id: "fs.list_files", effectClass: "none", delegable: false },
      { id: "shell.run", effectClass: "local", delegable: false },
      { id: "git.status", effectClass: "none", delegable: false },
      { id: "git.diff", effectClass: "none", delegable: false },
      { id: "artifact.put", effectClass: "local", delegable: false },
      { id: "artifact.get", effectClass: "none", delegable: false },
    ],
  }),
  prepareWorkspace: async (task) =>
    workspacePathForTask(task.workItemId, task.taskVersion),
  writeIntentArtifact: async (_bytes, workItemId) =>
    `/tmp/${workItemId}-int4c-intent.json`,
  controlPort: {
    async submit(runId) {
      const pool = await import("pg");
      const client = new pool.Client({ connectionString: harnessDatabaseUrl });
      await client.connect();
      try {
        await client.query(
          `insert into runs (
             run_id, task_id, correlation_id, state, task, manifest,
             outcome, outcome_reason, attempt, created_at, updated_at
           ) values ($1, $2, $2, 'accepted', '{}'::jsonb, null,
             null, null, 1, now(), now())
           on conflict (run_id) do nothing`,
          [runId, `task-${runId}`],
        );
      } finally {
        await client.end();
      }
      return runId;
    },
    async cancel() {},
  },
  recordDecision: recordHermesDecision,
  alertSink,
  ...(faultInjection
    ? { maybeCrash: createFaultInjectionCrash(faultInjection) }
    : {}),
  logger,
};

let dispatcher;
let closing = false;
const finish = async () => {
  if (closing) return;
  closing = true;
  await dispatcher.shutdown().catch(() => undefined);
  await closePool().catch(() => undefined);
  process.exit(0);
};

dispatcher = createDispatcherProcess({
  dispatcherId,
  pollIntervalMs: 50,
  leaseTtlSeconds: 1,
  claimTtlMs,
  maxInflight: dispatchDeps.maxInflight,
  readTimeoutMs: 1_000,
  poisonThreshold: 5,
  intentDir: "/tmp/int4c-intents",
  heartbeatPath,
  harnessBin: "harness",
  ...(faultInjection ? { faultInjection } : {}),
}, {
  runReconcile: async () => [],
  runAttempt: async () => {
    try {
      const result = await runSingleDispatch(dispatchDeps);
      process.stdout.write(`INT4C_CHILD_RESULT dispatcher=${dispatcherId} ${JSON.stringify(result)}\n`);
      if (result.outcome !== "lease_unavailable") {
        setTimeout(() => void finish(), 0);
      }
      return result;
    } catch (error) {
      process.stdout.write(`INT4C_CHILD_ATTEMPT_ERROR dispatcher=${dispatcherId} name=${error instanceof Error ? error.name : "UnknownError"}\n`);
      setTimeout(() => void finish(), 0);
      throw error;
    }
  },
  isDispatchEnabled: () => true,
  isHalted: () => false,
  releaseLease: releaseDispatchLease,
  writeHeartbeat: createHeartbeatWriter(heartbeatPath),
  now: () => new Date(),
  logger,
  scheduler: {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
  },
});

process.once("SIGTERM", () => void finish());
dispatcher.start();

await delay(20_000).then(() => {
  process.stderr.write(`INT4C_CHILD_TIMEOUT dispatcher=${dispatcherId}\n`);
  process.exit(70);
});

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
