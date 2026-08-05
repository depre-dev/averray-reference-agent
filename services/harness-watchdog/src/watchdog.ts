import {
  appendFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { AlertForwarder, WatchdogSinkState } from "./forwarders.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_DISPATCHER_STALE_MS = 90_000;
const DEFAULT_HARNESS_SOURCE_STALE_MS = 15 * 60_000;
const DEFAULT_DATABASE_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_PATH = "/data/harness-watchdog-heartbeat.json";
const DEFAULT_STATUS_PATH = "/data/harness-watchdog-status.json";
const DEFAULT_DISPATCHER_HEARTBEAT_PATH = "/data/harness-dispatcher-heartbeat.json";
const DEFAULT_ALERTS_PATH = "/data/harness-dispatch-alerts.jsonl";

export interface WatchdogConfig {
  pollIntervalMs: number;
  dispatcherStaleMs: number;
  harnessSourceStaleMs: number;
  databaseTimeoutMs: number;
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
    code: string,
    active: boolean,
    alert: { severity: "warn" | "critical"; message: string },
  ): Promise<void> => {
    if (!active) {
      activeIssues.delete(code);
      return;
    }
    if (activeIssues.has(code)) return;
    const record: WatchdogAlert = {
      schemaVersion: 1,
      kind: "harness_watchdog_alert",
      severity: alert.severity,
      code,
      message: alert.message,
      at: deps.now().toISOString(),
    };
    await mkdir(path.dirname(config.alertsPath), { recursive: true });
    await appendFile(config.alertsPath, `${JSON.stringify(record)}\n`, "utf8");
    activeIssues.add(code);
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
