#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getRunBinding,
} from "../../packages/averray-mcp/dist/run-binding-outbox.js";
import {
  listAgentTasks,
} from "../../packages/averray-mcp/dist/agent-task-store.js";
import {
  createHarnessCliReadPort,
} from "../../packages/averray-mcp/dist/harness-read-port.js";
import {
  projectHarnessRun,
} from "../../packages/averray-mcp/dist/harness-run-projection.js";
import {
  agentTaskV1Schema,
  artifactRefSchema,
  assertVerifiedHandoffMatchesTaskAndRun,
} from "../../packages/schemas/dist/index.js";
import {
  createFilePrPayloadArtifactPort,
  createLocalGitPrPayloadRepositoryPort,
} from "../../services/harness-dispatcher/dist/pr-payload-local-ports.js";
import {
  actuatePullRequestPayload,
} from "../../services/harness-dispatcher/dist/pr-payload-actuator.js";
import {
  buildVerifiedHandoff,
} from "../../services/harness-dispatcher/dist/reconcile-run.js";

const DEFAULT_HALT_FILE = "/data/HALT";
const DEFAULT_READ_TIMEOUT_MS = 15_000;
const TOKEN_ENVIRONMENT_KEY = "GITHUB_INSTALLATION_TOKEN";

export const INT3D_EXIT = Object.freeze({
  ok: 0,
  usage: 64,
  tokenEnvironment: 65,
  authorizationInvalid: 66,
  authorizationContainsToken: 67,
  outputExists: 68,
  taskUnavailable: 69,
  bindingUnavailable: 70,
  runNotTerminal: 71,
  handoffIneligible: 72,
  haltGlobal: 73,
  haltRepository: 74,
  operationRefused: 75,
});

class Int3dBuilderError extends Error {
  constructor(name, exitCode, message) {
    super(message);
    this.name = "Int3dBuilderError";
    this.codeName = name;
    this.exitCode = exitCode;
  }
}

export async function runInt3dBuilder({
  argv,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies = {},
}) {
  try {
    // Check key presence without reading its value. The database-reading
    // builder must never share the sender's credential-bearing environment.
    if (Object.prototype.hasOwnProperty.call(env, TOKEN_ENVIRONMENT_KEY)) {
      fail(
        "INT3D_TOKEN_ENVIRONMENT_REFUSED",
        INT3D_EXIT.tokenEnvironment,
        `${TOKEN_ENVIRONMENT_KEY} must be absent from the builder environment`,
      );
    }

    const options = parseArguments(argv);
    await assertOutputAbsent(options.outputPath);
    const issuedAuthorization = await readTokenFreeAuthorization(
      options.authorizationPath,
    );

    const readHaltState = dependencies.readHaltState
      ?? (() => readOperatorHaltState(env));
    const initialHalt = await readHaltState();
    if (initialHalt.global) {
      fail(
        "INT3D_HALT_GLOBAL",
        INT3D_EXIT.haltGlobal,
        "global HALT is active",
      );
    }

    const listTasks = dependencies.listTasks ?? listAgentTasks;
    const task = await loadCurrentTask(options.workItemId, listTasks);
    if (initialHalt.repositories.some((candidate) =>
      candidate.toLowerCase() === task.repository.nameWithOwner.toLowerCase())) {
      fail(
        "INT3D_HALT_REPOSITORY",
        INT3D_EXIT.haltRepository,
        `repository HALT is active for ${task.repository.nameWithOwner}`,
      );
    }
    if (task.lifecycle !== "handoff_ready") {
      fail(
        "INT3D_HANDOFF_INELIGIBLE",
        INT3D_EXIT.handoffIneligible,
        `AgentTask lifecycle is ${task.lifecycle}, not handoff_ready`,
      );
    }

    const readBinding = dependencies.getRunBinding ?? getRunBinding;
    const binding = await readBinding(task.workItemId);
    if (!binding) {
      fail(
        "INT3D_BINDING_UNAVAILABLE",
        INT3D_EXIT.bindingUnavailable,
        "the work item has no durable Harness run binding",
      );
    }
    if (
      task.bindings?.harnessRunId
      && task.bindings.harnessRunId !== binding.harnessRunId
    ) {
      fail(
        "INT3D_BINDING_UNAVAILABLE",
        INT3D_EXIT.bindingUnavailable,
        "AgentTask and outbox Harness run bindings disagree",
      );
    }

    const readPort = dependencies.readPort ?? createHarnessCliReadPort({
      command: env.HARNESS_BIN?.trim() || "harness",
      timeoutMs: readTimeoutMs(env.HARNESS_DISPATCH_READ_TIMEOUT_MS),
    });
    const read = await readPort.readRun({
      harnessRunId: binding.harnessRunId,
    });
    if (read.status.runId !== binding.harnessRunId) {
      fail(
        "INT3D_BINDING_UNAVAILABLE",
        INT3D_EXIT.bindingUnavailable,
        "Harness snapshot identity does not match the durable run binding",
      );
    }
    if (read.status.outcome === undefined) {
      fail(
        "INT3D_RUN_NOT_TERMINAL",
        INT3D_EXIT.runNotTerminal,
        "the bound Harness run is not terminal",
      );
    }

    const now = dependencies.now?.() ?? new Date();
    const projection = projectHarnessRun(
      projectionBinding(task, binding, read),
      read,
      { now },
    );
    let handoff;
    try {
      handoff = buildVerifiedHandoff(task, projection, read, now);
      await assertVerifiedHandoffMatchesTaskAndRun(task, projection, handoff);
    } catch {
      fail(
        "INT3D_HANDOFF_INELIGIBLE",
        INT3D_EXIT.handoffIneligible,
        "the terminal run cannot produce a verified eligible handoff",
      );
    }
    if (handoff.eligibleForPrOpen !== true) {
      fail(
        "INT3D_HANDOFF_INELIGIBLE",
        INT3D_EXIT.handoffIneligible,
        "VerifiedHandoff eligibleForPrOpen is not true",
      );
    }

    const patchArtifacts = createFilePrPayloadArtifactPort(
      options.patchArtifactRoot,
    );
    const payloadArtifacts = createFilePrPayloadArtifactPort(
      options.payloadArtifactRoot,
    );
    let actuation;
    try {
      actuation = await actuatePullRequestPayload(
        { task, run: projection, handoff },
        {
          artifacts: {
            read: patchArtifacts.read,
            write: payloadArtifacts.write,
          },
          repository: createLocalGitPrPayloadRepositoryPort({
            repositoryRoot: options.repositoryRoot,
            repository: task.repository.nameWithOwner,
            baseRef: options.baseRef,
          }),
          readHaltState,
        },
      );
    } catch (error) {
      if (error?.reason === "halt_global") {
        fail("INT3D_HALT_GLOBAL", INT3D_EXIT.haltGlobal, "global HALT is active");
      }
      if (error?.reason === "halt_repository") {
        fail(
          "INT3D_HALT_REPOSITORY",
          INT3D_EXIT.haltRepository,
          `repository HALT is active for ${task.repository.nameWithOwner}`,
        );
      }
      throw error;
    }

    const packet = {
      schemaVersion: 1,
      kind: "int3c_operator_handoff",
      handoff,
      actuation,
      issuedAuthorization,
    };
    await writeNewFileAtomically(
      options.outputPath,
      `${JSON.stringify(packet, null, 2)}\n`,
    );
    stdout.write(`INT3D_PACKET_BUILT out=${options.outputPath}\n`);
    return INT3D_EXIT.ok;
  } catch (error) {
    if (error instanceof Int3dBuilderError) {
      stderr.write(`${error.codeName}: ${error.message}\n`);
      return error.exitCode;
    }
    stderr.write("INT3D_OPERATION_REFUSED: packet construction failed\n");
    return INT3D_EXIT.operationRefused;
  }
}

function parseArguments(argv) {
  const names = new Map([
    ["--work-item", "workItemId"],
    ["--repository-root", "repositoryRoot"],
    ["--base-ref", "baseRef"],
    ["--patch-artifact-root", "patchArtifactRoot"],
    ["--payload-artifact-root", "payloadArtifactRoot"],
    ["--authorization", "authorizationPath"],
    ["--out", "outputPath"],
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const name = names.get(flag);
    if (!name || typeof value !== "string" || !value.trim() || name in values) {
      fail(
        "INT3D_USAGE",
        INT3D_EXIT.usage,
        "all packet-builder arguments are required exactly once",
      );
    }
    values[name] = value.trim();
  }
  if (Object.keys(values).length !== names.size) {
    fail(
      "INT3D_USAGE",
      INT3D_EXIT.usage,
      "all packet-builder arguments are required exactly once",
    );
  }
  return {
    workItemId: values.workItemId,
    repositoryRoot: path.resolve(values.repositoryRoot),
    baseRef: values.baseRef,
    patchArtifactRoot: path.resolve(values.patchArtifactRoot),
    payloadArtifactRoot: path.resolve(values.payloadArtifactRoot),
    authorizationPath: path.resolve(values.authorizationPath),
    outputPath: path.resolve(values.outputPath),
  };
}

async function assertOutputAbsent(target) {
  try {
    await access(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  fail(
    "INT3D_OUTPUT_EXISTS",
    INT3D_EXIT.outputExists,
    "--out already exists and will not be overwritten",
  );
}

async function readTokenFreeAuthorization(target) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch {
    fail(
      "INT3D_AUTHORIZATION_INVALID",
      INT3D_EXIT.authorizationInvalid,
      "authorization metadata is unavailable or is not JSON",
    );
  }
  if (containsTokenKey(parsed)) {
    fail(
      "INT3D_AUTHORIZATION_CONTAINS_TOKEN",
      INT3D_EXIT.authorizationContainsToken,
      "authorization metadata contains a token key",
    );
  }
  if (!isRecord(parsed)) {
    fail(
      "INT3D_AUTHORIZATION_INVALID",
      INT3D_EXIT.authorizationInvalid,
      "authorization metadata must be an object",
    );
  }
  return parsed;
}

function containsTokenKey(value) {
  if (Array.isArray(value)) return value.some(containsTokenKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) =>
    key.toLowerCase() === "token" || containsTokenKey(nested));
}

async function loadCurrentTask(workItemId, listTasks) {
  let tasks;
  try {
    tasks = await listTasks({ workItemId, limit: 1_000 });
  } catch {
    fail(
      "INT3D_TASK_UNAVAILABLE",
      INT3D_EXIT.taskUnavailable,
      "AgentTask could not be read from the dispatcher store",
    );
  }
  const matching = tasks
    .map((candidate) => agentTaskV1Schema.parse(candidate))
    .filter((candidate) => candidate.workItemId === workItemId)
    .sort((left, right) => right.taskVersion - left.taskVersion);
  const task = matching[0];
  if (!task) {
    fail(
      "INT3D_TASK_UNAVAILABLE",
      INT3D_EXIT.taskUnavailable,
      `no AgentTask exists for work item ${workItemId}`,
    );
  }
  return task;
}

function projectionBinding(task, binding, read) {
  const manifestRef = task.bindings?.runManifestRef
    ?? binding.runManifestRef
    ?? manifestRefFromRead(read);
  const manifestHash = task.bindings?.runManifestHash
    ?? binding.runManifestHash
    ?? manifestRef?.sha256;
  if (!manifestHash) {
    fail(
      "INT3D_BINDING_UNAVAILABLE",
      INT3D_EXIT.bindingUnavailable,
      "the terminal run has no immutable manifest binding",
    );
  }

  const observedCapabilities = read.events.flatMap((event) => {
    if (event.type !== "CapabilityDispatched") return [];
    const capability = stringField(event.payload, "capability")
      ?? stringField(event.payload, "capability_id");
    return capability ? [capability] : [];
  });
  const modelBindings = new Map();
  for (const event of read.events) {
    if (event.type !== "ModelRequested") continue;
    const role = stringField(event.payload, "role");
    const modelRef = stringField(event.payload, "model_ref");
    if (!role || !modelRef || modelBindings.has(role)) continue;
    modelBindings.set(role, {
      role,
      adapter: "harness-observed",
      provider: "harness-observed",
      modelRef,
      profileHash: task.approval.policyHash,
    });
  }

  return {
    workItemId: task.workItemId,
    correlationId: task.correlationId,
    harnessRunId: binding.harnessRunId,
    taskVersion: task.taskVersion,
    repository: task.repository.nameWithOwner,
    title: task.proposal.title,
    summary: task.proposal.objective,
    registeredAt: task.timestamps.runBoundAt
      ?? binding.boundAt
      ?? task.timestamps.dispatchClaimedAt
      ?? task.timestamps.updatedAt,
    staleAfterSeconds: 300,
    manifest: {
      ...(manifestRef ? { ref: manifestRef } : {}),
      hash: manifestHash,
      profile: task.intent.profile,
      riskClass: riskClassForTask(task),
      effectiveCapabilities: [...new Set([
        ...task.requestedAuthority.grants.map((grant) => grant.capabilityId),
        ...observedCapabilities,
      ])],
      network: read.status.egressPolicy ?? task.requestedAuthority.network,
      policyHash: task.approval.policyHash,
      verifierHash: task.acceptance.verifierPlanHash,
      modelBindings: [...modelBindings.values()],
      skillVersions: [],
    },
    budget: {
      elapsedSecondsLimit: task.budget.elapsedSeconds,
      modelTokensLimit: task.budget.modelTokens,
      toolCallsLimit: task.budget.toolCalls,
      estimatedUsdMicrosLimit: task.budget.estimatedUsdMicros,
    },
    ...(task.bindings?.averrayJobId
      ? { averrayJobId: task.bindings.averrayJobId }
      : {}),
    ...(task.bindings?.averraySessionId
      ? { averraySessionId: task.bindings.averraySessionId }
      : {}),
    ...(task.bindings?.pullRequest
      ? { pullRequest: task.bindings.pullRequest }
      : {}),
  };
}

function manifestRefFromRead(read) {
  for (const event of [...read.events].reverse()) {
    if (event.type !== "EnvironmentPrepared") continue;
    const hash = stringField(event.payload, "manifest_hash");
    const digest = /^sha256:([a-f0-9]{64})$/u.exec(hash ?? "")?.[1];
    if (!digest) continue;
    return artifactRefSchema.parse({
      uri: `artifact://sha256/${digest}`,
      sha256: `sha256:${digest}`,
      mediaType: "application/json",
    });
  }
  return undefined;
}

function riskClassForTask(task) {
  if (task.risk.tier === "low") return "low";
  if (task.risk.tier === "medium") return "standard";
  return "elevated";
}

function stringField(record, key) {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readOperatorHaltState(env) {
  const globalPath = env.HALT_FILE?.trim() || DEFAULT_HALT_FILE;
  const global = await fileExists(globalPath);
  const repositoryPath = env.HARNESS_REPOSITORY_HALT_FILE?.trim();
  let repositories = [];
  if (repositoryPath && await fileExists(repositoryPath)) {
    repositories = (await readFile(repositoryPath, "utf8"))
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && !value.startsWith("#"));
  }
  return { global, repositories };
}

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function readTimeoutMs(value) {
  if (value === undefined || value.trim() === "") return DEFAULT_READ_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_READ_TIMEOUT_MS;
}

async function writeNewFileAtomically(target, contents) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await link(temporary, target);
  } catch (error) {
    if (error?.code === "EEXIST") {
      fail(
        "INT3D_OUTPUT_EXISTS",
        INT3D_EXIT.outputExists,
        "--out already exists and will not be overwritten",
      );
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(name, exitCode, message) {
  throw new Int3dBuilderError(name, exitCode, message);
}

async function main() {
  process.exitCode = await runInt3dBuilder({ argv: process.argv.slice(2) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
