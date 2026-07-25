/**
 * Write-only Harness CLI boundary.
 *
 * A submit that times out or fails to connect is ambiguous: the requested run
 * may already exist. The caller must reconcile with `run status <same runId>`
 * and, if needed, re-submit the SAME run id, which DBOS safely deduplicates.
 * Never mint a new run id when retrying an ambiguous submit.
 *
 * The dispatch flag gates submit only. HALT and a disabled dispatcher prevent
 * new work from starting, but neither can stop a run that is already active.
 * `run cancel` is authority-reducing: it cannot start work, broaden a grant,
 * approve, deny, release, or invoke any other control operation. Keeping cancel
 * available is therefore required for an emergency stop.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type HarnessControlErrorCode =
  | "dispatch_disabled"
  | "invalid_run_id"
  | "invalid_intent_path"
  | "refused_command"
  | "cli_failed"
  | "cli_timeout"
  | "cli_output_too_large"
  | "submit_malformed"
  | "submit_identity_mismatch";

export class HarnessControlError extends Error {
  constructor(
    readonly code: HarnessControlErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HarnessControlError";
  }
}

export interface HarnessCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type HarnessCommandExecutor = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number },
) => Promise<HarnessCommandResult>;

export interface HarnessControlPort {
  submit(runId: string, intentPath: string): Promise<string>;
  cancel(runId: string): Promise<void>;
}

export function harnessDispatchEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment.HARNESS_DISPATCH_ENABLED?.trim().toLowerCase() ?? "false";
  return value === "1" || value === "true";
}

export function createHarnessControlPort(options: {
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  enabled?: boolean;
  execute?: HarnessCommandExecutor;
} = {}): HarnessControlPort {
  const command = options.command?.trim() || "harness";
  if (path.basename(command) !== "harness") {
    throw new HarnessControlError(
      "cli_failed",
      "Harness control adapter requires an executable named harness",
      false,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const enabled = options.enabled ?? harnessDispatchEnabled();
  const execute = options.execute ?? executeHarnessCommand;

  const assertEnabled = (): void => {
    if (enabled !== true) {
      throw new HarnessControlError(
        "dispatch_disabled",
        "Harness dispatch is disabled",
        false,
      );
    }
  };

  return {
    async submit(runId, intentPath) {
      assertEnabled();
      assertCanonicalRunId(runId);
      assertRegularIntentFile(intentPath);

      const result = await runControlCommand(
        execute,
        command,
        ["run", "submit", "--run-id", runId, intentPath],
        timeoutMs,
        maxOutputBytes,
      );
      const lines = nonEmptyLines(result.stdout);
      if (lines.length !== 1) {
        throw new HarnessControlError(
          "submit_malformed",
          "Harness submit response must contain exactly one run id",
          false,
        );
      }
      if (lines[0] !== runId) {
        throw new HarnessControlError(
          "submit_identity_mismatch",
          "Harness submit response does not match the requested run id",
          false,
        );
      }
      return runId;
    },

    async cancel(runId) {
      assertCanonicalRunId(runId);

      await runControlCommand(
        execute,
        command,
        ["run", "cancel", runId],
        timeoutMs,
        maxOutputBytes,
      );
    },
  };
}

export function assertControlArgs(args: readonly string[]): void {
  const isSubmit = args.length === 5
    && args[0] === "run"
    && args[1] === "submit"
    && args[2] === "--run-id";
  const isCancel = args.length === 3
    && args[0] === "run"
    && args[1] === "cancel";
  if (!isSubmit && !isCancel) {
    throw new HarnessControlError(
      "refused_command",
      "Harness control adapter refused a non-allowlisted command",
      false,
    );
  }
}

export const executeHarnessCommand: HarnessCommandExecutor = (
  command,
  args,
  { timeoutMs, maxOutputBytes },
) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finishWithError = (error: HarnessControlError): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        finishWithError(
          new HarnessControlError(
            "cli_output_too_large",
            "Harness control response exceeded the configured output limit",
            false,
          ),
        );
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", () => {
      finishWithError(
        new HarnessControlError(
          "cli_failed",
          "Harness control command could not be started",
          true,
        ),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    timer = setTimeout(() => {
      finishWithError(
        new HarnessControlError(
          "cli_timeout",
          "Harness control command timed out",
          true,
        ),
      );
    }, timeoutMs);
    timer.unref();
  });

async function runControlCommand(
  execute: HarnessCommandExecutor,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<HarnessCommandResult> {
  assertControlArgs(args);
  let result: HarnessCommandResult;
  try {
    result = await execute(command, args, { timeoutMs, maxOutputBytes });
  } catch (error) {
    if (error instanceof HarnessControlError) throw error;
    throw new HarnessControlError(
      "cli_failed",
      "Harness control command could not be started",
      true,
    );
  }

  if (
    Buffer.byteLength(result.stdout, "utf8") + Buffer.byteLength(result.stderr, "utf8")
      > maxOutputBytes
  ) {
    throw new HarnessControlError(
      "cli_output_too_large",
      "Harness control response exceeded the configured output limit",
      false,
    );
  }
  if (result.code !== 0) {
    const safeDetail = safeCliFailureDetail(result.stderr);
    throw new HarnessControlError(
      "cli_failed",
      `Harness control command failed with exit ${result.code}${safeDetail ? `: ${safeDetail}` : ""}`,
      true,
    );
  }
  return result;
}

function assertCanonicalRunId(runId: string): void {
  if (!CANONICAL_UUID.test(runId)) {
    throw new HarnessControlError(
      "invalid_run_id",
      "Harness run id must be a lowercase canonical UUID",
      false,
    );
  }
}

function assertRegularIntentFile(intentPath: string): void {
  if (!intentPath.trim() || !path.isAbsolute(intentPath)) {
    throw new HarnessControlError(
      "invalid_intent_path",
      "Harness intent path must be an absolute regular file",
      false,
    );
  }
  try {
    if (statSync(intentPath).isFile()) return;
  } catch {
    // Fall through to the same non-sensitive validation error.
  }
  throw new HarnessControlError(
    "invalid_intent_path",
    "Harness intent path must be an absolute regular file",
    false,
  );
}

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function safeCliFailureDetail(stderr: string): string {
  const text = stderr.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/schema missing/i.test(text)) return "Harness database schema is unavailable";
  if (/record not found|completed run not found/i.test(text)) {
    return "Harness run record is unavailable";
  }
  if (/configuration|connection/i.test(text)) return "Harness data source is unavailable";
  return "Harness data source refused the control request";
}
