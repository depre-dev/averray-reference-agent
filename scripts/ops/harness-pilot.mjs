#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FIXTURES = new Set([
  "first-send",
  "docs-fix",
  "add-unit-test",
  "small-refactor",
  "lint-format",
  "lint-format-paid",
  "lint-format-green",
  "lint-format-budget-overrun",
  "lint-format-red",
]);
const POLICY_VERSION = "dispatch-policy-v1";
const DEFAULT_ALERTS_PATH = "/data/harness-dispatch-alerts.jsonl";
const DEFAULT_CANCEL_REASON =
  "Operator cancelled the supervised Harness pilot task.";
const STATUS_LIMIT = 20;
const SECRET_KEY =
  /(authorization|bearer|cookie|credential|dsn|mnemonic|password|private.?key|secret|token|webhook|api.?key)/iu;
const DSN =
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis):\/\/[^\s"',}]+/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu;
const SECRET_ASSIGNMENT =
  /\b(?:authorization|credential|mnemonic|password|private[_ -]?key|secret|token|webhook|api[_ -]?key)\s*[:=]\s*[^\s"',;}]+/giu;
const SECRET_TOKEN =
  /\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/gu;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "../..");

export function parsePilotArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new PilotCliError("arguments must be an array");
  }
  if (argv.length === 0) {
    throw new PilotCliError("a subcommand is required; use --help for usage");
  }
  if (argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length !== 1) {
      throw new PilotCliError("--help does not accept other arguments");
    }
    return { command: "help" };
  }

  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case "propose": {
      const options = parseOptions(rest, {
        values: ["fixture", "work-item", "deadline"],
      });
      const fixture = requiredOption(options, "fixture");
      if (!FIXTURES.has(fixture)) {
        throw new PilotCliError(
          `--fixture must be one of: ${[...FIXTURES].join(", ")}`,
        );
      }
      return {
        command,
        fixture,
        ...(options["work-item"]
          ? { workItemId: nonEmpty(options["work-item"], "--work-item") }
          : {}),
        ...(options.deadline
          ? { deadline: canonicalTimestamp(options.deadline, "--deadline") }
          : {}),
      };
    }
    case "approve":
    case "cancel": {
      const options = parseOptions(rest, {
        values: command === "approve"
          ? ["work-item", "version", "operator"]
          : ["work-item", "version", "operator", "reason"],
        booleans: ["confirm"],
      });
      return {
        command,
        workItemId: nonEmpty(
          requiredOption(options, "work-item"),
          "--work-item",
        ),
        taskVersion: positiveInteger(
          requiredOption(options, "version"),
          "--version",
        ),
        actorType: "operator",
        operatorId: nonEmpty(
          requiredOption(options, "operator"),
          "--operator",
        ),
        confirm: options.confirm === true,
        ...(command === "cancel"
          ? {
              reason: options.reason
                ? nonEmpty(options.reason, "--reason")
                : DEFAULT_CANCEL_REASON,
            }
          : {}),
      };
    }
    case "status": {
      const options = parseOptions(rest, {
        values: ["work-item"],
      });
      return {
        command,
        ...(options["work-item"]
          ? {
              workItemId: nonEmpty(
                options["work-item"],
                "--work-item",
              ),
            }
          : {}),
      };
    }
    default:
      throw new PilotCliError(
        `unknown subcommand ${JSON.stringify(command)}; use --help for usage`,
      );
  }
}

export async function runPilotCli(argv, options = {}) {
  const output = options.output ?? ((line) => process.stdout.write(line));
  const errorOutput =
    options.errorOutput ?? ((line) => process.stderr.write(line));
  const context = {
    environment: options.environment ?? process.env,
    output,
    services: options.services,
    defaultServices: undefined,
  };

  try {
    const command = parsePilotArgs(argv);
    await executePilotCommand(command, context);
    return 0;
  } catch (error) {
    errorOutput(`harness-pilot: ${readableError(error)}\n`);
    return 1;
  } finally {
    const services = context.defaultServices;
    if (services?.close) {
      await services.close().catch(() => undefined);
    }
  }
}

export async function executePilotCommand(command, context) {
  switch (command.command) {
    case "help":
      context.output(`${helpText()}\n`);
      return;
    case "propose":
      await handlePropose(command, context);
      return;
    case "approve":
      await handleApprove(command, context);
      return;
    case "cancel":
      await handleCancel(command, context);
      return;
    case "status":
      await handleStatus(command, context);
      return;
    default:
      throw new PilotCliError("unsupported command");
  }
}

export async function handlePropose(command, context) {
  requireEnvironment(context.environment, [
    "DATABASE_URL",
    "HARNESS_DISPATCH_ARTIFACT_DIR",
  ]);
  const services = await resolveServices(context);
  const fixture = await services.loadFixture(command.fixture);
  const workItemId = command.workItemId ?? fixture.workItemId;
  const input = {
    ...fixture,
    workItemId,
    correlationId: command.workItemId
      ? workItemId
      : fixture.correlationId,
    ...(command.deadline ? { deadline: command.deadline } : {}),
  };
  const task = await services.proposeAgentTask(input);
  if (
    task.lifecycle !== "proposed"
    || task.approval?.status !== "pending"
    || task.approval?.approvedTaskHash !== undefined
  ) {
    throw new PilotCliError(
      "proposal refused because it did not remain pending operator approval",
    );
  }

  writeResult(context, {
    operation: "propose",
    lifecycle: task.lifecycle,
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    templateHash: task.intent.templateHash,
    verifierPlanHash: task.acceptance.verifierPlanHash,
    workspacePath: services.workspacePathForTask(
      task.workItemId,
      task.taskVersion,
    ),
    submissionAttemptedByCli: false,
  });
}

export async function handleApprove(command, context) {
  assertConfirmedOperatorCommand(command, "approval");
  requireEnvironment(context.environment, ["DATABASE_URL"]);
  const services = await resolveServices(context);
  const task = await services.approveAgentTask({
    workItemId: command.workItemId,
    taskVersion: command.taskVersion,
    actor: {
      type: "operator",
      id: command.operatorId,
    },
  });
  const approvedTaskHash = task.approval?.approvedTaskHash;
  if (
    task.lifecycle !== "approved"
    || typeof approvedTaskHash !== "string"
    || approvedTaskHash.length === 0
  ) {
    throw new PilotCliError(
      "approval did not produce a durable approved task hash",
    );
  }

  writeResult(context, {
    operation: "approve",
    lifecycle: task.lifecycle,
    workItemId: task.workItemId,
    taskVersion: task.taskVersion,
    approvedTaskHash,
    intendedRunId: services.deriveIntendedRunId(
      task.workItemId,
      task.taskVersion,
      approvedTaskHash,
    ),
    submissionAttemptedByCli: false,
  });
}

export async function handleCancel(command, context) {
  assertConfirmedOperatorCommand(command, "cancellation");
  requireEnvironment(context.environment, ["DATABASE_URL"]);
  const services = await resolveServices(context);
  const result = await services.cancelAgentTask({
    workItemId: command.workItemId,
    taskVersion: command.taskVersion,
    actor: {
      type: "operator",
      id: command.operatorId,
    },
    reason: command.reason,
  });
  writeResult(context, {
    operation: "cancel",
    lifecycle: result.task.lifecycle,
    workItemId: result.task.workItemId,
    taskVersion: result.task.taskVersion,
    harnessCancelAcknowledged: result.harnessAcknowledged === true,
    submissionAttemptedByCli: false,
  });
}

export async function handleStatus(command, context) {
  requireEnvironment(context.environment, ["DATABASE_URL"]);
  const services = await resolveServices(context);
  const [tasks, decisions, heartbeat, alerts] = await Promise.all([
    services.listAgentTasks({
      ...(command.workItemId ? { workItemId: command.workItemId } : {}),
      limit: 1_000,
    }),
    services.listHermesDecisions({
      ...(command.workItemId ? { workItemId: command.workItemId } : {}),
      limit: STATUS_LIMIT,
    }),
    readHeartbeat(context.environment, services.readTextFile),
    readAlerts(context.environment, services.readTextFile),
  ]);

  writeResult(context, {
    operation: "status",
    readOnly: true,
    tasks: tasks.map((task) => ({
      workItemId: task.workItemId,
      taskVersion: task.taskVersion,
      lifecycle: task.lifecycle,
      bindings: {
        harnessRunId: task.bindings?.harnessRunId ?? null,
      },
    })),
    dispatcherHeartbeat: heartbeat,
    recentDecisions: decisions.map(decisionStatusView),
    alerts,
    submissionAttemptedByCli: false,
  });
}

async function createDefaultServices(environment) {
  const [
    proposal,
    taskStore,
    policy,
    workspace,
    dispatchClaim,
    decisionStore,
    readPortModule,
    cancellation,
    control,
    alerts,
    common,
  ] = await Promise.all([
    import("../../packages/averray-mcp/dist/agent-task-proposal.js"),
    import("../../packages/averray-mcp/dist/agent-task-store.js"),
    import("../../packages/averray-mcp/dist/dispatch-policy.js"),
    import("../../packages/averray-mcp/dist/workspace-path.js"),
    import("../../packages/averray-mcp/dist/dispatch-claim.js"),
    import("../../packages/averray-mcp/dist/decision-record-store.js"),
    import("../../packages/averray-mcp/dist/harness-read-port.js"),
    import("../../services/harness-dispatcher/dist/cancel-task.js"),
    import("../../services/harness-dispatcher/dist/harness-control-port.js"),
    import("../../services/harness-dispatcher/dist/alerts.js"),
    import("../../packages/mcp-common/dist/index.js"),
  ]);

  return {
    async loadFixture(fixture) {
      const target = path.join(
        REPOSITORY_ROOT,
        "test",
        "fixtures",
        "agent-integration",
        "ceremony",
        `${fixture}.json`,
      );
      return JSON.parse(await readFile(target, "utf8"));
    },
    proposeAgentTask(input) {
      return proposal.proposeAgentTask(input, {
        policyConfig: policy.loadDispatchPolicyConfig(environment),
        policyVersion: POLICY_VERSION,
        environment,
      });
    },
    approveAgentTask: proposal.approveAgentTask,
    async cancelAgentTask(input) {
      let harnessAcknowledged = true;
      const persistedAlertSink = alerts.createDispatchAlertSink({
        environment,
        logger: { warn() {} },
      });
      const alertSink = async (alert) => {
        if (alert.code === "cancel_unacknowledged") {
          harnessAcknowledged = false;
        }
        await persistedAlertSink(alert);
      };
      const command = environment.HARNESS_BIN?.trim() || "harness";
      const task = await cancellation.cancelAgentTask(input, {
        readPort: readPortModule.createHarnessCliReadPort({ command }),
        controlPort: control.createHarnessControlPort({
          command,
          enabled: false,
        }),
        alertSink,
      });
      return { task, harnessAcknowledged };
    },
    listAgentTasks: taskStore.listAgentTasks,
    listHermesDecisions: decisionStore.listHermesDecisions,
    workspacePathForTask: workspace.workspacePathForTask,
    deriveIntendedRunId: dispatchClaim.deriveIntendedRunId,
    readTextFile: (target) => readFile(target, "utf8"),
    close: common.closePool,
  };
}

async function resolveServices(context) {
  if (context.services) return context.services;
  context.defaultServices ??= await createDefaultServices(
    context.environment,
  );
  return context.defaultServices;
}

function parseOptions(argv, specification) {
  const values = new Set(specification.values ?? []);
  const booleans = new Set(specification.booleans ?? []);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new PilotCliError(
        `unexpected positional argument ${JSON.stringify(argument)}`,
      );
    }
    const name = argument.slice(2);
    if (Object.hasOwn(parsed, name)) {
      throw new PilotCliError(`--${name} may be supplied only once`);
    }
    if (booleans.has(name)) {
      parsed[name] = true;
      continue;
    }
    if (!values.has(name)) {
      throw new PilotCliError(`unknown option --${name}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new PilotCliError(`--${name} requires a value`);
    }
    parsed[name] = value;
    index += 1;
  }
  return parsed;
}

function requiredOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new PilotCliError(`--${name} is required`);
  }
  return value;
}

function nonEmpty(value, label) {
  const normalized = String(value).trim();
  if (!normalized) {
    throw new PilotCliError(`${label} must not be empty`);
  }
  return normalized;
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new PilotCliError(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new PilotCliError(`${label} must be a safe integer`);
  }
  return parsed;
}

function canonicalTimestamp(value, label) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !/[zZ]|[+-][0-9]{2}:[0-9]{2}$/u.test(value)) {
    throw new PilotCliError(`${label} must be an ISO-8601 timestamp with a timezone`);
  }
  return new Date(timestamp).toISOString();
}

function assertConfirmedOperatorCommand(command, operation) {
  if (command.confirm !== true) {
    throw new PilotCliError(
      `${operation} refused: repeat the command with the exact --confirm flag`,
    );
  }
  if (command.actorType !== "operator") {
    throw new PilotCliError(
      `${operation} refused: actor type must be operator`,
    );
  }
}

function requireEnvironment(environment, names) {
  for (const name of names) {
    if (!environment[name]?.trim()) {
      throw new PilotCliError(`${name} is required`);
    }
  }
}

async function readHeartbeat(environment, readTextFile) {
  const configured = environment.HARNESS_DISPATCH_HEARTBEAT_PATH?.trim();
  if (!configured) {
    return {
      available: false,
      status: "unavailable",
      lastOutcome: null,
      reason: "HARNESS_DISPATCH_HEARTBEAT_PATH is unset",
    };
  }
  try {
    const value = JSON.parse(await readTextFile(path.resolve(configured)));
    return {
      available: true,
      status: safeScalar(value.status),
      lastOutcome: safeScalar(value.lastOutcome),
      updatedAt: safeScalar(value.updatedAt),
      reconciledCount: Number.isSafeInteger(value.reconciledCount)
        ? value.reconciledCount
        : null,
    };
  } catch {
    return {
      available: false,
      status: "unavailable",
      lastOutcome: null,
      reason: "dispatcher heartbeat is unreadable",
    };
  }
}

async function readAlerts(environment, readTextFile) {
  const configured =
    environment.HARNESS_DISPATCH_ALERTS_PATH?.trim() || DEFAULT_ALERTS_PATH;
  try {
    const lines = (await readTextFile(path.resolve(configured)))
      .split(/\r?\n/u)
      .filter(Boolean)
      .slice(-STATUS_LIMIT);
    return lines.flatMap((line) => {
      try {
        const alert = JSON.parse(line);
        return [{
          severity: safeScalar(alert.severity),
          code: safeScalar(alert.code),
          workItemId: safeScalar(alert.workItemId),
          taskVersion: Number.isSafeInteger(alert.taskVersion)
            ? alert.taskVersion
            : null,
          harnessRunId: safeScalar(alert.harnessRunId),
          message: safeScalar(alert.message),
          at: safeScalar(alert.at),
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function decisionStatusView(record) {
  return {
    decisionId: safeScalar(record.decisionId),
    correlationId: safeScalar(record.correlationId),
    workItemId: safeScalar(record.workItemId),
    decisionType: safeScalar(record.decisionType),
    approvalDecision: safeScalar(record.approval?.decision),
    mutates: record.effects?.mutates === true,
    authorityChanged: record.effects?.authorityChanged === true,
    nextAction: safeScalar(record.next?.action),
    generatedAt: safeScalar(record.generatedAt),
  };
}

function safeScalar(value) {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return null;
}

function writeResult(context, value) {
  context.output(`${JSON.stringify(sanitizeValue(value), null, 2)}\n`);
}

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 1_000).map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        SECRET_KEY.test(key) ? "[redacted]" : sanitizeValue(field),
      ]),
    );
  }
  if (typeof value === "string") return redactText(value);
  if (
    typeof value === "number"
    || typeof value === "boolean"
    || value === null
  ) {
    return value;
  }
  return null;
}

function redactText(value) {
  return value
    .replace(DSN, "[redacted-dsn]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT, "[redacted-secret]")
    .replace(SECRET_TOKEN, "[redacted-secret]")
    .slice(0, 2_000);
}

function readableError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(message || "command failed");
}

function helpText() {
  return `Usage: node scripts/ops/harness-pilot.mjs <subcommand> [options]

Human-operated supervised-pilot commands:
  propose --fixture <docs-fix|add-unit-test|small-refactor|lint-format|lint-format-green|lint-format-budget-overrun|lint-format-red>
          [--work-item <id>] [--deadline <iso>]
  approve --work-item <id> --version <n> --operator <id> --confirm
  cancel  --work-item <id> --version <n> --operator <id> --confirm
          [--reason <text>]
  status  [--work-item <id>]

Propose never approves. Approve and cancel refuse without the exact --confirm
flag. This CLI never submits a Harness run and never opens a pull request.`;
}

export class PilotCliError extends Error {
  constructor(message) {
    super(message);
    this.name = "PilotCliError";
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runPilotCli(process.argv.slice(2));
}
