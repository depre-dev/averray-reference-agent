import {
  appendFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  findBindingIntegrityViolations,
  type RunBindingAuditRow,
} from "@avg/averray-mcp/dispatch-quarantine";

import type { AlertForwarder, WatchdogSinkState } from "./forwarders.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_DISPATCHER_STALE_MS = 90_000;
const DEFAULT_HARNESS_SOURCE_STALE_MS = 15 * 60_000;
const DEFAULT_DATABASE_TIMEOUT_MS = 5_000;
const DEFAULT_ORPHAN_AGE_MS = 10 * 60_000;
const DEFAULT_HEARTBEAT_PATH = "/data/harness-watchdog-heartbeat.json";
const DEFAULT_STATUS_PATH = "/data/harness-watchdog-status.json";
const DEFAULT_DISPATCHER_HEARTBEAT_PATH = "/data/harness-dispatcher-heartbeat.json";
const DEFAULT_ALERTS_PATH = "/data/harness-dispatch-alerts.jsonl";

export interface WatchdogConfig {
  pollIntervalMs: number;
  dispatcherStaleMs: number;
  harnessSourceStaleMs: number;
  databaseTimeoutMs: number;
  orphanAgeMs: number;
  heartbeatPath: string;
  statusPath: string;
  dispatcherHeartbeatPath: string;
  alertsPath: string;
}

export interface HarnessSourceState {
  liveRun: boolean;
  newestEventAt: Date | null;
}

export interface WatchdogDatabaseProbes {
  probeReferenceDatabase(): Promise<void>;
  probeHarnessDatabase(): Promise<HarnessSourceState>;
  readReferenceBindings(): Promise<ReferenceBindingInventoryRow[]>;
  readHarnessRuns(): Promise<HarnessRunInventoryRow[]>;
}

export interface ReferenceBindingInventoryRow extends Omit<
  RunBindingAuditRow,
  "approvedTaskHash"
> {
  approvedTaskHash: string | null;
  lifecycle: string;
  boundAt: string;
  taskUpdatedAt: string;
}

export interface HarnessRunInventoryRow {
  runId: string;
  terminal: boolean;
  updatedAt: string;
}

export interface WatchdogDetection {
  key: string;
  severity: "warn" | "critical";
  code: string;
  message: string;
}

export interface WatchdogLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface WatchdogScheduler {
  setTimeout(callback: () => void, delayMs: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

export interface WatchdogDeps extends WatchdogDatabaseProbes {
  forwarders: AlertForwarder[];
  now(): Date;
  logger: WatchdogLogger;
  scheduler: WatchdogScheduler;
  detectOrphans?: typeof detectOrphans;
}

export interface WatchdogProcess {
  start(): void;
  tick(): Promise<WatchdogStatus>;
  shutdown(): Promise<void>;
}

export interface WatchdogStatus {
  schemaVersion: 1;
  kind: "harness_watchdog_status";
  updatedAt: string;
  activeIssues: string[];
  sinks: Array<{ name: string; state: WatchdogSinkState }>;
  lastAlertForwarded: null | {
    at: string;
    code: string;
    sinks: string[];
  };
  thresholds: {
    dispatcherStaleMs: number;
    harnessSourceStaleMs: number;
    databaseTimeoutMs: number;
    orphanAgeMs: number;
    pollIntervalMs: number;
  };
}

interface WatchdogAlert extends Record<string, unknown> {
  schemaVersion: 1;
  kind: "harness_watchdog_alert";
  severity: "warn" | "critical";
  code: string;
  message: string;
  at: string;
}

interface AlertTailState {
  offset: number;
  remainder: string;
}

export function parseWatchdogConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): WatchdogConfig {
  return {
    pollIntervalMs: positiveInteger(
      environment.WATCHDOG_POLL_INTERVAL_MS,
      DEFAULT_POLL_INTERVAL_MS,
    ),
    dispatcherStaleMs: positiveInteger(
      environment.WATCHDOG_DISPATCHER_STALE_MS,
      DEFAULT_DISPATCHER_STALE_MS,
    ),
    harnessSourceStaleMs: positiveInteger(
      environment.WATCHDOG_HARNESS_SOURCE_STALE_MS,
      DEFAULT_HARNESS_SOURCE_STALE_MS,
    ),
    databaseTimeoutMs: positiveInteger(
      environment.WATCHDOG_DATABASE_TIMEOUT_MS,
      DEFAULT_DATABASE_TIMEOUT_MS,
    ),
    orphanAgeMs: positiveInteger(
      environment.WATCHDOG_ORPHAN_AGE_MS,
      DEFAULT_ORPHAN_AGE_MS,
    ),
    heartbeatPath: path.resolve(
      environment.WATCHDOG_HEARTBEAT_PATH?.trim() || DEFAULT_HEARTBEAT_PATH,
    ),
    statusPath: path.resolve(
      environment.WATCHDOG_STATUS_PATH?.trim() || DEFAULT_STATUS_PATH,
    ),
    dispatcherHeartbeatPath: path.resolve(
      environment.HARNESS_DISPATCH_HEARTBEAT_PATH?.trim()
        || DEFAULT_DISPATCHER_HEARTBEAT_PATH,
    ),
    alertsPath: path.resolve(
      environment.HARNESS_DISPATCH_ALERTS_PATH?.trim() || DEFAULT_ALERTS_PATH,
    ),
  };
}

export function createWatchdogProcess(
  config: WatchdogConfig,
  deps: WatchdogDeps,
): WatchdogProcess {
  let stopped = true;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<WatchdogStatus> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let tailState: AlertTailState | undefined;
  let lastAlertForwarded: WatchdogStatus["lastAlertForwarded"] = null;
  const activeIssues = new Set<string>();
  const startedAt = deps.now();

  const appendDetection = async (
    issueKey: string,
    active: boolean,
    alert: {
      severity: "warn" | "critical";
      code?: string;
      message: string;
    },
  ): Promise<void> => {
    if (!active) {
      activeIssues.delete(issueKey);
      return;
    }
    if (activeIssues.has(issueKey)) return;
    const record: WatchdogAlert = {
      schemaVersion: 1,
      kind: "harness_watchdog_alert",
      severity: alert.severity,
      code: alert.code ?? issueKey,
      message: alert.message,
      at: deps.now().toISOString(),
    };
    await mkdir(path.dirname(config.alertsPath), { recursive: true });
    await appendFile(config.alertsPath, `${JSON.stringify(record)}\n`, "utf8");
    activeIssues.add(issueKey);
  };

  const syncDetectionGroup = async (
    prefix: string,
    detections: WatchdogDetection[],
  ): Promise<void> => {
    const observed = new Set(detections.map(({ key }) => key));
    for (const existing of [...activeIssues]) {
      if (existing.startsWith(prefix) && !observed.has(existing)) {
        activeIssues.delete(existing);
      }
    }
    for (const detection of detections) {
      await appendDetection(detection.key, true, detection);
    }
  };

  const probeDatabases = async (): Promise<void> => {
    let referenceReachable = true;
    try {
      await deps.probeReferenceDatabase();
    } catch {
      referenceReachable = false;
    }
    await appendDetection(
      "watchdog_reference_database_unreachable",
      !referenceReachable,
      {
        severity: "critical",
        message: "The reference-agent Postgres database is unreachable.",
      },
    );

    let harnessState: HarnessSourceState | undefined;
    try {
      harnessState = await deps.probeHarnessDatabase();
    } catch {
      // The alert names the affected boundary without retaining a DSN-bearing
      // driver error.
    }
    await appendDetection(
      "watchdog_harness_database_unreachable",
      harnessState === undefined,
      {
        severity: "critical",
        message: "The Harness Postgres database is unreachable.",
      },
    );
    if (!harnessState) {
      activeIssues.delete("watchdog_harness_source_stale");
      return;
    }

    const sourceAgeMs = harnessState.newestEventAt
      ? deps.now().getTime() - harnessState.newestEventAt.getTime()
      : deps.now().getTime() - startedAt.getTime();
    await appendDetection(
      "watchdog_harness_source_stale",
      harnessState.liveRun && sourceAgeMs > config.harnessSourceStaleMs,
      {
        severity: "critical",
        message: `A live Harness run has produced no event within ${config.harnessSourceStaleMs}ms.`,
      },
    );
  };

  const probeDispatcherHeartbeat = async (): Promise<void> => {
    const heartbeatAt = await readDispatcherHeartbeatTimestamp(
      config.dispatcherHeartbeatPath,
    );
    const ageMs = deps.now().getTime()
      - (heartbeatAt?.getTime() ?? startedAt.getTime());
    await appendDetection(
      "watchdog_dispatcher_heartbeat_stale",
      ageMs > config.dispatcherStaleMs,
      {
        severity: "critical",
        message: `The Harness dispatcher heartbeat is older than ${config.dispatcherStaleMs}ms.`,
      },
    );
  };

  const probeBindingIntegrityAndOrphans = async (): Promise<void> => {
    let bindings: ReferenceBindingInventoryRow[];
    let runs: HarnessRunInventoryRow[];
    try {
      [bindings, runs] = await Promise.all([
        deps.readReferenceBindings(),
        deps.readHarnessRuns(),
      ]);
    } catch {
      // A probe outage is not evidence that an existing issue cleared. Keep
      // the dedupe state so recovery cannot replay the same alert as new.
      return;
    }
    await syncDetectionGroup(
      "watchdog_binding_integrity:",
      bindingIntegrityDetections(bindings),
    );
    await syncDetectionGroup(
      "watchdog_orphan:",
      (deps.detectOrphans ?? detectOrphans)(
        bindings,
        runs,
        deps.now(),
        config.orphanAgeMs,
      ),
    );
  };

  const initializeTail = async (): Promise<void> => {
    if (tailState) return;
    const size = await stat(config.alertsPath)
      .then((value) => value.size)
      .catch(() => 0);
    tailState = { offset: size, remainder: "" };
  };

  const forwardNewAlerts = async (): Promise<void> => {
    if (!tailState) throw new Error("Watchdog alert tail was not initialized");
    const next = await readAlertTail(config.alertsPath, tailState);
    tailState = next.state;
    for (const line of next.lines) {
      let alert: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error("not an object");
        alert = parsed;
      } catch {
        deps.logger.warn(
          { source: "dispatch_alert_stream" },
          "Watchdog skipped a malformed alert-stream record",
        );
        continue;
      }

      const delivered: string[] = [];
      for (const forwarder of deps.forwarders) {
        if (forwarder.state === "disabled") continue;
        try {
          await forwarder.forward(alert);
          delivered.push(forwarder.name);
        } catch (error) {
          deps.logger.warn(
            { sink: forwarder.name, errorName: errorName(error) },
            "Watchdog alert forwarding failed",
          );
        }
      }
      if (delivered.length > 0) {
        lastAlertForwarded = {
          at: deps.now().toISOString(),
          code: stringField(alert.code, "unknown_alert"),
          sinks: delivered,
        };
      }
    }
  };

  const writeObservability = async (): Promise<WatchdogStatus> => {
    const now = deps.now().toISOString();
    const status: WatchdogStatus = {
      schemaVersion: 1,
      kind: "harness_watchdog_status",
      updatedAt: now,
      activeIssues: [...activeIssues].sort(),
      sinks: deps.forwarders.map(({ name, state }) => ({ name, state })),
      lastAlertForwarded,
      thresholds: {
        dispatcherStaleMs: config.dispatcherStaleMs,
        harnessSourceStaleMs: config.harnessSourceStaleMs,
        databaseTimeoutMs: config.databaseTimeoutMs,
        orphanAgeMs: config.orphanAgeMs,
        pollIntervalMs: config.pollIntervalMs,
      },
    };
    const heartbeat = {
      schemaVersion: 1,
      kind: "harness_watchdog_heartbeat",
      status: activeIssues.size === 0 ? "healthy" : "degraded",
      updatedAt: now,
      activeIssueCount: activeIssues.size,
    };
    await Promise.all([
      writeJsonLine(config.heartbeatPath, heartbeat),
      writeJsonLine(config.statusPath, status),
    ]);
    return status;
  };

  const performTick = async (): Promise<WatchdogStatus> => {
    await initializeTail();
    await Promise.all([
      probeDatabases(),
      probeDispatcherHeartbeat(),
      probeBindingIntegrityAndOrphans(),
    ]);
    await forwardNewAlerts();
    return writeObservability();
  };

  const tick = (): Promise<WatchdogStatus> => {
    if (inFlight) return inFlight;
    const current = performTick().finally(() => {
      if (inFlight === current) inFlight = undefined;
    });
    inFlight = current;
    return current;
  };

  const runLoopTick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await tick();
    } catch (error) {
      deps.logger.warn(
        { errorName: errorName(error) },
        "Harness watchdog tick failed",
      );
    }
    if (stopped) return;
    timer = deps.scheduler.setTimeout(() => {
      timer = undefined;
      void runLoopTick();
    }, config.pollIntervalMs);
  };

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      void runLoopTick();
    },
    tick,
    shutdown(): Promise<void> {
      shutdownPromise ??= (async () => {
        stopped = true;
        if (timer) {
          deps.scheduler.clearTimeout(timer);
          timer = undefined;
        }
        if (inFlight) await inFlight;
        await writeObservability();
      })();
      return shutdownPromise;
    },
  };
}

export async function readDispatcherHeartbeatTimestamp(
  target: string,
): Promise<Date | null> {
  try {
    const raw = await readFile(target, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.updatedAt !== "string") return null;
    const timestamp = new Date(parsed.updatedAt);
    return Number.isFinite(timestamp.getTime()) ? timestamp : null;
  } catch {
    return null;
  }
}

export function bindingIntegrityDetections(
  bindings: readonly ReferenceBindingInventoryRow[],
): WatchdogDetection[] {
  const rows: RunBindingAuditRow[] = bindings.map((binding) => ({
    workItemId: binding.workItemId,
    taskVersion: binding.taskVersion,
    ...(binding.approvedTaskHash
      ? { approvedTaskHash: binding.approvedTaskHash }
      : {}),
    harnessRunId: binding.harnessRunId,
  }));
  return findBindingIntegrityViolations(rows).map((violation) => {
    if (violation.kind === "run_id_mismatch") {
      return {
        key:
          `watchdog_binding_integrity:mismatch:${violation.workItemId}@${violation.taskVersion}`,
        severity: "critical",
        code: "watchdog_binding_integrity_violation",
        message:
          `Harness binding mismatch for ${violation.workItemId}@${violation.taskVersion}: actual run id ${violation.harnessRunId}; intended run id ${violation.intendedRunId ?? "unavailable because the approval hash is absent"}.`,
      };
    }
    return {
      key:
        `watchdog_binding_integrity:duplicate:${violation.workItemId}@${violation.taskVersion}`,
      severity: "critical",
      code: "watchdog_binding_integrity_violation",
      message:
        `Harness run id ${violation.harnessRunId} is shared by ${violation.workItemId}@${violation.taskVersion} and ${violation.conflictingWorkItemId}@${violation.conflictingTaskVersion}.`,
    };
  });
}

export function detectOrphans(
  bindings: readonly ReferenceBindingInventoryRow[],
  runs: readonly HarnessRunInventoryRow[],
  now: Date,
  orphanAgeMs: number,
): WatchdogDetection[] {
  const byRunId = new Map(runs.map((run) => [run.runId, run] as const));
  const terminalTasks = new Set(["handoff_ready", "failed", "cancelled"]);
  const detections: WatchdogDetection[] = [];
  for (const binding of bindings) {
    const run = byRunId.get(binding.harnessRunId);
    if (
      !terminalTasks.has(binding.lifecycle)
      && run === undefined
      && ageMs(now, binding.boundAt) >= orphanAgeMs
    ) {
      detections.push({
        key:
          `watchdog_orphan:task_without_run:${binding.workItemId}@${binding.taskVersion}`,
        severity: "warn",
        code: "watchdog_task_run_orphan",
        message:
          `Non-terminal task ${binding.workItemId}@${binding.taskVersion} is bound to absent Harness run ${binding.harnessRunId}.`,
      });
    }
    if (
      terminalTasks.has(binding.lifecycle)
      && run !== undefined
      && !run.terminal
      && ageMs(now, binding.taskUpdatedAt) >= orphanAgeMs
    ) {
      detections.push({
        key:
          `watchdog_orphan:run_with_terminal_task:${binding.harnessRunId}`,
        severity: "warn",
        code: "watchdog_harness_run_orphan",
        message:
          `Non-terminal Harness run ${binding.harnessRunId} remains bound to terminal task ${binding.workItemId}@${binding.taskVersion}.`,
      });
    }
  }
  return detections;
}

async function readAlertTail(
  target: string,
  previous: AlertTailState,
): Promise<{ state: AlertTailState; lines: string[] }> {
  let size: number;
  try {
    size = (await stat(target)).size;
  } catch {
    return { state: { offset: 0, remainder: "" }, lines: [] };
  }
  const offset = size < previous.offset ? 0 : previous.offset;
  if (size === offset) return { state: { ...previous, offset }, lines: [] };
  const handle = await open(target, "r");
  try {
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const combined = `${offset === previous.offset ? previous.remainder : ""}${buffer.toString("utf8")}`;
    const parts = combined.split("\n");
    const remainder = parts.pop() ?? "";
    return {
      state: { offset: size, remainder },
      lines: parts.filter((line) => line.trim().length > 0),
    };
  } finally {
    await handle.close();
  }
}

async function writeJsonLine(
  target: string,
  value: Readonly<object>,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value)}\n`, "utf8");
}

function positiveInteger(input: string | undefined, fallback: number): number {
  if (!input?.trim()) return fallback;
  const parsed = Number(input);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function ageMs(now: Date, timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, now.getTime() - parsed) : 0;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
