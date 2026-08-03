#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  artifactRefSchema,
  canonicalContractJson,
  pullRequestPayloadV1Schema,
  verifiedHandoffV1Schema,
} from "../../packages/schemas/dist/index.js";
import {
  createGitHubPrClient,
} from "../../services/harness-dispatcher/dist/pr-payload-github-client.js";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const DEFAULT_HALT_FILE = "/data/HALT";

export const INT3C_EXIT = Object.freeze({
  ok: 0,
  usage: 64,
  inputInvalid: 65,
  tokenUnavailable: 66,
  confirmationRequired: 67,
  handoffIneligible: 68,
  haltGlobal: 69,
  haltRepository: 70,
  operationRefused: 71,
  evidenceFailed: 72,
});

class Int3cDriverError extends Error {
  constructor(name, exitCode, message) {
    super(message);
    this.name = "Int3cDriverError";
    this.codeName = name;
    this.exitCode = exitCode;
  }
}

export async function runInt3cDriver({
  argv,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  dependencies = {},
}) {
  try {
    const options = parseArguments(argv);
    const installationToken = env.GITHUB_INSTALLATION_TOKEN?.trim();
    if (!installationToken) {
      fail(
        "INT3C_TOKEN_UNAVAILABLE",
        INT3C_EXIT.tokenUnavailable,
        "GITHUB_INSTALLATION_TOKEN is absent or empty",
      );
    }
    if (
      options.verb === "send"
      && options.confirm !== options.repository
    ) {
      fail(
        "INT3C_CONFIRMATION_REQUIRED",
        INT3C_EXIT.confirmationRequired,
        "--confirm must exactly repeat --repo for send",
      );
    }

    const packet = await loadAndValidatePacket(options.handoffPath);
    if (packet.actuation.payload.repository !== options.repository) {
      fail(
        "INT3C_INPUT_INVALID",
        INT3C_EXIT.inputInvalid,
        "--repo does not match the pinned payload repository",
      );
    }
    if (packet.handoff.eligibleForPrOpen !== true) {
      fail(
        "INT3C_HANDOFF_INELIGIBLE",
        INT3C_EXIT.handoffIneligible,
        "VerifiedHandoff eligibleForPrOpen is not true",
      );
    }

    const readHaltState = dependencies.readHaltState
      ?? (() => readOperatorHaltState(env));
    const halt = await readHaltState();
    assertHaltClear(halt, options.repository);

    const safeAuthorization = safeIssuedAuthorization(
      packet.issuedAuthorization,
    );
    const createClient = dependencies.createGitHubClient
      ?? ((config) => createGitHubPrClient(config));
    const liveClient = createClient({
      repository: options.repository,
      installationToken,
      issuedAuthorization: safeAuthorization,
    });
    const observed = createObservedGitHubClient(liveClient);
    const senderDeps = {
      github: observed.github,
      readHaltState,
    };
    const operation = dependencies.operation
      ?? await loadOperation(options.verb);
    const result = await operation(packet.actuation, senderDeps);
    const evidence = buildEvidence(
      options.verb,
      packet.actuation,
      result,
      observed.state,
    );
    await writeEvidence(options.evidencePath, evidence);
    stdout.write(
      `INT3C_${options.verb.toUpperCase()}_${String(result.outcome).toUpperCase()} evidence=${options.evidencePath}\n`,
    );
    return INT3C_EXIT.ok;
  } catch (error) {
    if (error instanceof Int3cDriverError) {
      stderr.write(`${error.codeName}: ${error.message}\n`);
      return error.exitCode;
    }
    const reason = typeof error === "object"
      && error !== null
      && "reason" in error
      && typeof error.reason === "string"
      ? error.reason
      : "operation_failed";
    stderr.write(
      `INT3C_OPERATION_REFUSED: ${reason}\n`,
    );
    return INT3C_EXIT.operationRefused;
  }
}

function parseArguments(argv) {
  const [verb, ...tokens] = argv;
  if (verb !== "preflight" && verb !== "send") {
    fail(
      "INT3C_USAGE",
      INT3C_EXIT.usage,
      "first argument must be preflight or send",
    );
  }
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (
      !name?.startsWith("--")
      || value === undefined
      || value.startsWith("--")
      || values.has(name)
    ) {
      fail(
        "INT3C_USAGE",
        INT3C_EXIT.usage,
        "arguments must be unique --name value pairs",
      );
    }
    values.set(name, value);
  }
  const allowed = new Set([
    "--handoff",
    "--repo",
    "--evidence",
    ...(verb === "send" ? ["--confirm"] : []),
  ]);
  const unknown = [...values.keys()].find((key) => !allowed.has(key));
  if (unknown) {
    fail("INT3C_USAGE", INT3C_EXIT.usage, `unsupported argument ${unknown}`);
  }
  const handoffPath = values.get("--handoff");
  const repository = values.get("--repo");
  const evidencePath = values.get("--evidence");
  if (
    !handoffPath
    || !repository
    || !evidencePath
    || !REPOSITORY.test(repository)
  ) {
    fail(
      "INT3C_USAGE",
      INT3C_EXIT.usage,
      "--handoff, --repo owner/name, and --evidence are required",
    );
  }
  return {
    verb,
    handoffPath: path.resolve(handoffPath),
    repository,
    evidencePath: path.resolve(evidencePath),
    confirm: values.get("--confirm"),
  };
}

async function loadAndValidatePacket(packetPath) {
  let input;
  try {
    input = JSON.parse(await readFile(packetPath, "utf8"));
  } catch {
    fail(
      "INT3C_INPUT_INVALID",
      INT3C_EXIT.inputInvalid,
      "handoff packet is unavailable or is not JSON",
    );
  }
  if (!isRecord(input)) {
    fail(
      "INT3C_INPUT_INVALID",
      INT3C_EXIT.inputInvalid,
      "handoff packet must be an object",
    );
  }
  if (
    input.schemaVersion !== 1
    || input.kind !== "int3c_operator_handoff"
    || !isRecord(input.actuation)
    || !isRecord(input.issuedAuthorization)
  ) {
    fail(
      "INT3C_INPUT_INVALID",
      INT3C_EXIT.inputInvalid,
      "handoff packet contract is invalid",
    );
  }
  let handoff;
  let artifact;
  let payload;
  try {
    handoff = verifiedHandoffV1Schema.parse(input.handoff);
    artifact = artifactRefSchema.parse(input.actuation.artifact);
    payload = pullRequestPayloadV1Schema.parse(input.actuation.payload);
  } catch {
    fail(
      "INT3C_INPUT_INVALID",
      INT3C_EXIT.inputInvalid,
      "handoff packet typed contracts are invalid",
    );
  }
  const canonicalBytes = canonicalContractJson(payload);
  if (input.actuation.canonicalBytes !== canonicalBytes) {
    fail(
      "INT3C_INPUT_INVALID",
      INT3C_EXIT.inputInvalid,
      "payload canonical bytes do not match the typed payload",
    );
  }
  const digest = `sha256:${createHash("sha256")
    .update(canonicalBytes, "utf8")
    .digest("hex")}`;
  if (
    artifact.sha256 !== digest
    || artifact.uri !== `artifact://sha256/${digest.slice("sha256:".length)}`
    || (artifact.sizeBytes !== undefined
      && artifact.sizeBytes !== Buffer.byteLength(canonicalBytes, "utf8"))
  ) {
    fail(
      "INT3C_INPUT_INVALID",
      INT3C_EXIT.inputInvalid,
      "payload artifact content identity does not match",
    );
  }
  assertHandoffPayloadBinding(handoff, payload);
  return {
    handoff,
    actuation: { artifact, payload, canonicalBytes },
    issuedAuthorization: input.issuedAuthorization,
  };
}

function assertHandoffPayloadBinding(handoff, payload) {
  const patchRef = handoff.deliverables.patchRef;
  if (
    payload.source.workItemId !== handoff.workItemId
    || payload.source.taskVersion !== handoff.taskVersion
    || payload.source.approvedTaskHash !== handoff.taskHash
    || payload.source.harnessRunId !== handoff.harnessRunId
    || payload.source.verificationDecisionHash !== handoff.verification.decisionHash
    || !patchRef
    || payload.patch.ref.sha256 !== patchRef.sha256
  ) {
    fail(
      "INT3C_INPUT_INVALID",
      INT3C_EXIT.inputInvalid,
      "handoff and payload identity bindings disagree",
    );
  }
}

function safeIssuedAuthorization(input) {
  const permissions = isRecord(input.permissions) ? input.permissions : {};
  const extraWriteScopes = Array.isArray(permissions.extraWriteScopes)
    && permissions.extraWriteScopes.every((value) => typeof value === "string")
    ? [...permissions.extraWriteScopes]
    : undefined;
  if (
    typeof input.identity !== "string"
    || input.identity.trim().length === 0
    || (
      input.repositorySelection !== "selected"
      && input.repositorySelection !== "all"
    )
    || !["read", "write", "none"].includes(permissions.contents)
    || !["read", "write", "none"].includes(permissions.pullRequests)
    || extraWriteScopes === undefined
  ) {
    fail(
      "INT3C_INPUT_INVALID",
      INT3C_EXIT.inputInvalid,
      "token-free issuance metadata is invalid",
    );
  }
  return {
    identity: input.identity,
    repositorySelection: input.repositorySelection,
    permissions: {
      contents: permissions.contents,
      pullRequests: permissions.pullRequests,
      extraWriteScopes,
    },
  };
}

async function readOperatorHaltState(env) {
  const globalPath = env.HALT_FILE?.trim() || DEFAULT_HALT_FILE;
  const global = await fileExists(globalPath);
  const repositoryPath = env.HARNESS_REPOSITORY_HALT_FILE?.trim();
  let repositories = [];
  if (repositoryPath && await fileExists(repositoryPath)) {
    const contents = await readFile(repositoryPath, "utf8");
    repositories = contents
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  }
  return { global, repositories };
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertHaltClear(halt, repository) {
  if (halt.global) {
    fail("INT3C_HALT_GLOBAL", INT3C_EXIT.haltGlobal, "Global HALT is active");
  }
  if (halt.repositories.some(
    (candidate) => candidate.toLowerCase() === repository.toLowerCase(),
  )) {
    fail(
      "INT3C_HALT_REPOSITORY",
      INT3C_EXIT.haltRepository,
      `Repository HALT is active for ${repository}`,
    );
  }
}

function createObservedGitHubClient(github) {
  const state = {
    liveBaseSha: undefined,
    remoteHeads: [],
  };
  return {
    state,
    github: {
      readWriteAuthorization: () => github.readWriteAuthorization(),
      async readCurrentBase(repository, baseRef) {
        const base = await github.readCurrentBase(repository, baseRef);
        state.liveBaseSha = base.revision;
        return base;
      },
      async listPullRequestsByHead(repository, headRef) {
        const pullRequests = await github.listPullRequestsByHead(repository, headRef);
        state.remoteHeads.push(...pullRequests.map(
          (pullRequest) => structuredClone(pullRequest.head),
        ));
        return pullRequests;
      },
      materializeHead: (actuation) => github.materializeHead(actuation),
      async openPullRequest(actuation) {
        const pullRequest = await github.openPullRequest(actuation);
        state.remoteHeads.push(structuredClone(pullRequest.head));
        return pullRequest;
      },
    },
  };
}

async function loadOperation(verb) {
  if (verb === "preflight") {
    const { runInt3cPreflight } = await import("./int3c-preflight.mjs");
    return runInt3cPreflight;
  }
  const { runInt3cSend } = await import("./int3c-send-command.mjs");
  return runInt3cSend;
}

function buildEvidence(verb, actuation, result, observed) {
  if (!observed.liveBaseSha) {
    fail(
      "INT3C_EVIDENCE_FAILED",
      INT3C_EXIT.evidenceFailed,
      "live base SHA was not observed",
    );
  }
  const authorization = result.authorization;
  const evidence = {
    githubAppInstallationIdentity: authorization.identity,
    repository: authorization.repository,
    repositorySelection: authorization.repositorySelection,
    permissions: {
      contents: authorization.permissions.contents,
      pullRequests: authorization.permissions.pullRequests,
    },
    extraWriteScopes: [],
    liveBaseSha: observed.liveBaseSha,
    derivedHeadRef: actuation.payload.head.ref,
    outcome: result.outcome,
  };
  if (verb === "send") {
    const remoteHead = [...observed.remoteHeads].reverse().find(
      (candidate) => candidate.ref === actuation.payload.head.ref
        && candidate.revision === result.pullRequest.headSha,
    );
    if (!remoteHead || remoteHead.treeSha !== actuation.payload.head.treeSha) {
      fail(
        "INT3C_EVIDENCE_FAILED",
        INT3C_EXIT.evidenceFailed,
        "remote head tree did not confirm the verified payload tree",
      );
    }
    return {
      ...evidence,
      pullRequestNumber: result.pullRequest.number,
      headCommitSha: result.pullRequest.headSha,
      payloadArtifactHash: result.payloadArtifact.sha256,
      remoteHeadTreeMatchesPayload: true,
    };
  }
  return evidence;
}

async function writeEvidence(target, evidence) {
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    fail(
      "INT3C_EVIDENCE_FAILED",
      INT3C_EXIT.evidenceFailed,
      "evidence path could not be written without overwriting",
    );
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(name, exitCode, message) {
  throw new Int3cDriverError(name, exitCode, message);
}

async function main() {
  process.exitCode = await runInt3cDriver({ argv: process.argv.slice(2) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
