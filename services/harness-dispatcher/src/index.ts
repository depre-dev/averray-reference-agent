import { mkdir, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getAgentTask,
  listAgentTasks,
  listDispatchableAgentTasks,
  putAgentTask,
} from "@avg/averray-mcp/agent-task-store";
import {
  countInflightHarnessRuns,
  transitionDispatchBackpressure,
} from "@avg/averray-mcp/dispatch-backpressure";
import {
  acquireNextExpiredDispatchClaim,
  acquireDispatchLease,
  claimDispatch,
  getNextExpiredDispatchClaim,
  recordDispatchClaimProgress,
  releaseDispatchLease,
  renewDispatchLease,
} from "@avg/averray-mcp/dispatch-claim";
import {
  getActiveDispatchQuarantine,
  listRunBindingAuditRows,
  markDispatchQuarantine,
} from "@avg/averray-mcp/dispatch-quarantine";
import {
  recordHermesDecision,
} from "@avg/averray-mcp/decision-record-store";
import {
  bindRunToWorkItem,
  getRunBinding,
} from "@avg/averray-mcp/run-binding-outbox";
import {
  createHarnessCliReadPort,
} from "@avg/averray-mcp/harness-read-port";
import { closePool } from "@avg/mcp-common";
import { taskIntentSchema } from "@avg/schemas";

import {
  createDispatchAlertSink,
} from "./alerts.js";
import {
  readHaltFile,
  runSingleDispatch,
  type DispatchCrashPoint,
  type DispatchAttemptResult,
  type DispatchDeps,
} from "./dispatch-attempt.js";
import {
  createHarnessControlPort,
  harnessDispatchEnabled,
} from "./harness-control-port.js";
import { loadProfileManifest } from "./profile-manifest.js";
import {
  createPoisonFailureTracker,
  reconcileDispatchedRuns,
  type ReconcileResult,
  type ReconcileRunDeps,
} from "./reconcile-run.js";
import {
  prepareTaskWorkspace,
  seedWorkspaceDependencies,
} from "./workspace-prep.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 300_000;
const DEFAULT_LEASE_TTL_SECONDS = 120;
const MIN_LEASE_TTL_SECONDS = 30;
const MAX_LEASE_TTL_SECONDS = 900;
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const MIN_READ_TIMEOUT_MS = 1_000;
const MAX_READ_TIMEOUT_MS = 30_000;
const DEFAULT_POISON_THRESHOLD = 5;
const MIN_POISON_THRESHOLD = 1;
const MAX_POISON_THRESHOLD = 100;
const DEFAULT_CLAIM_TTL_MS = 600_000;
const MIN_CLAIM_TTL_MS = 1_000;
const MAX_CLAIM_TTL_MS = 86_400_000;
const DEFAULT_MAX_INFLIGHT = 1;
const MIN_MAX_INFLIGHT = 1;
const MAX_MAX_INFLIGHT = 100;

export interface DispatchFaultInjection {
  enabled: true;
  crashPoint: DispatchCrashPoint;
}

export type DispatcherHeartbeatStatus =
  | "disabled"
  | "halted"
  | "idle"
  | "dispatching"
  | "error";

export interface DispatcherHeartbeat {
  schemaVersion: 1;
  kind: "harness_dispatcher_heartbeat";
  dispatcherId: string;
  status: DispatcherHeartbeatStatus;
  message: string;
  updatedAt: string;
  cycleCount: number;
  reconciledCount: number;
  lastOutcome?: string;
  faultInjection?: DispatchFaultInjection;
}

export interface DispatcherConfig {
  dispatcherId: string;
  pollIntervalMs: number;
  leaseTtlSeconds: number;
  claimTtlMs: number;
  maxInflight: number;
  readTimeoutMs: number;
  poisonThreshold: number;
  intentDir: string;
  heartbeatPath: string;
  harnessBin: string;
  faultInjection?: DispatchFaultInjection;
}

export interface DispatcherLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface DispatcherScheduler {
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export type DispatcherTickResult =
  | DispatchAttemptResult
  | { outcome: "error"; reason: "attempt_failed" };

export interface DispatcherProcessDeps {
  runReconcile(): Promise<ReconcileResult[]>;
  runAttempt(): Promise<DispatchAttemptResult>;
  isDispatchEnabled(): boolean;
  isHalted(): boolean;
  releaseLease(holder: string): Promise<boolean>;
  writeHeartbeat(heartbeat: DispatcherHeartbeat): Promise<void>;
  now(): Date;
  logger: DispatcherLogger;
  scheduler: DispatcherScheduler;
}

export interface DispatcherProcess {
  start(): void;
  tick(): Promise<DispatcherTickResult>;
  shutdown(): Promise<void>;
}

export function parseDispatcherConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  runtime: { hostname?: string; pid?: number; tmpdir?: string } = {},
): DispatcherConfig {
  const runtimeHostname = runtime.hostname ?? hostname();
  const runtimePid = runtime.pid ?? process.pid;
  const runtimeTmpdir = runtime.tmpdir ?? tmpdir();
  const dispatcherId = environment.HARNESS_DISPATCHER_ID?.trim()
    || `${runtimeHostname}-${runtimePid}`;
  const intentDir = path.resolve(
    environment.HARNESS_DISPATCH_INTENT_DIR?.trim()
      || path.join(
        runtimeTmpdir,
        "averray-reference-agent",
        "harness-dispatch-intents",
      ),
  );
  const heartbeatPath = path.resolve(
    environment.HARNESS_DISPATCH_HEARTBEAT_PATH?.trim()
      || path.join(
        runtimeTmpdir,
        "averray-reference-agent",
        "harness-dispatcher-heartbeat.json",
      ),
  );
  const faultInjection = parseFaultInjection(environment);

  return {
    dispatcherId,
    pollIntervalMs: boundedInteger(
      environment.HARNESS_DISPATCH_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
      MIN_POLL_INTERVAL_MS,
      MAX_POLL_INTERVAL_MS,
    ),
    leaseTtlSeconds: boundedInteger(
      environment.HARNESS_DISPATCH_LEASE_TTL_SECONDS,
      DEFAULT_LEASE_TTL_SECONDS,
      MIN_LEASE_TTL_SECONDS,
      MAX_LEASE_TTL_SECONDS,
    ),
    claimTtlMs: boundedInteger(
      environment.HARNESS_DISPATCH_CLAIM_TTL_MS,
      DEFAULT_CLAIM_TTL_MS,
      MIN_CLAIM_TTL_MS,
      MAX_CLAIM_TTL_MS,
    ),
    maxInflight: boundedInteger(
      environment.HARNESS_DISPATCH_MAX_INFLIGHT,
      DEFAULT_MAX_INFLIGHT,
      MIN_MAX_INFLIGHT,
      MAX_MAX_INFLIGHT,
    ),
    readTimeoutMs: boundedInteger(
      environment.HARNESS_DISPATCH_READ_TIMEOUT_MS,
      DEFAULT_READ_TIMEOUT_MS,
      MIN_READ_TIMEOUT_MS,
      MAX_READ_TIMEOUT_MS,
    ),
    poisonThreshold: boundedInteger(
      environment.HARNESS_DISPATCH_POISON_THRESHOLD,
      DEFAULT_POISON_THRESHOLD,
      MIN_POISON_THRESHOLD,
      MAX_POISON_THRESHOLD,
    ),
    intentDir,
    heartbeatPath,
    harnessBin: environment.HARNESS_BIN?.trim() || "harness",
    ...(faultInjection ? { faultInjection } : {}),
  };
}

export function createDispatcherProcess(
  config: DispatcherConfig,
  deps: DispatcherProcessDeps,
): DispatcherProcess {
  let stopped = true;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<DispatcherTickResult> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let lastOutcome: string | undefined;
  let lastReconciledCount = 0;
  let cycleCount = 0;

  const heartbeat = async (
    status: DispatcherHeartbeatStatus,
    message: string,
    outcome = lastOutcome,
    reconciledCount = lastReconciledCount,
  ): Promise<void> => {
    await deps.writeHeartbeat({
      schemaVersion: 1,
      kind: "harness_dispatcher_heartbeat",
      dispatcherId: config.dispatcherId,
      status,
      message,
      updatedAt: deps.now().toISOString(),
      cycleCount,
      reconciledCount,
      ...(outcome ? { lastOutcome: outcome } : {}),
      ...(config.faultInjection
        ? { faultInjection: config.faultInjection }
        : {}),
    });
  };

  const writeHeartbeatBestEffort = async (
    status: DispatcherHeartbeatStatus,
    message: string,
    outcome = lastOutcome,
    reconciledCount = lastReconciledCount,
  ): Promise<void> => {
    try {
      await heartbeat(status, message, outcome, reconciledCount);
    } catch (error) {
      deps.logger.warn(
        { errorName: errorName(error), status },
        "Harness dispatcher heartbeat could not be written",
      );
    }
  };

  const performTick = async (): Promise<DispatcherTickResult> => {
    cycleCount += 1;
    try {
      const enabled = deps.isDispatchEnabled();
      const halted = deps.isHalted();
      if (halted) {
        const reconciled = await deps.runReconcile();
        const result: DispatchAttemptResult = { outcome: "halted" };
        lastOutcome = result.outcome;
        lastReconciledCount = reconciled.length;
        logReconcile(deps.logger, reconciled);
        logAttempt(deps.logger, result);
        await writeHeartbeatBestEffort(
          "halted",
          "Harness dispatcher is halted; active-run stop reconciliation completed and no dispatch was attempted.",
          result.outcome,
          reconciled.length,
        );
        return result;
      }
      if (enabled && !halted) {
        await writeHeartbeatBestEffort(
          "dispatching",
          "Read-only reconciliation and one supervised dispatch attempt are in progress.",
        );
      }
      const reconciled = await deps.runReconcile();
      lastReconciledCount = reconciled.length;
      logReconcile(deps.logger, reconciled);
      const result = await deps.runAttempt();
      lastOutcome = result.outcome;
      logAttempt(deps.logger, result);
      const reconcileUnhealthy = reconciled.some((item) => !item.healthy);
      await writeHeartbeatBestEffort(
        reconcileUnhealthy ? "error" : heartbeatStatusForResult(result),
        tickMessage(result, reconciled),
        result.outcome,
        reconciled.length,
      );
      return result;
    } catch (error) {
      lastOutcome = "error";
      deps.logger.warn(
        { errorName: errorName(error) },
        "Harness dispatcher tick failed",
      );
      await writeHeartbeatBestEffort(
        "error",
        "Harness dispatcher tick failed; the next tick may retry polling.",
        "error",
      );
      return { outcome: "error", reason: "attempt_failed" };
    }
  };

  const tick = (): Promise<DispatcherTickResult> => {
    if (inFlight) return inFlight;
    const current = performTick().finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
    inFlight = current;
    return current;
  };

  const runLoopTick = async (): Promise<void> => {
    if (stopped) return;
    await tick();
    if (stopped) return;
    timer = deps.scheduler.setTimeout(() => {
      timer = undefined;
      void runLoopTick();
    }, config.pollIntervalMs);
  };

  const start = (): void => {
    if (!stopped) return;
    stopped = false;
    if (config.faultInjection) {
      deps.logger.error({
        crashPoint: config.faultInjection.crashPoint,
      }, "Harness dispatcher fault injection is armed");
    }
    void runLoopTick();
  };

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      stopped = true;
      if (timer) {
        deps.scheduler.clearTimeout(timer);
        timer = undefined;
      }
      if (inFlight) await inFlight;
      const enabled = deps.isDispatchEnabled();
      const halted = deps.isHalted();
      if (enabled) {
        try {
          await deps.releaseLease(config.dispatcherId);
        } catch (error) {
          deps.logger.warn(
            { errorName: errorName(error) },
            "Harness dispatch lease could not be released during shutdown",
          );
        }
      }
      const status = halted
        ? "halted"
        : !enabled
          ? "disabled"
          : "idle";
      try {
        await heartbeat(
          status,
          shutdownMessage(status),
        );
      } catch (error) {
        deps.logger.warn(
          { errorName: errorName(error) },
          "Harness dispatcher final heartbeat could not be written",
        );
      }
    })();
    return shutdownPromise;
  };

  return { start, tick, shutdown };
}

export function createIntentArtifactWriter(
  intentDir: string,
): DispatchDeps["writeIntentArtifact"] {
  const root = path.resolve(intentDir);
  return async (bytes, workItemId) => {
    if (
      !workItemId
      || workItemId.includes("/")
      || workItemId.includes("\\")
    ) {
      throw new Error("Harness intent work item id is not filename-safe");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new Error("Harness intent artifact is not canonical JSON");
    }
    const intent = taskIntentSchema.parse(parsed);
    if (intent.metadata.labels.averray_work_item_id !== workItemId) {
      throw new Error("Harness intent work item label does not match its task");
    }
    const versionLabel = intent.metadata.labels.task_version;
    if (!/^[1-9][0-9]*$/.test(versionLabel)) {
      throw new Error("Harness intent task version label is invalid");
    }
    const target = path.resolve(
      root,
      `${workItemId}-v${versionLabel}.json`,
    );
    assertPathContained(root, target);
    await mkdir(root, { recursive: true });
    await writeFile(target, bytes, "utf8");
    return target;
  };
}

export function createHeartbeatWriter(
  heartbeatPath: string,
): DispatcherProcessDeps["writeHeartbeat"] {
  const target = path.resolve(heartbeatPath);
  return async (heartbeat) => {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
  };
}

export function createProductionDispatcher(
  environmentInput: Readonly<Record<string, string | undefined>> = process.env,
  logger: DispatcherLogger = consoleDispatcherLogger,
): DispatcherProcess {
  const environment = Object.freeze({ ...environmentInput });
  const config = parseDispatcherConfig(environment);
  const controlPort = createHarnessControlPort({
    command: config.harnessBin,
    enabled: harnessDispatchEnabled(environment),
  });
  const alertSink = createDispatchAlertSink({
    environment,
    logger,
  });
  const dispatchDeps: DispatchDeps = {
    now: () => new Date(),
    dispatcherId: config.dispatcherId,
    leaseTtlSeconds: config.leaseTtlSeconds,
    claimTtlMs: config.claimTtlMs,
    maxInflight: config.maxInflight,
    isDispatchEnabled: () => harnessDispatchEnabled(environment),
    isHalted: () => readHaltFile(environment),
    listDispatchable: listDispatchableAgentTasks,
    getTask: getAgentTask,
    saveTask: putAgentTask,
    acquireLease: acquireDispatchLease,
    renewLease: renewDispatchLease,
    releaseLease: releaseDispatchLease,
    claimDispatch,
    getNextExpiredClaim: getNextExpiredDispatchClaim,
    acquireNextExpiredClaim: acquireNextExpiredDispatchClaim,
    recordClaimProgress: recordDispatchClaimProgress,
    countInflight: countInflightHarnessRuns,
    transitionBackpressure: transitionDispatchBackpressure,
    getRunBinding,
    bindRun: bindRunToWorkItem,
    loadProfileManifest: (profileId) =>
      loadProfileManifest(profileId, environment),
    prepareWorkspace: (task) =>
      prepareTaskWorkspace(task, {
        seedDependencies: (candidate, workspacePath) =>
          seedWorkspaceDependencies(candidate, workspacePath, {
            environment,
          }),
        logger: {
          info(fields, message) {
            logger.info(fields, message);
          },
        },
      }),
    writeIntentArtifact: createIntentArtifactWriter(config.intentDir),
    controlPort,
    recordDecision: recordHermesDecision,
    alertSink,
    ...(config.faultInjection
      ? { maybeCrash: createFaultInjectionCrash(config.faultInjection) }
      : {}),
    logger: {
      info(object, message) {
        logger.info(asLogFields(object), message);
      },
      warn(object, message) {
        logger.warn(asLogFields(object), message);
      },
    },
  };
  const reconcileDeps: ReconcileRunDeps = {
    now: dispatchDeps.now,
    isHalted: dispatchDeps.isHalted,
    listTasks: () => listAgentTasks({
      executorKind: "harness",
      limit: 1_000,
    }),
    saveTask: putAgentTask,
    getRunBinding,
    getActiveQuarantine: getActiveDispatchQuarantine,
    markQuarantine: markDispatchQuarantine,
    listBindingAuditRows: listRunBindingAuditRows,
    bindRun: bindRunToWorkItem,
    readPort: createHarnessCliReadPort({
      command: config.harnessBin,
      timeoutMs: config.readTimeoutMs,
    }),
    controlPort,
    recordDecision: recordHermesDecision,
    alertSink,
    poisonThreshold: config.poisonThreshold,
    poisonFailures: createPoisonFailureTracker(),
    logger: {
      warn(fields, message) {
        logger.warn(fields, message);
      },
    },
  };

  return createDispatcherProcess(config, {
    runReconcile: () => reconcileDispatchedRuns(reconcileDeps),
    runAttempt: () => runSingleDispatch(dispatchDeps),
    isDispatchEnabled: dispatchDeps.isDispatchEnabled,
    isHalted: dispatchDeps.isHalted,
    releaseLease: releaseDispatchLease,
    writeHeartbeat: createHeartbeatWriter(config.heartbeatPath),
    now: dispatchDeps.now,
    logger,
    scheduler: {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle),
    },
  });
}

function boundedInteger(
  input: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!input?.trim()) return fallback;
  const parsed = Number(input);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

function parseFaultInjection(
  environment: Readonly<Record<string, string | undefined>>,
): DispatchFaultInjection | undefined {
  if (environment.HARNESS_DISPATCH_FAULT_INJECTION?.trim() !== "enabled") {
    return undefined;
  }
  const crashPoint = environment.HARNESS_DISPATCH_CRASH_POINT?.trim();
  if (
    crashPoint !== "after-claim-before-submit"
    && crashPoint !== "after-submit-before-binding"
  ) {
    throw new Error(
      "HARNESS_DISPATCH_CRASH_POINT must name a supported point when fault injection is enabled",
    );
  }
  return { enabled: true, crashPoint };
}

export function createFaultInjectionCrash(
  faultInjection: DispatchFaultInjection,
  terminate: (code: number) => never = (code) => process.exit(code),
): NonNullable<DispatchDeps["maybeCrash"]> {
  return (point) => {
    if (point !== faultInjection.crashPoint) return;
    terminate(86);
  };
}

function heartbeatStatusForResult(
  result: DispatchAttemptResult,
): DispatcherHeartbeatStatus {
  if (result.outcome === "disabled") return "disabled";
  if (result.outcome === "halted") return "halted";
  if (result.outcome === "submit_failed") return "error";
  return "idle";
}

function attemptMessage(result: DispatchAttemptResult): string {
  const reason = "reason" in result ? ` (${result.reason})` : "";
  return `Harness dispatch attempt finished: ${result.outcome}${reason}.`;
}

function tickMessage(
  result: DispatchAttemptResult,
  reconciled: ReconcileResult[],
): string {
  const unhealthy = reconciled.filter((item) => !item.healthy).length;
  const reconciliation = `Reconciled ${reconciled.length} Harness run${reconciled.length === 1 ? "" : "s"}`
    + (unhealthy > 0 ? `; ${unhealthy} require attention` : "");
  return `${reconciliation}. ${attemptMessage(result)}`;
}

function logReconcile(
  logger: DispatcherLogger,
  reconciled: ReconcileResult[],
): void {
  if (reconciled.length === 0) return;
  const unhealthy = reconciled.filter((item) => !item.healthy);
  logger.info({
    reconciledCount: reconciled.length,
    unhealthyCount: unhealthy.length,
  }, "Harness run reconciliation completed");
  if (unhealthy.length > 0) {
    logger.warn({
      reconciledCount: reconciled.length,
      unhealthyCount: unhealthy.length,
      outcomes: unhealthy.map((item) => item.outcome),
    }, "Harness run reconciliation requires attention");
  }
}

function logAttempt(
  logger: DispatcherLogger,
  result: DispatchAttemptResult,
): void {
  const fields: Record<string, unknown> = {
    outcome: result.outcome,
    ...("reason" in result ? { reason: result.reason } : {}),
    ...("workItemId" in result ? { workItemId: result.workItemId } : {}),
    ...("taskVersion" in result ? { taskVersion: result.taskVersion } : {}),
  };
  logger.info(fields, "Harness dispatch attempt completed");
  if (
    (result.outcome === "refused" && result.reason !== "backpressure")
    || result.outcome === "submit_failed"
  ) {
    logger.warn(fields, "Harness dispatch attempt requires attention");
  }
}

function shutdownMessage(status: DispatcherHeartbeatStatus): string {
  if (status === "disabled") {
    return "Harness dispatcher stopped while dispatch remained disabled.";
  }
  if (status === "halted") {
    return "Harness dispatcher stopped while HALT_FILE remained present.";
  }
  return "Harness dispatcher stopped after releasing its lease.";
}

function assertPathContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (
    !relative
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("Harness intent artifact path escaped its configured root");
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function asLogFields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : { detail: String(value) };
}

const consoleDispatcherLogger: DispatcherLogger = {
  info(fields, message) {
    console.info(`[harness-dispatcher] ${message}`, fields);
  },
  warn(fields, message) {
    console.warn(`[harness-dispatcher] ${message}`, fields);
  },
  error(fields, message) {
    console.error(`[harness-dispatcher] ${message}`, fields);
  },
};

async function main(): Promise<void> {
  const dispatcher = createProductionDispatcher();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      await dispatcher.shutdown();
      await closePool();
      process.exitCode = 0;
    })();
    return shutdownPromise;
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  dispatcher.start();
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error("[harness-dispatcher] fatal", {
      errorName: errorName(error),
    });
    process.exitCode = 1;
  });
}
