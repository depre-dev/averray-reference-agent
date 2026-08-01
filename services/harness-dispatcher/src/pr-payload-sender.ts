import {
  githubPullRequestRefSchema,
  type ArtifactRef,
  type GithubPullRequestRef,
  type MutationRef,
  type PullRequestPayloadV1,
} from "@avg/schemas";

import type {
  ActuationHaltState,
  PrPayloadActuationResult,
} from "./pr-payload-actuator.js";

export type PrPayloadSendRefusalReason =
  | "base_drift"
  | "credential_scope_invalid"
  | "credential_scope_unavailable"
  | "github_state_unavailable"
  | "halt_global"
  | "halt_repository"
  | "halt_state_unavailable"
  | "head_conflict"
  | "pull_request_create_failed"
  | "pull_request_identity_mismatch";

export class PrPayloadSendError extends Error {
  constructor(
    readonly reason: PrPayloadSendRefusalReason,
    message: string,
    readonly escalationRequired = false,
  ) {
    super(message);
    this.name = "PrPayloadSendError";
  }
}

/**
 * A transport-specific conflict means the create call did not produce a
 * second PR. The sender resolves the race by querying the derived head again.
 */
export class PullRequestCreateConflictError extends Error {
  constructor() {
    super("A pull request already exists for the derived head");
    this.name = "PullRequestCreateConflictError";
  }
}

export interface GitHubWriteAuthorization {
  identity: string;
  repositorySelection: "selected" | "all";
  writeRepositories: string[];
  permissions: {
    contents: "read" | "write" | "none";
    pullRequests: "read" | "write" | "none";
    extraWriteScopes: string[];
  };
}

export interface GitHubWriteAuthorizationEvidence {
  identity: string;
  repository: string;
  repositorySelection: "selected";
  permissions: {
    contents: "write";
    pullRequests: "write";
  };
}

export interface RemotePullRequest {
  repository: string;
  number: number;
  state: "open" | "closed";
  title: string;
  body: string;
  base: {
    ref: string;
    revision: string;
  };
  head: {
    ref: string;
    revision: string;
    treeSha: string;
  };
}

/**
 * The complete GitHub write surface available to INT-3b. It deliberately has
 * no merge, force-push, comment, close, reopen, protection, or arbitrary-repo
 * operation. A live implementation owns the credential outside the agent
 * container; neither the token nor an HTTP client crosses into INT-3a.
 */
export interface PrPayloadGitHubClient {
  readWriteAuthorization(): Promise<GitHubWriteAuthorization>;
  readCurrentBase(
    repository: string,
    baseRef: string,
  ): Promise<{ ref: string; revision: string }>;
  listPullRequestsByHead(
    repository: string,
    headRef: string,
  ): Promise<RemotePullRequest[]>;
  materializeHead(actuation: PrPayloadActuationResult): Promise<void>;
  openPullRequest(
    actuation: PrPayloadActuationResult,
  ): Promise<RemotePullRequest>;
}

export interface PrPayloadSenderDeps {
  github: PrPayloadGitHubClient;
  readHaltState(): Promise<ActuationHaltState>;
}

export interface PrPayloadSendResult {
  outcome: "opened" | "adopted";
  pullRequest: GithubPullRequestRef;
  payloadArtifact: ArtifactRef;
  authorization: GitHubWriteAuthorizationEvidence;
  mutation?: MutationRef;
}

export interface PrPayloadSendPreflight {
  outcome: "ready" | "adoptable";
  repository: string;
  headRef: string;
  authorization: GitHubWriteAuthorizationEvidence;
  existingPullRequest?: GithubPullRequestRef;
}

/**
 * Live-API dry run for the operator ceremony. It exercises authorization,
 * repository resolution, deterministic head lookup, base drift, and HALT, but
 * the type deliberately contains no operation capable of opening a PR.
 */
export async function preflightPullRequestPayload(
  actuation: PrPayloadActuationResult,
  deps: PrPayloadSenderDeps,
): Promise<PrPayloadSendPreflight> {
  const inspected = await inspectRemoteState(actuation, deps);
  return {
    outcome: inspected.existing ? "adoptable" : "ready",
    repository: actuation.payload.repository,
    headRef: actuation.payload.head.ref,
    authorization: inspected.authorization,
    ...(inspected.existing
      ? { existingPullRequest: toPullRequestRef(inspected.existing) }
      : {}),
  };
}

export async function sendPullRequestPayload(
  actuation: PrPayloadActuationResult,
  deps: PrPayloadSenderDeps,
): Promise<PrPayloadSendResult> {
  const inspected = await inspectRemoteState(actuation, deps);
  if (inspected.existing) {
    return adoptedResult(actuation, inspected.authorization, inspected.existing);
  }

  try {
    await deps.github.materializeHead(actuation);
  } catch (error) {
    if (error instanceof PrPayloadSendError) throw error;
    refuse(
      "pull_request_create_failed",
      "GitHub did not confirm the deterministic verified head",
      true,
    );
  }

  // Head materialization can take time. Re-query remote idempotency state and
  // re-read the base plus HALT after it, directly before the PR-create call.
  const beforeCreate = await inspectBeforeCreate(actuation.payload, deps);
  if (beforeCreate) {
    return adoptedResult(
      actuation,
      inspected.authorization,
      beforeCreate,
    );
  }

  // The immediately preceding reads are the actuation-time base and HALT
  // checks. openPullRequest performs only the GitHub create-PR request.
  let opened: RemotePullRequest;
  try {
    opened = await deps.github.openPullRequest(actuation);
  } catch (error) {
    if (error instanceof PullRequestCreateConflictError) {
      const afterConflict = await readPullRequests(actuation.payload, deps.github);
      const existing = selectMatchingPullRequest(
        actuation.payload,
        afterConflict,
      );
      if (existing) {
        return adoptedResult(
          actuation,
          inspected.authorization,
          existing,
        );
      }
    }
    if (error instanceof PrPayloadSendError) throw error;
    refuse(
      "pull_request_create_failed",
      "GitHub did not confirm pull-request creation for the verified payload",
      true,
    );
  }

  assertPullRequestMatchesPayload(actuation.payload, opened);
  const pullRequest = toPullRequestRef(opened);
  const mutation: MutationRef = {
    system: "github",
    action: "open_pull_request",
    target: `${pullRequest.repository}#${pullRequest.number}`,
    idempotencyKey: actuation.artifact.sha256,
    resultRef: actuation.artifact,
  };
  return {
    outcome: "opened",
    pullRequest,
    payloadArtifact: actuation.artifact,
    authorization: inspected.authorization,
    mutation,
  };
}

async function inspectRemoteState(
  actuation: PrPayloadActuationResult,
  deps: PrPayloadSenderDeps,
): Promise<{
  authorization: GitHubWriteAuthorizationEvidence;
  existing?: RemotePullRequest;
}> {
  const payload = actuation.payload;
  const authorization = await readAndAssertAuthorization(
    payload.repository,
    deps.github,
  );
  const pullRequests = await readPullRequests(payload, deps.github);
  const existing = selectMatchingPullRequest(payload, pullRequests);

  await assertBaseAndHalt(payload, deps);
  return { authorization, ...(existing ? { existing } : {}) };
}

async function inspectBeforeCreate(
  payload: PullRequestPayloadV1,
  deps: PrPayloadSenderDeps,
): Promise<RemotePullRequest | undefined> {
  const pullRequests = await readPullRequests(payload, deps.github);
  const existing = selectMatchingPullRequest(payload, pullRequests);
  await assertBaseAndHalt(payload, deps);
  return existing;
}

async function assertBaseAndHalt(
  payload: PullRequestPayloadV1,
  deps: PrPayloadSenderDeps,
): Promise<void> {

  let base: { ref: string; revision: string };
  try {
    base = await deps.github.readCurrentBase(
      payload.repository,
      payload.base.ref,
    );
  } catch (error) {
    if (error instanceof PrPayloadSendError) throw error;
    refuse(
      "github_state_unavailable",
      `Live base state is unavailable for ${payload.repository}`,
    );
  }
  if (
    base.ref !== payload.base.ref
    || base.revision !== payload.base.revision
  ) {
    refuse(
      "base_drift",
      `Base drift: payload ${payload.base.revision}, live ${base.revision}`,
      true,
    );
  }

  await assertHaltClear(payload.repository, deps);
}

async function readAndAssertAuthorization(
  repository: string,
  github: PrPayloadGitHubClient,
): Promise<GitHubWriteAuthorizationEvidence> {
  let authorization: GitHubWriteAuthorization;
  try {
    authorization = await github.readWriteAuthorization();
  } catch (error) {
    if (error instanceof PrPayloadSendError) throw error;
    refuse(
      "credential_scope_unavailable",
      "GitHub write authorization could not be read back",
      true,
    );
  }
  const repositories = [...new Set(
    authorization.writeRepositories.map((candidate) => candidate.toLowerCase()),
  )];
  if (
    authorization.repositorySelection !== "selected"
    || repositories.length !== 1
    || repositories[0] !== repository.toLowerCase()
    || authorization.permissions.contents !== "write"
    || authorization.permissions.pullRequests !== "write"
    || authorization.permissions.extraWriteScopes.length !== 0
  ) {
    refuse(
      "credential_scope_invalid",
      `GitHub write authorization is not restricted to ${repository}`,
      true,
    );
  }
  return {
    identity: authorization.identity,
    repository,
    repositorySelection: "selected",
    permissions: {
      contents: "write",
      pullRequests: "write",
    },
  };
}

async function readPullRequests(
  payload: PullRequestPayloadV1,
  github: PrPayloadGitHubClient,
): Promise<RemotePullRequest[]> {
  try {
    return await github.listPullRequestsByHead(
      payload.repository,
      payload.head.ref,
    );
  } catch (error) {
    if (error instanceof PrPayloadSendError) throw error;
    refuse(
      "github_state_unavailable",
      `Pull-request state is unavailable for ${payload.repository}`,
    );
  }
}

function selectMatchingPullRequest(
  payload: PullRequestPayloadV1,
  pullRequests: RemotePullRequest[],
): RemotePullRequest | undefined {
  if (pullRequests.length === 0) return undefined;
  const matching = pullRequests.filter(
    (pullRequest) => pullRequestMatchesPayload(payload, pullRequest),
  );
  if (matching.length === 1 && pullRequests.length === 1) return matching[0];
  refuse(
    "head_conflict",
    matching.length > 1
      ? `More than one pull request exists for derived head ${payload.head.ref}`
      : `Derived head ${payload.head.ref} belongs to a different payload`,
    true,
  );
}

function assertPullRequestMatchesPayload(
  payload: PullRequestPayloadV1,
  pullRequest: RemotePullRequest,
): void {
  if (!pullRequestMatchesPayload(payload, pullRequest)) {
    refuse(
      "pull_request_identity_mismatch",
      "Created pull request does not match the verified payload",
      true,
    );
  }
}

function pullRequestMatchesPayload(
  payload: PullRequestPayloadV1,
  pullRequest: RemotePullRequest,
): boolean {
  return pullRequest.repository.toLowerCase() === payload.repository.toLowerCase()
    && pullRequest.title === payload.title
    && pullRequest.body === payload.body
    && pullRequest.base.ref === payload.base.ref
    && pullRequest.base.revision === payload.base.revision
    && pullRequest.head.ref === payload.head.ref
    && pullRequest.head.treeSha === payload.head.treeSha;
}

async function assertHaltClear(
  repository: string,
  deps: Pick<PrPayloadSenderDeps, "readHaltState">,
): Promise<void> {
  let halt: ActuationHaltState;
  try {
    halt = await deps.readHaltState();
  } catch {
    refuse(
      "halt_state_unavailable",
      "HALT state is unavailable; pull-request sending fails closed",
    );
  }
  if (halt.global) {
    refuse("halt_global", "Global HALT is active; pull-request send refused");
  }
  if (halt.repositories.some(
    (candidate) => candidate.toLowerCase() === repository.toLowerCase(),
  )) {
    refuse(
      "halt_repository",
      `Repository HALT is active for ${repository}; pull-request send refused`,
    );
  }
}

function adoptedResult(
  actuation: PrPayloadActuationResult,
  authorization: GitHubWriteAuthorizationEvidence,
  existing: RemotePullRequest,
): PrPayloadSendResult {
  return {
    outcome: "adopted",
    pullRequest: toPullRequestRef(existing),
    payloadArtifact: actuation.artifact,
    authorization,
  };
}

function toPullRequestRef(pullRequest: RemotePullRequest): GithubPullRequestRef {
  return githubPullRequestRefSchema.parse({
    repository: pullRequest.repository,
    number: pullRequest.number,
    headSha: pullRequest.head.revision,
  });
}

function refuse(
  reason: PrPayloadSendRefusalReason,
  message: string,
  escalationRequired = false,
): never {
  throw new PrPayloadSendError(reason, message, escalationRequired);
}
