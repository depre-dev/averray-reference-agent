import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  sanitizeDecisionValue,
} from "@avg/averray-mcp/decision-records";

const DEFAULT_ALERTS_PATH = "/data/harness-dispatch-alerts.jsonl";

export interface DispatchAlert {
  severity: "warn" | "critical";
  code: string;
  workItemId?: string;
  taskVersion?: number;
  harnessRunId?: string;
  message: string;
  at: string;
}

export type AlertSink = (alert: DispatchAlert) => Promise<void>;

export interface DispatchAlertLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export function createDispatchAlertSink(options: {
  environment?: Readonly<Record<string, string | undefined>>;
  logger?: DispatchAlertLogger;
} = {}): AlertSink {
  const environment = options.environment ?? process.env;
  const logger = options.logger ?? consoleDispatchAlertLogger;
  const target = path.resolve(
    environment.HARNESS_DISPATCH_ALERTS_PATH?.trim() || DEFAULT_ALERTS_PATH,
  );

  return async (input) => {
    const alert = sanitizeDispatchAlert(input);
    logger.warn({
      alert: true,
      severity: alert.severity,
      code: alert.code,
      ...(alert.workItemId ? { workItemId: alert.workItemId } : {}),
      ...(alert.taskVersion !== undefined
        ? { taskVersion: alert.taskVersion }
        : {}),
      ...(alert.harnessRunId ? { harnessRunId: alert.harnessRunId } : {}),
      at: alert.at,
    }, alert.message);
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(alert)}\n`, "utf8");
  };
}

export function sanitizeDispatchAlert(
  alert: DispatchAlert,
): DispatchAlert {
  const message = sanitizeDecisionValue(alert.message);
  return {
    ...alert,
    message: typeof message === "string"
      ? message
      : "Harness dispatcher alert details were unavailable.",
  };
}

const consoleDispatchAlertLogger: DispatchAlertLogger = {
  warn(fields, message) {
    console.warn("[harness-dispatcher] ALERT", fields, message);
  },
};
