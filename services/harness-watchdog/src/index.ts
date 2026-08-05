import { fileURLToPath } from "node:url";

import { createSlackForwarder } from "./forwarders.js";
import { createPostgresWatchdogProbes } from "./postgres-probes.js";
import {
  createWatchdogProcess,
  parseWatchdogConfig,
  type WatchdogLogger,
  type WatchdogProcess,
} from "./watchdog.js";

export interface ProductionWatchdog {
  process: WatchdogProcess;
  close(): Promise<void>;
}

export function createProductionWatchdog(
  environmentInput: Readonly<Record<string, string | undefined>> = process.env,
  logger: WatchdogLogger = consoleWatchdogLogger,
): ProductionWatchdog {
  const environment = Object.freeze({ ...environmentInput });
  const config = parseWatchdogConfig(environment);
  const probes = createPostgresWatchdogProbes({
    referenceDatabaseUrl: environment.DATABASE_URL,
    harnessDatabaseUrl: environment.HARNESS_DATABASE_URL,
    connectionTimeoutMs: config.databaseTimeoutMs,
  });
  const forwarders = [
    createSlackForwarder({
      webhookUrl: environment.WATCHDOG_SLACK_WEBHOOK_URL,
    }),
  ];
  const watchdog = createWatchdogProcess(config, {
    ...probes,
    forwarders,
    now: () => new Date(),
    logger,
    scheduler: {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    },
  });
  return {
    process: watchdog,
    async close(): Promise<void> {
      try {
        await watchdog.shutdown();
      } finally {
        await probes.close();
      }
    },
  };
}

const consoleWatchdogLogger: WatchdogLogger = {
  info(fields, message) {
    console.info(`[harness-watchdog] ${message}`, fields);
  },
  warn(fields, message) {
    console.warn(`[harness-watchdog] ${message}`, fields);
  },
};

async function main(): Promise<void> {
  const watchdog = createProductionWatchdog();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= watchdog.close().then(() => {
      process.exitCode = 0;
    });
    return shutdownPromise;
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  watchdog.process.start();
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error("[harness-watchdog] fatal", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    process.exitCode = 1;
  });
}
