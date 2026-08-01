import { createHash } from "node:crypto";
import path from "node:path";

import { deriveIntendedRunId } from "@avg/averray-mcp/dispatch-claim";
import {
  agentRunProjectionV1Schema,
  agentTaskApprovalHashMatches,
  agentTaskV1Schema,
  artifactRefSchema,
  assertVerifiedHandoffMatchesTaskAndRun,
  canonicalContractJson,
  pullRequestPayloadV1Schema,
  verifiedHandoffV1Schema,
  type AgentRunProjectionV1,
  type AgentTaskV1,
  type ArtifactRef,
  type PullRequestPayloadV1,
  type VerifiedHandoffV1,
} from "@avg/schemas";

export type PrPayloadRefusalReason =
  | "approval_hash_mismatch"
  | "artifact_hash_mismatch"
  | "artifact_unavailable"
  | "base_drift"
  | "base_revision_invalid"
  | "contract_invalid"
  | "eligibility_disagreement"
  | "halt_global"
  | "halt_repository"
  | "halt_state_unavailable"
  | "handoff_check_not_passed"
  | "handoff_identity_mismatch"
  | "handoff_outcome_not_completed"
  | "handoff_unverified"
  | "patch_apply_failed"
  | "patch_empty"
  | "patch_missing"
  | "path_forbidden"
  | "path_not_allowed"
  | "payload_artifact_mismatch"
  | "repository_mismatch"
  | "repository_unavailable";

export class PrPayloadActuationError extends Error {
  constructor(
    readonly reason: PrPayloadRefusalReason,
    message: string,
    readonly escalationRequired = false,
  ) {
    super(message);
    this.name = "PrPayloadActuationError";
  }
}

export interface PrPayloadArtifactPort {
  read(ref: ArtifactRef): Promise<Uint8Array>;
  write(bytes: Uint8Array, mediaType: string): Promise<ArtifactRef>;
}

export interface PrPayloadRepositoryBase {
  ref: string;
  revision: string;
}

export interface AppliedPatchTree {
  treeSha: string;
  touchedPaths: string[];
}

export interface PrPayloadRepositoryPort {
  readCurrentBase(repository: string): Promise<PrPayloadRepositoryBase>;
  applyPatch(input: {
    repository: string;
    baseRevision: string;
    patch: Uint8Array;
  }): Promise<AppliedPatchTree>;
}

export interface ActuationHaltState {
  global: boolean;
  repositories: readonly string[];
}

export interface PrPayloadActuatorDeps {
  artifacts: PrPayloadArtifactPort;
  repository: PrPayloadRepositoryPort;
  readHaltState(): Promise<ActuationHaltState>;
}

export interface PrPayloadActuationInput {
  task: AgentTaskV1;
  run: AgentRunProjectionV1;
  handoff: VerifiedHandoffV1;
}

export interface PrPayloadActuationResult {
  artifact: ArtifactRef;
  payload: PullRequestPayloadV1;
  canonicalBytes: string;
}

const FULL_GIT_OBJECT_ID = /^[a-f0-9]{40}$/;
const PAYLOAD_MEDIA_TYPE = "application/vnd.averray.pull-request-payload.v1+json";

/**
 * Build the immutable INT-3a payload. This boundary has no GitHub client,
 * credential, environment lookup, or outward-effect port.
 */
export async function actuatePullRequestPayload(
  input: PrPayloadActuationInput,
  deps: PrPayloadActuatorDeps,
): Promise<PrPayloadActuationResult> {
  const task = parseContract(agentTaskV1Schema, input.task, "AgentTask");
  const run = parseContract(
    agentRunProjectionV1Schema,
    input.run,
    "AgentRunProjection",
  );

  await assertHaltClear(task.repository.nameWithOwner, deps);
  assertEligibilityAgreement(input.handoff);
  const handoff = parseContract(
    verifiedHandoffV1Schema,
    input.handoff,
    "VerifiedHandoff",
  );

  if (!await agentTaskApprovalHashMatches(task)) {
    refuse(
      "approval_hash_mismatch",
      "Approved task hash does not match the actuation-time AgentTask",
    );
  }
  try {
    await assertVerifiedHandoffMatchesTaskAndRun(task, run, handoff);
  } catch {
    refuse(
      "handoff_identity_mismatch",
      "VerifiedHandoff does not match the approved task and bound run",
    );
  }
  assertEligibility(handoff);

  const patchRef = handoff.deliverables.patchRef;
  if (!patchRef) {
    refuse("patch_missing", "VerifiedHandoff has no patch artifact");
  }
  if (!FULL_GIT_OBJECT_ID.test(task.repository.baseRevision)) {
    refuse(
      "base_revision_invalid",
      "Approved baseRevision is not a full Git object id",
    );
  }

  const patchBytes = await readVerifiedArtifact(patchRef, deps.artifacts);
  if (patchBytes.byteLength === 0) {
    refuse("patch_empty", "Verified patch artifact is empty");
  }
  const patchText = decodeExactUtf8Patch(patchBytes);

  const baseBefore = await readBase(task.repository.nameWithOwner, deps);
  assertBaseCurrent(task.repository.baseRevision, baseBefore.revision);
  const applied = await applyPatch(task, patchBytes, deps);
  assertTouchedPaths(task, applied.touchedPaths);
  const baseAfter = await readBase(task.repository.nameWithOwner, deps);
  assertBaseCurrent(task.repository.baseRevision, baseAfter.revision);
  if (baseAfter.ref !== baseBefore.ref) {
    refuse(
      "base_drift",
      `Base ref drifted from ${baseBefore.ref} to ${baseAfter.ref}`,
    );
  }

  const approvedTaskHash = task.approval.approvedTaskHash;
  if (!approvedTaskHash) {
    refuse(
      "approval_hash_mismatch",
      "Approved task has no immutable approval hash",
    );
  }
  const headRef = `harness/${deriveIntendedRunId(
    task.workItemId,
    task.taskVersion,
    approvedTaskHash,
  )}`;
  const payload = parseContract(
    pullRequestPayloadV1Schema,
    {
      schemaVersion: 1,
      kind: "pull_request_payload",
      repository: task.repository.nameWithOwner,
      base: {
        ref: baseBefore.ref,
        revision: task.repository.baseRevision,
      },
      head: {
        ref: headRef,
        treeSha: applied.treeSha,
      },
      title: task.proposal.title,
      body: buildPullRequestBody(task, handoff, applied.treeSha),
      patch: {
        ref: patchRef,
        sha256: patchRef.sha256,
        bytes: patchText,
      },
      source: {
        workItemId: task.workItemId,
        taskVersion: task.taskVersion,
        approvedTaskHash,
        harnessRunId: handoff.harnessRunId,
        verificationDecisionHash: handoff.verification.decisionHash,
      },
    },
    "pull-request payload",
  );
  const canonicalBytes = canonicalContractJson(payload);

  // HALT is sampled again immediately before the only write in stage 3a.
  await assertHaltClear(task.repository.nameWithOwner, deps);
  const bytes = Buffer.from(canonicalBytes, "utf8");
  const expectedHash = rawSha256(bytes);
  let artifact: ArtifactRef;
  try {
    artifact = artifactRefSchema.parse(
      await deps.artifacts.write(bytes, PAYLOAD_MEDIA_TYPE),
    );
  } catch (error) {
    if (error instanceof PrPayloadActuationError) throw error;
    refuse(
      "payload_artifact_mismatch",
      "Pull-request payload artifact could not be written",
    );
  }
  const expectedUri = `artifact://sha256/${expectedHash.slice("sha256:".length)}`;
  if (
    artifact.sha256 !== expectedHash
    || artifact.uri !== expectedUri
    || (artifact.sizeBytes !== undefined && artifact.sizeBytes !== bytes.byteLength)
  ) {
    refuse(
      "payload_artifact_mismatch",
      "Pull-request payload writer returned a different content address",
    );
  }

  return { artifact, payload, canonicalBytes };
}

function assertEligibility(handoff: VerifiedHandoffV1): void {
  assertEligibilityAgreement(handoff);
  if (handoff.outcome !== "completed") {
    refuse(
      "handoff_outcome_not_completed",
      `VerifiedHandoff outcome is ${handoff.outcome}, not completed`,
    );
  }

  if (!handoff.verification.verified) {
    refuse(
      "handoff_unverified",
      "VerifiedHandoff has no verified acceptance",
    );
  }
  const notPassed = handoff.checks.find((check) => check.status !== "passed");
  if (notPassed) {
    refuse(
      "handoff_check_not_passed",
      `VerifiedHandoff check did not pass: ${notPassed.name}`,
    );
  }
}

function assertEligibilityAgreement(handoff: VerifiedHandoffV1): void {
  const recomputed = handoff.outcome === "completed"
    && handoff.verification.verified
    && handoff.checks.every((check) => check.status === "passed");
  if (recomputed !== handoff.eligibleForPrOpen) {
    refuse(
      "eligibility_disagreement",
      "Stored eligibleForPrOpen disagrees with actuation-time recomputation",
      true,
    );
  }
}

async function assertHaltClear(
  repository: string,
  deps: PrPayloadActuatorDeps,
): Promise<void> {
  let halt: ActuationHaltState;
  try {
    halt = await deps.readHaltState();
  } catch {
    refuse(
      "halt_state_unavailable",
      "HALT state is unavailable; payload generation fails closed",
    );
  }
  if (halt.global) {
    refuse("halt_global", "Global HALT is active; payload generation refused");
  }
  if (halt.repositories.some(
    (candidate) => candidate.toLowerCase() === repository.toLowerCase(),
  )) {
    refuse(
      "halt_repository",
      `Repository HALT is active for ${repository}; payload generation refused`,
    );
  }
}

async function readVerifiedArtifact(
  ref: ArtifactRef,
  artifacts: PrPayloadArtifactPort,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await artifacts.read(ref);
  } catch (error) {
    if (error instanceof PrPayloadActuationError) throw error;
    refuse("artifact_unavailable", "Verified patch artifact could not be read");
  }
  const digest = rawSha256(bytes);
  if (
    digest !== ref.sha256
    || (ref.sizeBytes !== undefined && ref.sizeBytes !== bytes.byteLength)
  ) {
    refuse(
      "artifact_hash_mismatch",
      "Verified patch bytes do not match deliverables.patchRef",
    );
  }
  return bytes;
}

function decodeExactUtf8Patch(bytes: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    refuse("patch_apply_failed", "Verified patch is not valid UTF-8 text");
  }
  if (!Buffer.from(decoded, "utf8").equals(Buffer.from(bytes))) {
    refuse("patch_apply_failed", "Verified patch bytes are not stable UTF-8");
  }
  return decoded;
}

async function readBase(
  repository: string,
  deps: PrPayloadActuatorDeps,
): Promise<PrPayloadRepositoryBase> {
  try {
    return await deps.repository.readCurrentBase(repository);
  } catch (error) {
    if (error instanceof PrPayloadActuationError) throw error;
    refuse(
      "repository_unavailable",
      `Pinned repository state is unavailable for ${repository}`,
    );
  }
}

async function applyPatch(
  task: AgentTaskV1,
  patch: Uint8Array,
  deps: PrPayloadActuatorDeps,
): Promise<AppliedPatchTree> {
  try {
    return await deps.repository.applyPatch({
      repository: task.repository.nameWithOwner,
      baseRevision: task.repository.baseRevision,
      patch,
    });
  } catch (error) {
    if (error instanceof PrPayloadActuationError) throw error;
    refuse(
      "patch_apply_failed",
      "Verified patch could not be applied to the approved baseRevision",
    );
  }
}

function assertBaseCurrent(expected: string, actual: string): void {
  if (actual !== expected) {
    refuse(
      "base_drift",
      `Base drift: approved ${expected}, current ${actual}`,
    );
  }
}

function assertTouchedPaths(task: AgentTaskV1, touchedPaths: string[]): void {
  if (touchedPaths.length === 0) {
    refuse("patch_empty", "Applying the verified patch changes no paths");
  }
  for (const touchedPath of touchedPaths) {
    if (!isSafeRepositoryPath(touchedPath)) {
      refuse(
        "path_not_allowed",
        `Patch path is not a safe repository-relative path: ${touchedPath}`,
      );
    }
    if (!task.repository.allowedPaths.some(
      (pattern) => path.posix.matchesGlob(touchedPath, pattern),
    )) {
      refuse(
        "path_not_allowed",
        `Patch path is outside repository.allowedPaths: ${touchedPath}`,
      );
    }
    if (task.repository.forbiddenPaths.some(
      (pattern) => path.posix.matchesGlob(touchedPath, pattern),
    )) {
      refuse(
        "path_forbidden",
        `Patch path matches repository.forbiddenPaths: ${touchedPath}`,
      );
    }
  }
}

function isSafeRepositoryPath(value: string): boolean {
  return value.length > 0
    && !value.includes("\\")
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && value !== ".."
    && !value.startsWith("../");
}

function buildPullRequestBody(
  task: AgentTaskV1,
  handoff: VerifiedHandoffV1,
  treeSha: string,
): string {
  return [
    task.proposal.objective,
    "",
    "---",
    "Verified Harness handoff",
    `- Work item: ${task.workItemId}@${task.taskVersion}`,
    `- Run: ${handoff.harnessRunId}`,
    `- Approved task: ${task.approval.approvedTaskHash}`,
    `- Verification decision: ${handoff.verification.decisionHash}`,
    `- Patch: ${handoff.deliverables.patchRef?.sha256}`,
    `- Head tree: ${treeSha}`,
  ].join("\n");
}

function rawSha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function parseContract<T>(
  schema: { parse(input: unknown): T },
  value: unknown,
  label: string,
): T {
  try {
    return schema.parse(value);
  } catch {
    refuse("contract_invalid", `${label} failed strict schema validation`);
  }
}

function refuse(
  reason: PrPayloadRefusalReason,
  message: string,
  escalationRequired = false,
): never {
  throw new PrPayloadActuationError(reason, message, escalationRequired);
}
