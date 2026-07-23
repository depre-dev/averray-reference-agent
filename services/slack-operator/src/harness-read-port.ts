import { spawn } from "node:child_process";
import path from "node:path";

import {
  artifactRefSchema,
  harnessRunStateSchema,
  type ArtifactRef,
  type HarnessRunState,
} from "@avg/schemas";

import type { HarnessRunBinding } from "./harness-run-registry.js";

const MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const ALLOWED_EVENT_TYPES = new Set([
  "TaskAccepted",
  "ContractCompiled",
  "EnvironmentPrepared",
  "StrategySelected",
  "ModelRequested",
  "ModelResponded",
  "CapabilityProposed",
  "PolicyDecisionMade",
  "CapabilityDispatched",
  "CapabilityCompleted",
  "ArtifactCreated",
  "VerificationCompleted",
  "ApprovalRequested",
  "ApprovalGranted",
  "MemoryCandidateCreated",
  "RunCompleted",
  "SafetyTripwireTriggered",
  "ModelFallbackTriggered",
  "MemoryRetrieved",
]);
const TERMINAL_STATES = new Set<HarnessRunState>([
  "completed",
  "partial",
  "failed",
  "cancelled",
]);

export interface HarnessStatusRead {
  runId: string;
  state: HarnessRunState;
  attempt: number;
  outcome?: "completed" | "partial" | "failed" | "cancelled";
  outcomeReason?: string;
  egressPolicy?: "deny" | { allowlist: string[] };
  createdAt: string;
  updatedAt: string;
}

export interface HarnessEventRead {
  seq: number;
  type: string;
  payload: Record<string, unknown> | null;
}

export interface HarnessDeliverableRead {
  deliverableType: string;
  artifact: ArtifactRef;
}

export interface HarnessRunReadSnapshot {
  status: HarnessStatusRead;
  events: HarnessEventRead[];
  deliverables: HarnessDeliverableRead[];
}

export interface HarnessReadPort {
  readRun(binding: HarnessRunBinding): Promise<HarnessRunReadSnapshot>;
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

export class HarnessReadError extends Error {
  constructor(
    readonly code:
      | "cli_timeout"
      | "cli_failed"
      | "cli_output_too_large"
      | "run_not_started"
      | "status_malformed"
      | "status_identity_mismatch"
      | "unknown_run_state"
      | "unknown_event_type"
      | "events_malformed"
      | "deliverables_malformed",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HarnessReadError";
  }
}

export function createHarnessCliReadPort(options: {
  command?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  execute?: HarnessCommandExecutor;
} = {}): HarnessReadPort {
  const command = options.command?.trim() || "harness";
  if (path.basename(command) !== "harness") {
    throw new HarnessReadError(
      "cli_failed",
      "Harness adapter requires an executable named harness",
      false,
    );
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const execute = options.execute ?? executeHarnessCommand;

  return {
    async readRun(binding) {
      const [statusResult, eventsResult] = await Promise.all([
        runReadCommand(execute, command, ["run", "status", binding.harnessRunId], timeoutMs, maxOutputBytes),
        runReadCommand(execute, command, ["run", "events", binding.harnessRunId], timeoutMs, maxOutputBytes),
      ]);
      const status = parseHarnessStatus(statusResult.stdout, binding.harnessRunId);
      const events = parseHarnessEvents(eventsResult.stdout);
      const deliverables = status.outcome
        ? parseHarnessDeliverables(
            (
              await runReadCommand(
                execute,
                command,
                ["run", "deliverables", binding.harnessRunId],
                timeoutMs,
                maxOutputBytes,
              )
            ).stdout,
          )
        : [];
      return { status, events, deliverables };
    },
  };
}

async function runReadCommand(
  execute: HarnessCommandExecutor,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<HarnessCommandResult> {
  assertReadOnlyArgs(args);
  let result: HarnessCommandResult;
  try {
    result = await execute(command, args, { timeoutMs, maxOutputBytes });
  } catch (error) {
    if (error instanceof HarnessReadError) throw error;
    throw new HarnessReadError("cli_failed", "Harness read command could not be started", true);
  }
  if (result.code !== 0) {
    const safeDetail = safeCliFailureDetail(result.stderr);
    throw new HarnessReadError(
      "cli_failed",
      `Harness read command failed with exit ${result.code}${safeDetail ? `: ${safeDetail}` : ""}`,
      true,
    );
  }
  return result;
}

function assertReadOnlyArgs(args: readonly string[]): void {
  const verb = args[1];
  if (args.length !== 3 || args[0] !== "run"
      || (verb !== "status" && verb !== "events" && verb !== "deliverables")) {
    throw new HarnessReadError("cli_failed", "Harness adapter refused a non-read command", false);
  }
}

export function parseHarnessStatus(stdout: string, expectedRunId: string): HarnessStatusRead {
  const trimmed = stdout.trim();
  if (trimmed === "pending — no worker has started it" || trimmed === "pending - no worker has started it") {
    throw new HarnessReadError(
      "run_not_started",
      "Harness accepted the run id but no worker record is available yet",
      true,
    );
  }
  const allowedKeys = new Set([
    "run_id",
    "state",
    "attempt",
    "outcome",
    "outcome_reason",
    "egress_policy",
    "created_at",
    "updated_at",
  ]);
  const fields = new Map<string, string>();
  for (const line of nonEmptyLines(stdout)) {
    const delimiter = line.indexOf("=");
    if (delimiter <= 0) {
      throw new HarnessReadError("status_malformed", "Harness status response is malformed", false);
    }
    const key = line.slice(0, delimiter);
    const value = line.slice(delimiter + 1);
    if (!allowedKeys.has(key) || fields.has(key)) {
      throw new HarnessReadError(
        "status_malformed",
        "Harness status response contains an unsupported or duplicate field",
        false,
      );
    }
    fields.set(key, value);
  }

  const runId = requiredField(fields, "run_id");
  if (runId !== expectedRunId) {
    throw new HarnessReadError(
      "status_identity_mismatch",
      "Harness status response does not match the allowlisted run id",
      false,
    );
  }
  const stateResult = harnessRunStateSchema.safeParse(requiredField(fields, "state"));
  if (!stateResult.success) {
    throw new HarnessReadError(
      "unknown_run_state",
      "Harness returned an unsupported run state",
      false,
    );
  }
  const attempt = parseNonNegativeInteger(requiredField(fields, "attempt"), "attempt");
  const createdAt = parseTimestamp(requiredField(fields, "created_at"), "created_at");
  const updatedAt = parseTimestamp(requiredField(fields, "updated_at"), "updated_at");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new HarnessReadError(
      "status_malformed",
      "Harness status updated_at precedes created_at",
      false,
    );
  }
  const outcome = parseOutcome(fields.get("outcome"));
  if (TERMINAL_STATES.has(stateResult.data) && !outcome) {
    throw new HarnessReadError(
      "status_malformed",
      `Harness terminal state ${stateResult.data} is missing its outcome`,
      false,
    );
  }
  const outcomeReasonRaw = fields.get("outcome_reason");
  const outcomeReason = outcomeReasonRaw && outcomeReasonRaw !== "-" ? outcomeReasonRaw : undefined;
  const egressPolicy = parseEgressPolicy(fields.get("egress_policy"));

  return {
    runId,
    state: stateResult.data,
    attempt,
    ...(outcome ? { outcome } : {}),
    ...(outcomeReason ? { outcomeReason } : {}),
    ...(egressPolicy ? { egressPolicy } : {}),
    createdAt,
    updatedAt,
  };
}

export function parseHarnessEvents(stdout: string): HarnessEventRead[] {
  const result: HarnessEventRead[] = [];
  let lastSeq = -1;
  for (const line of nonEmptyLines(stdout)) {
    const match = /^([0-9]+) ([A-Za-z]+) payload=(.+)$/.exec(line);
    if (!match) {
      throw new HarnessReadError("events_malformed", "Harness events response is malformed", false);
    }
    const seq = parseNonNegativeInteger(match[1]!, "event sequence");
    if (seq <= lastSeq) {
      throw new HarnessReadError(
        "events_malformed",
        "Harness event sequences are not strictly increasing",
        false,
      );
    }
    const type = match[2]!;
    if (!ALLOWED_EVENT_TYPES.has(type)) {
      throw new HarnessReadError(
        "unknown_event_type",
        "Harness returned an unsupported event type",
        false,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(match[3]!);
    } catch {
      throw new HarnessReadError("events_malformed", "Harness event payload is not valid JSON", false);
    }
    if (payload !== null && (!payload || typeof payload !== "object" || Array.isArray(payload))) {
      throw new HarnessReadError("events_malformed", "Harness event payload has an unsupported shape", false);
    }
    result.push({ seq, type, payload: payload as Record<string, unknown> | null });
    lastSeq = seq;
  }
  return result;
}

export function parseHarnessDeliverables(stdout: string): HarnessDeliverableRead[] {
  const result: HarnessDeliverableRead[] = [];
  const seen = new Set<string>();
  for (const line of nonEmptyLines(stdout)) {
    const delimiter = line.indexOf(" ");
    if (delimiter <= 0) {
      throw new HarnessReadError(
        "deliverables_malformed",
        "Harness deliverables response is malformed",
        false,
      );
    }
    const deliverableType = line.slice(0, delimiter);
    const uri = line.slice(delimiter + 1).trim();
    const digest = /^artifact:\/\/sha256\/([a-f0-9]{64})$/.exec(uri)?.[1];
    if (!digest) {
      throw new HarnessReadError(
        "deliverables_malformed",
        "Harness deliverable has an unsupported artifact reference",
        false,
      );
    }
    const artifact = artifactRefSchema.parse({ uri, sha256: `sha256:${digest}` });
    const key = `${deliverableType}\0${artifact.uri}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ deliverableType, artifact });
  }
  return result;
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

    const finishWithError = (error: HarnessReadError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        finishWithError(
          new HarnessReadError(
            "cli_output_too_large",
            "Harness read response exceeded the configured output limit",
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
      finishWithError(new HarnessReadError("cli_failed", "Harness read command could not be started", true));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    const timer = setTimeout(() => {
      finishWithError(
        new HarnessReadError("cli_timeout", "Harness read command timed out", true),
      );
    }, timeoutMs);
    timer.unref();
  });

function requiredField(fields: ReadonlyMap<string, string>, key: string): string {
  const value = fields.get(key);
  if (!value) {
    throw new HarnessReadError("status_malformed", `Harness status response is missing ${key}`, false);
  }
  return value;
}

function parseNonNegativeInteger(value: string, field: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new HarnessReadError("status_malformed", `Harness ${field} is not a non-negative integer`, false);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HarnessReadError("status_malformed", `Harness ${field} exceeds the safe integer range`, false);
  }
  return parsed;
}

function parseTimestamp(value: string, field: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new HarnessReadError("status_malformed", `Harness ${field} is not a valid timestamp`, false);
  }
  return value;
}

function parseOutcome(value: string | undefined): HarnessStatusRead["outcome"] {
  if (!value) return undefined;
  if (value === "completed" || value === "partial" || value === "failed" || value === "cancelled") {
    return value;
  }
  throw new HarnessReadError("status_malformed", "Harness returned an unsupported outcome", false);
}

function parseEgressPolicy(value: string | undefined): HarnessStatusRead["egressPolicy"] {
  if (!value || value === "pending") return undefined;
  const match = /^(deny_all|allowlist) \[(.*)\]$/.exec(value);
  if (!match) {
    throw new HarnessReadError("status_malformed", "Harness egress policy is malformed", false);
  }
  const destinations = match[2] ? match[2].split(",").filter(Boolean) : [];
  if (match[1] === "deny_all") {
    if (destinations.length > 0) {
      throw new HarnessReadError("status_malformed", "Harness deny-all policy contains destinations", false);
    }
    return "deny";
  }
  if (destinations.length === 0) {
    throw new HarnessReadError("status_malformed", "Harness allowlist policy contains no destinations", false);
  }
  return { allowlist: destinations };
}

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function safeCliFailureDetail(stderr: string): string {
  const text = stderr.replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/schema missing/i.test(text)) return "Harness database schema is unavailable";
  if (/record not found|completed run not found/i.test(text)) return "Harness run record is unavailable";
  if (/configuration|connection/i.test(text)) return "Harness data source is unavailable";
  return "Harness data source refused the read";
}
