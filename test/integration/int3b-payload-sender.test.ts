import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  agentRunProjectionV1Schema,
  agentTaskV1Schema,
  hashAgentTaskApprovalPayload,
  verifiedHandoffV1Schema,
  type AgentRunProjectionV1,
  type AgentTaskV1,
  type ArtifactRef,
  type VerifiedHandoffV1,
} from "@avg/schemas";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  actuatePullRequestPayload,
  PrPayloadActuationError,
  type PrPayloadActuationInput,
  type PrPayloadActuationResult,
  type PrPayloadActuatorDeps,
  type PrPayloadRefusalReason,
} from "../../services/harness-dispatcher/src/pr-payload-actuator.js";
import {
  createFilePrPayloadArtifactPort,
  createLocalGitPrPayloadRepositoryPort,
} from "../../services/harness-dispatcher/src/pr-payload-local-ports.js";
import {
  PrPayloadSendError,
  sendPullRequestPayload,
  preflightPullRequestPayload,
  type GitHubWriteAuthorization,
  type PrPayloadGitHubClient,
  type PrPayloadSendRefusalReason,
  type PrPayloadSendResult,
  type RemotePullRequest,
} from "../../services/harness-dispatcher/src/pr-payload-sender.js";
import {
  buildPullRequestActuationDecision,
} from "../../services/harness-dispatcher/src/reconcile-run.js";
import {
  createGitHubPrClient,
} from "../../services/harness-dispatcher/src/pr-payload-github-client.js";

const execFileAsync = promisify(execFile);
const PINNED_REPOSITORY = "depre-dev/averray-reference-agent";
const OTHER_REPOSITORY = "depre-dev/another-repository";
const EXPECTED_CASE_COUNT = 27;
const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const A_HASH = `sha256:${"a".repeat(64)}` as const;
const B_HASH = `sha256:${"b".repeat(64)}` as const;
const C_HASH = `sha256:${"c".repeat(64)}` as const;
const D_HASH = `sha256:${"d".repeat(64)}` as const;
const E_HASH = `sha256:${"e".repeat(64)}` as const;
const RUN_ID = "7db95d47-2cca-5572-a198-434723821fba";

const INT3A_REFUSALS = [
  "approval_hash_mismatch",
  "artifact_hash_mismatch",
  "artifact_unavailable",
  "base_drift",
  "base_revision_invalid",
  "contract_invalid",
  "eligibility_disagreement",
  "halt_global",
  "halt_repository",
  "halt_state_unavailable",
  "handoff_check_not_passed",
  "handoff_identity_mismatch",
  "handoff_outcome_not_completed",
  "handoff_unverified",
  "patch_apply_failed",
  "patch_empty",
  "patch_missing",
  "path_forbidden",
  "path_not_allowed",
  "payload_artifact_mismatch",
  "repository_mismatch",
  "repository_unavailable",
] as const satisfies readonly PrPayloadRefusalReason[];

type Int3bCase =
  | `3a:${PrPayloadRefusalReason}`
  | "base-moved-after-construction"
  | "halt-after-construction"
  | "existing-pr-adopted"
  | "crash-after-create"
  | "credential-scope-too-wide";

interface CeremonyEvidence {
  case: Int3bCase;
  outcome: "refused" | "adopted" | "recovered_after_crash";
  refusalReason?: PrPayloadRefusalReason | PrPayloadSendRefusalReason;
  refusalMessage?: string;
  credentialIdentity?: string;
  credentialRepository?: string;
  remoteCalls: number;
  createCalls: number;
  pullRequestCount: number;
  replayOutcome?: PrPayloadSendResult["outcome"];
}

class Int3bEvidenceError extends Error {}

class FakeGitHubClient implements PrPayloadGitHubClient {
  authorization: GitHubWriteAuthorization = {
    identity: "ceremony-app#installation-1001",
    repositorySelection: "selected",
    writeRepositories: [PINNED_REPOSITORY],
    permissions: {
      contents: "write",
      pullRequests: "write",
      extraWriteScopes: [],
    },
  };
  baseRevision: string;
  remoteCalls = 0;
  materializeCalls = 0;
  createCalls = 0;
  crashAfterCreate = false;
  onMaterialize?: () => void;
  readonly pullRequests: RemotePullRequest[] = [];

  constructor(baseRevision: string) {
    this.baseRevision = baseRevision;
  }

  async readWriteAuthorization(): Promise<GitHubWriteAuthorization> {
    this.remoteCalls += 1;
    return structuredClone(this.authorization);
  }

  async readCurrentBase(repository: string, baseRef: string) {
    this.remoteCalls += 1;
    expect(repository).toBe(PINNED_REPOSITORY);
    return { ref: baseRef, revision: this.baseRevision };
  }

  async listPullRequestsByHead(repository: string, headRef: string) {
    this.remoteCalls += 1;
    return structuredClone(this.pullRequests.filter(
      (pullRequest) => pullRequest.repository === repository
        && pullRequest.head.ref === headRef,
    ));
  }

  async materializeHead(): Promise<void> {
    this.remoteCalls += 1;
    this.materializeCalls += 1;
    this.onMaterialize?.();
  }

  async openPullRequest(actuation: PrPayloadActuationResult) {
    this.remoteCalls += 1;
    this.createCalls += 1;
    const opened = remotePullRequest(
      actuation,
      this.pullRequests.length + 1,
    );
    this.pullRequests.push(opened);
    if (this.crashAfterCreate) {
      this.crashAfterCreate = false;
      throw new Error("simulated process loss after remote create");
    }
    return structuredClone(opened);
  }
}

describe.sequential("INT-3b pull-request sending ceremony", () => {
  let root: string;
  let repositoryRoot: string;
  let inputArtifactRoot: string;
  let outputArtifactRoot: string;
  let evidenceRoot: string;
  let baseRevision: string;
  let validPatch: string;
  let outsidePatch: string;
  let validPatchRef: ArtifactRef;
  let outsidePatchRef: ArtifactRef;
  let task: AgentTaskV1;
  let run: AgentRunProjectionV1;
  let handoff: VerifiedHandoffV1;
  let validInput: PrPayloadActuationInput;
  let actuationDeps: PrPayloadActuatorDeps;
  const ceremonyEvidence: CeremonyEvidence[] = [];
  const mutationResults: Array<{
    case: Int3bCase;
    mutation: string;
    observedFailure: string;
  }> = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "int3b-suite-"));
    repositoryRoot = path.join(root, "repository");
    inputArtifactRoot = path.join(root, "input-artifacts");
    outputArtifactRoot = path.join(root, "payload-artifacts");
    evidenceRoot = process.env.INT3B_SUITE_EVIDENCE_DIR
      ? path.resolve(process.env.INT3B_SUITE_EVIDENCE_DIR)
      : path.join(root, "evidence");
    await Promise.all([
      mkdir(repositoryRoot, { recursive: true }),
      mkdir(inputArtifactRoot, { recursive: true }),
      mkdir(outputArtifactRoot, { recursive: true }),
      mkdir(evidenceRoot, { recursive: true }),
      mkdir(path.join(repositoryRoot, "docs"), { recursive: true }),
      mkdir(path.join(repositoryRoot, "src"), { recursive: true }),
    ]);
    await git(["init", "--initial-branch=main"], repositoryRoot);
    await Promise.all([
      writeFile(path.join(repositoryRoot, "docs/stage3b.md"), "base\n", "utf8"),
      writeFile(
        path.join(repositoryRoot, "src/guarded.ts"),
        "export const guarded = true;\n",
        "utf8",
      ),
    ]);
    await git(["add", "docs/stage3b.md", "src/guarded.ts"], repositoryRoot);
    await git([
      "-c",
      "user.name=INT-3b Suite",
      "-c",
      "user.email=int3b@example.invalid",
      "commit",
      "-m",
      "fixture base",
    ], repositoryRoot);
    baseRevision = (await git(["rev-parse", "HEAD"], repositoryRoot)).trim();
    validPatch = await makePatch(
      repositoryRoot,
      "docs/stage3b.md",
      "base\nstage 3b payload\n",
      "base\n",
    );
    outsidePatch = await makePatch(
      repositoryRoot,
      "src/guarded.ts",
      "export const guarded = false;\n",
      "export const guarded = true;\n",
    );
    const inputArtifacts = createFilePrPayloadArtifactPort(inputArtifactRoot);
    validPatchRef = await inputArtifacts.write(
      Buffer.from(validPatch, "utf8"),
      "text/x-diff",
    );
    outsidePatchRef = await inputArtifacts.write(
      Buffer.from(outsidePatch, "utf8"),
      "text/x-diff",
    );
    task = await approvedTask(baseRevision);
    run = completedRun(task);
    handoff = acceptedHandoff(task, run, validPatchRef);
    validInput = { task, run, handoff };
    actuationDeps = defaultActuationDeps();
  }, 30_000);

  afterAll(async () => {
    await writeFile(
      path.join(evidenceRoot, "suite-summary.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        executedCases: ceremonyEvidence.length,
        expectedCases: EXPECTED_CASE_COUNT,
        cases: ceremonyEvidence,
        mutations: mutationResults,
      }, null, 2)}\n`,
      "utf8",
    );
    if (!process.env.INT3B_SUITE_EVIDENCE_DIR) {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("keeps all 22 INT-3a refusals authoritative with GitHub write configured", async () => {
    for (const reason of INT3A_REFUSALS) {
      const fakeGitHub = new FakeGitHubClient(baseRevision);
      const { input, deps } = await constructionCase(reason);
      let observed: PrPayloadActuationError | undefined;
      try {
        const actuation = await actuatePullRequestPayload(input, deps);
        await sendPullRequestPayload(actuation, senderDeps(fakeGitHub));
      } catch (error) {
        expect(error).toBeInstanceOf(PrPayloadActuationError);
        observed = error as PrPayloadActuationError;
      }
      if (!observed) throw new Error(`Expected ${reason} to refuse in INT-3a`);
      expect(observed.reason).toBe(reason);
      expect(fakeGitHub.remoteCalls).toBe(0);
      const evidence: CeremonyEvidence = {
        case: `3a:${reason}`,
        outcome: "refused",
        refusalReason: observed.reason,
        refusalMessage: observed.message,
        credentialIdentity: fakeGitHub.authorization.identity,
        credentialRepository: fakeGitHub.authorization.writeRepositories[0],
        remoteCalls: fakeGitHub.remoteCalls,
        createCalls: fakeGitHub.createCalls,
        pullRequestCount: fakeGitHub.pullRequests.length,
      };
      recordAndMutate(
        evidence,
        (mutated) => {
          mutated.refusalReason = reason === "base_drift"
            ? "contract_invalid"
            : "base_drift";
        },
        `refusal_reason:${reason}`,
        `replace ${reason} with another refusal reason`,
      );
    }
  }, 30_000);

  it("refuses base drift introduced after payload construction", async () => {
    const actuation = await createActuation();
    const fakeGitHub = new FakeGitHubClient(baseRevision);
    fakeGitHub.onMaterialize = () => {
      fakeGitHub.baseRevision = "f".repeat(40);
    };
    const refusal = await captureSendRefusal(
      actuation,
      senderDeps(fakeGitHub),
    );
    const evidence: CeremonyEvidence = {
      case: "base-moved-after-construction",
      outcome: "refused",
      refusalReason: refusal.reason,
      refusalMessage: refusal.message,
      remoteCalls: fakeGitHub.remoteCalls,
      createCalls: fakeGitHub.createCalls,
      pullRequestCount: fakeGitHub.pullRequests.length,
    };
    recordAndMutate(
      evidence,
      (mutated) => {
        mutated.refusalReason = "github_state_unavailable";
      },
      "refusal_reason:base_drift",
      "replace the actuation-time base_drift refusal",
    );
  });

  it("refuses HALT declared after payload construction", async () => {
    const actuation = await createActuation();
    const fakeGitHub = new FakeGitHubClient(baseRevision);
    let halted = false;
    fakeGitHub.onMaterialize = () => {
      halted = true;
    };
    const refusal = await captureSendRefusal(actuation, {
      github: fakeGitHub,
      readHaltState: async () => ({ global: halted, repositories: [] }),
    });
    const evidence: CeremonyEvidence = {
      case: "halt-after-construction",
      outcome: "refused",
      refusalReason: refusal.reason,
      refusalMessage: refusal.message,
      remoteCalls: fakeGitHub.remoteCalls,
      createCalls: fakeGitHub.createCalls,
      pullRequestCount: fakeGitHub.pullRequests.length,
    };
    recordAndMutate(
      evidence,
      (mutated) => {
        mutated.refusalMessage = "Send refused";
      },
      "halt_named",
      "erase HALT from the send-time refusal",
    );
  });

  it("adopts one existing PR for the exact derived head", async () => {
    const actuation = await createActuation();
    const fakeGitHub = new FakeGitHubClient(baseRevision);
    fakeGitHub.pullRequests.push(remotePullRequest(actuation, 41));
    const result = await sendPullRequestPayload(
      actuation,
      senderDeps(fakeGitHub),
    );
    expect(result).toMatchObject({ outcome: "adopted" });
    expect(result).not.toHaveProperty("mutation");
    const decision = buildPullRequestActuationDecision(task, {
      outcome: result.outcome,
      pullRequest: result.pullRequest,
      payloadArtifact: result.payloadArtifact,
      githubIdentity: result.authorization.identity,
      githubRepository: result.authorization.repository,
    }, new Date("2026-07-23T13:00:00.000Z"));
    expect(decision.effects).toEqual({
      mutates: false,
      mutations: [],
      authorityChanged: false,
      budgetChanged: false,
    });
    const evidence: CeremonyEvidence = {
      case: "existing-pr-adopted",
      outcome: "adopted",
      credentialIdentity: result.authorization.identity,
      credentialRepository: result.authorization.repository,
      remoteCalls: fakeGitHub.remoteCalls,
      createCalls: fakeGitHub.createCalls,
      pullRequestCount: fakeGitHub.pullRequests.length,
    };
    recordAndMutate(
      evidence,
      (mutated) => {
        mutated.pullRequestCount = 2;
      },
      "exactly_one_pr",
      "change the adopted remote PR count from one to two",
    );
  });

  it("converges after a crash following remote creation", async () => {
    const actuation = await createActuation();
    const fakeGitHub = new FakeGitHubClient(baseRevision);
    fakeGitHub.crashAfterCreate = true;
    await expect(
      sendPullRequestPayload(actuation, senderDeps(fakeGitHub)),
    ).rejects.toMatchObject({ reason: "pull_request_create_failed" });
    expect(fakeGitHub.pullRequests).toHaveLength(1);
    const replay = await sendPullRequestPayload(
      actuation,
      senderDeps(fakeGitHub),
    );
    expect(replay.outcome).toBe("adopted");
    expect(fakeGitHub.pullRequests).toHaveLength(1);
    const evidence: CeremonyEvidence = {
      case: "crash-after-create",
      outcome: "recovered_after_crash",
      credentialIdentity: replay.authorization.identity,
      credentialRepository: replay.authorization.repository,
      remoteCalls: fakeGitHub.remoteCalls,
      createCalls: fakeGitHub.createCalls,
      pullRequestCount: fakeGitHub.pullRequests.length,
      replayOutcome: replay.outcome,
    };
    recordAndMutate(
      evidence,
      (mutated) => {
        mutated.replayOutcome = "opened";
      },
      "crash_replay_adopts",
      "record the crash replay as another create instead of adoption",
    );
  });

  it("refuses a write authorization covering more than one repository", async () => {
    const actuation = await createActuation();
    const fakeGitHub = new FakeGitHubClient(baseRevision);
    fakeGitHub.authorization.writeRepositories.push(OTHER_REPOSITORY);
    const refusal = await captureSendRefusal(
      actuation,
      senderDeps(fakeGitHub),
    );
    const evidence: CeremonyEvidence = {
      case: "credential-scope-too-wide",
      outcome: "refused",
      refusalReason: refusal.reason,
      refusalMessage: refusal.message,
      remoteCalls: fakeGitHub.remoteCalls,
      createCalls: fakeGitHub.createCalls,
      pullRequestCount: fakeGitHub.pullRequests.length,
    };
    recordAndMutate(
      evidence,
      (mutated) => {
        mutated.refusalReason = "credential_scope_unavailable";
      },
      "refusal_reason:credential_scope_invalid",
      "replace the over-broad scope refusal",
    );
    expect(ceremonyEvidence).toHaveLength(EXPECTED_CASE_COUNT);
    expect(mutationResults).toHaveLength(EXPECTED_CASE_COUNT);
  });

  it("opens one PR, records its mutation, and keeps dry run read-only", async () => {
    const actuation = await createActuation();
    const preflightClient = new FakeGitHubClient(baseRevision);
    const preflight = await preflightPullRequestPayload(
      actuation,
      senderDeps(preflightClient),
    );
    expect(preflight).toMatchObject({
      outcome: "ready",
      repository: PINNED_REPOSITORY,
      headRef: actuation.payload.head.ref,
    });
    expect(preflightClient.createCalls).toBe(0);
    expect(preflightClient.pullRequests).toHaveLength(0);

    const fakeGitHub = new FakeGitHubClient(baseRevision);
    const sent = await sendPullRequestPayload(
      actuation,
      senderDeps(fakeGitHub),
    );
    expect(sent.outcome).toBe("opened");
    expect(fakeGitHub.createCalls).toBe(1);
    expect(fakeGitHub.pullRequests).toHaveLength(1);
    const decision = buildPullRequestActuationDecision(task, {
      outcome: sent.outcome,
      pullRequest: sent.pullRequest,
      payloadArtifact: sent.payloadArtifact,
      githubIdentity: sent.authorization.identity,
      githubRepository: sent.authorization.repository,
      mutation: sent.mutation,
    }, new Date("2026-07-23T13:00:00.000Z"));
    expect(decision.effects).toEqual({
      mutates: true,
      mutations: [sent.mutation],
      authorityChanged: false,
      budgetChanged: false,
    });
    expect(JSON.stringify(decision)).not.toMatch(
      /installationToken|authorization|bearer/iu,
    );
  });

  it("guards 3a imports, the computed mutation invariant, and PR-only authority", async () => {
    const actuatorSource = await source("pr-payload-actuator.ts");
    const localPortsSource = await source("pr-payload-local-ports.ts");
    expect(importSpecifiers(actuatorSource)).toEqual([
      "@avg/averray-mcp/dispatch-claim",
      "@avg/schemas",
      "node:crypto",
      "node:path",
    ]);
    expect(importSpecifiers(localPortsSource)).toEqual([
      "./pr-payload-actuator.js",
      "@avg/schemas",
      "node:child_process",
      "node:crypto",
      "node:fs/promises",
      "node:os",
      "node:path",
    ]);
    const protectedSource = `${actuatorSource}\n${localPortsSource}`;
    expect(protectedSource).not.toMatch(/@octokit|https?:\/\/|\bfetch\s*\(/u);

    const reconcileSource = await readFile(
      new URL(
        "../../services/harness-dispatcher/src/reconcile-run.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(reconcileSource).toContain("mutates: mutations.length > 0");
    expect(reconcileSource).not.toMatch(
      /effects:\s*\{\s*mutates:\s*false,\s*mutations:\s*\[\]/u,
    );

    const senderSource = await source("pr-payload-sender.ts");
    const clientSource = await source("pr-payload-github-client.ts");
    expect(senderSource).not.toMatch(
      /\.(?:merge|forcePush|close|reopen|comment|editBranchProtection)\s*\(/u,
    );
    expect(clientSource).not.toContain("--force");
    expect(clientSource).not.toMatch(
      /\/(?:merges|comments|reviews|branches\/[^"`]*protection)/u,
    );
    expect(clientSource).toContain("repositoryApiPath(repository, \"/pulls\")");
  });

  it("binds issued permission metadata to the live installation repository list", async () => {
    const requests: string[] = [];
    const client = createGitHubPrClient({
      repository: PINNED_REPOSITORY,
      installationToken: "test-only-non-credential",
      issuedAuthorization: {
        identity: "ceremony-app#installation-1001",
        repositorySelection: "selected",
        permissions: {
          contents: "write",
          pullRequests: "write",
          extraWriteScopes: [],
        },
      },
      fetchImpl: async (input) => {
        requests.push(String(input));
        return new Response(JSON.stringify({
          total_count: 1,
          repositories: [{ full_name: PINNED_REPOSITORY }],
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const authorization = await client.readWriteAuthorization();
    expect(authorization).toEqual({
      identity: "ceremony-app#installation-1001",
      repositorySelection: "selected",
      writeRepositories: [PINNED_REPOSITORY],
      permissions: {
        contents: "write",
        pullRequests: "write",
        extraWriteScopes: [],
      },
    });
    expect(requests).toEqual([
      "https://api.github.com/installation/repositories?per_page=100",
    ]);
    expect(JSON.stringify(authorization)).not.toContain(
      "test-only-non-credential",
    );
  });

  async function createActuation(): Promise<PrPayloadActuationResult> {
    return actuatePullRequestPayload(cloneInput(), actuationDeps);
  }

  function cloneInput(): PrPayloadActuationInput {
    return structuredClone(validInput);
  }

  function defaultActuationDeps(): PrPayloadActuatorDeps {
    const inputArtifacts = createFilePrPayloadArtifactPort(inputArtifactRoot);
    return {
      artifacts: {
        read: inputArtifacts.read,
        write: createFilePrPayloadArtifactPort(outputArtifactRoot).write,
      },
      repository: createLocalGitPrPayloadRepositoryPort({
        repositoryRoot,
        repository: PINNED_REPOSITORY,
        baseRef: "main",
      }),
      readHaltState: async () => ({ global: false, repositories: [] }),
    };
  }

  function senderDeps(github: PrPayloadGitHubClient) {
    return {
      github,
      readHaltState: async () => ({ global: false, repositories: [] }),
    };
  }

  async function constructionCase(
    reason: PrPayloadRefusalReason,
  ): Promise<{
    input: PrPayloadActuationInput;
    deps: PrPayloadActuatorDeps;
  }> {
    const input = cloneInput();
    let deps = defaultActuationDeps();
    switch (reason) {
      case "approval_hash_mismatch":
        input.task.proposal.title = "Mutated after approval";
        break;
      case "artifact_hash_mismatch":
        deps = {
          ...deps,
          artifacts: {
            ...deps.artifacts,
            read: async () => Buffer.from("different patch bytes", "utf8"),
          },
        };
        break;
      case "artifact_unavailable":
        deps = {
          ...deps,
          artifacts: {
            ...deps.artifacts,
            read: async () => {
              throw new Error("unavailable");
            },
          },
        };
        break;
      case "base_drift":
        deps = {
          ...deps,
          repository: {
            ...deps.repository,
            readCurrentBase: async () => ({
              ref: "main",
              revision: "f".repeat(40),
            }),
          },
        };
        break;
      case "base_revision_invalid":
        input.task.repository.baseRevision = "main";
        await resign(input);
        break;
      case "contract_invalid":
        (input.task as AgentTaskV1 & { unexpected?: boolean }).unexpected = true;
        break;
      case "eligibility_disagreement":
        input.handoff.eligibleForPrOpen = false;
        break;
      case "halt_global":
        deps = {
          ...deps,
          readHaltState: async () => ({ global: true, repositories: [] }),
        };
        break;
      case "halt_repository":
        deps = {
          ...deps,
          readHaltState: async () => ({
            global: false,
            repositories: [PINNED_REPOSITORY],
          }),
        };
        break;
      case "halt_state_unavailable":
        deps = {
          ...deps,
          readHaltState: async () => {
            throw new Error("unavailable");
          },
        };
        break;
      case "handoff_check_not_passed":
        input.handoff.checks[0] = {
          ...input.handoff.checks[0]!,
          status: "failed",
        };
        input.handoff.eligibleForPrOpen = false;
        break;
      case "handoff_identity_mismatch":
        input.handoff.correlationId = "different-correlation";
        break;
      case "handoff_outcome_not_completed":
        input.handoff.outcome = "partial";
        input.handoff.eligibleForPrOpen = false;
        break;
      case "handoff_unverified":
        input.handoff.verification = {
          ...input.handoff.verification,
          verified: false,
          decision: "reject",
        };
        input.handoff.eligibleForPrOpen = false;
        break;
      case "patch_apply_failed":
        deps = {
          ...deps,
          repository: {
            ...deps.repository,
            applyPatch: async () => {
              throw new Error("apply failed");
            },
          },
        };
        break;
      case "patch_empty": {
        const emptyRef = await createFilePrPayloadArtifactPort(
          inputArtifactRoot,
        ).write(new Uint8Array(), "text/x-diff");
        input.handoff.deliverables.patchRef = emptyRef;
        break;
      }
      case "patch_missing":
        delete input.handoff.deliverables.patchRef;
        break;
      case "path_forbidden":
        input.task.repository.allowedPaths = ["docs/**", "src/**"];
        input.task.repository.forbiddenPaths = ["src/guarded.ts"];
        input.handoff.deliverables.patchRef = outsidePatchRef;
        await resign(input);
        break;
      case "path_not_allowed":
        input.handoff.deliverables.patchRef = outsidePatchRef;
        break;
      case "payload_artifact_mismatch":
        deps = {
          ...deps,
          artifacts: {
            ...deps.artifacts,
            write: async () => ref(A_HASH),
          },
        };
        break;
      case "repository_mismatch":
        input.task.repository.nameWithOwner = OTHER_REPOSITORY;
        await resign(input);
        break;
      case "repository_unavailable":
        deps = {
          ...deps,
          repository: {
            ...deps.repository,
            readCurrentBase: async () => {
              throw new Error("unavailable");
            },
          },
        };
        break;
      default:
        assertNever(reason);
    }
    return { input, deps };
  }

  async function resign(input: PrPayloadActuationInput): Promise<void> {
    input.task.approval.approvedTaskHash = ZERO_HASH;
    const approvedTaskHash = await hashAgentTaskApprovalPayload(input.task);
    input.task.approval.approvedTaskHash = approvedTaskHash;
    input.handoff.taskHash = approvedTaskHash;
  }

  async function captureSendRefusal(
    actuation: PrPayloadActuationResult,
    deps: ReturnType<typeof senderDeps>,
  ): Promise<PrPayloadSendError> {
    try {
      await sendPullRequestPayload(actuation, deps);
    } catch (error) {
      expect(error).toBeInstanceOf(PrPayloadSendError);
      return error as PrPayloadSendError;
    }
    throw new Error("Expected INT-3b send to refuse");
  }

  function recordAndMutate(
    evidence: CeremonyEvidence,
    mutate: (value: CeremonyEvidence) => void,
    expectedFailure: string,
    mutation: string,
  ): void {
    expect(() => verifyInt3bEvidence(evidence)).not.toThrow();
    ceremonyEvidence.push(evidence);
    const mutated = structuredClone(evidence);
    mutate(mutated);
    let observed = "";
    try {
      verifyInt3bEvidence(mutated);
    } catch (error) {
      expect(error).toBeInstanceOf(Int3bEvidenceError);
      observed = (error as Error).message;
    }
    expect(observed).toContain(expectedFailure);
    mutationResults.push({
      case: evidence.case,
      mutation,
      observedFailure: expectedFailure,
    });
  }

  async function source(file: string): Promise<string> {
    return readFile(
      new URL(
        `../../services/harness-dispatcher/src/${file}`,
        import.meta.url,
      ),
      "utf8",
    );
  }
});

function verifyInt3bEvidence(evidence: CeremonyEvidence): void {
  if (evidence.case.startsWith("3a:")) {
    const expected = evidence.case.slice("3a:".length);
    requireEvidence(evidence.outcome === "refused", "construction_refused");
    requireEvidence(
      evidence.refusalReason === expected,
      `refusal_reason:${expected}`,
    );
    requireEvidence(Boolean(evidence.credentialIdentity), "credential_configured");
    requireEvidence(Boolean(evidence.credentialRepository), "repository_configured");
    requireEvidence(evidence.remoteCalls === 0, "3a_before_github");
    requireEvidence(evidence.createCalls === 0, "3a_no_create");
    requireEvidence(evidence.pullRequestCount === 0, "3a_no_pr");
    return;
  }
  if (evidence.case === "base-moved-after-construction") {
    requireEvidence(evidence.outcome === "refused", "base_drift_refused");
    requireEvidence(evidence.refusalReason === "base_drift", "refusal_reason:base_drift");
    requireEvidence(evidence.createCalls === 0, "base_drift_no_create");
    requireEvidence(evidence.pullRequestCount === 0, "base_drift_no_pr");
  }
  if (evidence.case === "halt-after-construction") {
    requireEvidence(evidence.outcome === "refused", "halt_refused");
    requireEvidence(evidence.refusalReason === "halt_global", "refusal_reason:halt_global");
    requireEvidence(evidence.refusalMessage?.includes("HALT") === true, "halt_named");
    requireEvidence(evidence.createCalls === 0, "halt_no_create");
  }
  if (evidence.case === "existing-pr-adopted") {
    requireEvidence(evidence.outcome === "adopted", "existing_adopted");
    requireEvidence(evidence.pullRequestCount === 1, "exactly_one_pr");
    requireEvidence(evidence.createCalls === 0, "adoption_no_create");
  }
  if (evidence.case === "crash-after-create") {
    requireEvidence(
      evidence.outcome === "recovered_after_crash",
      "crash_recovered",
    );
    requireEvidence(evidence.pullRequestCount === 1, "exactly_one_pr");
    requireEvidence(evidence.createCalls === 1, "single_create_call");
    requireEvidence(evidence.replayOutcome === "adopted", "crash_replay_adopts");
  }
  if (evidence.case === "credential-scope-too-wide") {
    requireEvidence(evidence.outcome === "refused", "credential_refused");
    requireEvidence(
      evidence.refusalReason === "credential_scope_invalid",
      "refusal_reason:credential_scope_invalid",
    );
    requireEvidence(evidence.createCalls === 0, "credential_no_create");
    requireEvidence(evidence.pullRequestCount === 0, "credential_no_pr");
  }
}

function requireEvidence(condition: boolean, reason: string): void {
  if (!condition) throw new Int3bEvidenceError(`INT-3b evidence failed: ${reason}`);
}

function remotePullRequest(
  actuation: PrPayloadActuationResult,
  number: number,
): RemotePullRequest {
  return {
    repository: actuation.payload.repository,
    number,
    state: "open",
    title: actuation.payload.title,
    body: actuation.payload.body,
    base: structuredClone(actuation.payload.base),
    head: {
      ref: actuation.payload.head.ref,
      revision: sha1(`commit:${actuation.artifact.sha256}`),
      treeSha: actuation.payload.head.treeSha,
    },
  };
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)]
    .map((match) => match[1]!)
    .sort();
}

async function approvedTask(baseRevision: string): Promise<AgentTaskV1> {
  const fixture = JSON.parse(await readFile(
    new URL(
      "../fixtures/agent-integration/agent-task-v1.json",
      import.meta.url,
    ),
    "utf8",
  )) as Record<string, unknown>;
  const candidate = agentTaskV1Schema.parse({
    ...fixture,
    workItemId: "int3b-one-work-item",
    correlationId: "int3b-one-correlation",
    lifecycle: "handoff_ready",
    proposal: {
      ...(fixture.proposal as object),
      title: "Open the verified INT-3b pull request",
      objective: "Send exactly one pull request for the verified documentation patch.",
    },
    repository: {
      provider: "github",
      nameWithOwner: PINNED_REPOSITORY,
      baseRevision,
      allowedPaths: ["docs/**"],
      forbiddenPaths: ["src/**", "ops/**"],
    },
    requestedAuthority: {
      ...(fixture.requestedAuthority as object),
      grants: [{
        capabilityId: "fs.write_file",
        resource: PINNED_REPOSITORY,
        constraints: { allowedPaths: ["docs/**"] },
      }],
    },
    approval: {
      required: "operator",
      status: "approved",
      actor: { type: "operator", id: "int3b-operator" },
      decidedAt: "2026-07-23T12:05:00.000Z",
      policyVersion: "dispatch-policy-v1",
      policyHash: C_HASH,
      approvedTaskHash: ZERO_HASH,
    },
    timestamps: {
      proposedAt: "2026-07-23T12:00:00.000Z",
      approvedAt: "2026-07-23T12:05:00.000Z",
      runBoundAt: "2026-07-23T12:06:00.000Z",
      updatedAt: "2026-07-23T12:30:00.000Z",
    },
    bindings: {
      harnessRunId: RUN_ID,
      runManifestRef: ref(D_HASH),
      runManifestHash: D_HASH,
    },
  });
  const approvedTaskHash = await hashAgentTaskApprovalPayload(candidate);
  return agentTaskV1Schema.parse({
    ...candidate,
    approval: { ...candidate.approval, approvedTaskHash },
  });
}

function completedRun(approved: AgentTaskV1): AgentRunProjectionV1 {
  return agentRunProjectionV1Schema.parse({
    schemaVersion: 1,
    kind: "agent_run_projection",
    workItemId: approved.workItemId,
    correlationId: approved.correlationId,
    harnessRunId: RUN_ID,
    taskVersion: approved.taskVersion,
    source: {
      system: "agent-harness",
      health: "healthy",
      observedAt: "2026-07-23T12:30:00.000Z",
      sourceUpdatedAt: "2026-07-23T12:29:59.000Z",
    },
    heartbeat: {
      status: "terminal",
      lastEventAt: "2026-07-23T12:29:59.000Z",
      ageSeconds: 1,
    },
    run: {
      state: "completed",
      attempt: 1,
      terminal: true,
      outcome: "completed",
      lastEventAt: "2026-07-23T12:29:59.000Z",
    },
    manifest: {
      ref: ref(D_HASH),
      hash: D_HASH,
      profile: approved.intent.profile,
      riskClass: "low",
      effectiveCapabilities: ["fs.write_file"],
      network: "deny",
      policyHash: approved.approval.policyHash,
      verifierHash: approved.acceptance.verifierPlanHash,
      modelBindings: [],
      skillVersions: [],
    },
    progress: { phase: "completed", summary: "Verified patch ready.", completedUnits: 1, totalUnits: 1 },
    budget: {
      elapsedSecondsUsed: 30,
      elapsedSecondsLimit: approved.budget.elapsedSeconds,
      modelTokensUsed: 1,
      modelTokensLimit: approved.budget.modelTokens,
      toolCallsUsed: 1,
      toolCallsLimit: approved.budget.toolCalls,
      estimatedUsdMicrosUsed: 0,
      estimatedUsdMicrosLimit: approved.budget.estimatedUsdMicros,
      exhausted: false,
    },
    artifacts: [],
    verification: { status: "passed", decisionRef: ref(E_HASH), decisionHash: E_HASH },
    bindings: approved.bindings,
  });
}

function acceptedHandoff(
  approved: AgentTaskV1,
  projection: AgentRunProjectionV1,
  patchRef: ArtifactRef,
): VerifiedHandoffV1 {
  return verifiedHandoffV1Schema.parse({
    schemaVersion: 1,
    kind: "verified_handoff",
    workItemId: approved.workItemId,
    correlationId: approved.correlationId,
    harnessRunId: projection.harnessRunId,
    taskVersion: approved.taskVersion,
    taskHash: approved.approval.approvedTaskHash,
    taskIntentRef: approved.intent.templateRef,
    taskIntentHash: approved.intent.templateHash,
    runManifestRef: projection.manifest.ref,
    runManifestHash: projection.manifest.hash,
    outcome: "completed",
    deliverables: {
      patchRef,
      summaryRef: ref(A_HASH),
      structuredSubmissionRef: ref(E_HASH),
      artifacts: [patchRef],
    },
    checks: [{ name: "format-command", status: "passed", evidenceRef: ref(B_HASH) }],
    verification: {
      verified: true,
      decision: "accept",
      verifier: { type: "verifier", id: "int3b-independent-verifier" },
      planHash: approved.acceptance.verifierPlanHash,
      decisionRef: ref(E_HASH),
      decisionHash: E_HASH,
      evidenceRefs: [ref(B_HASH)],
      verifiedAt: "2026-07-23T12:29:59.000Z",
    },
    openQuestions: [],
    eligibleForPrOpen: true,
    generatedAt: "2026-07-23T12:30:00.000Z",
  });
}

async function makePatch(
  repositoryRoot: string,
  relativePath: string,
  changed: string,
  original: string,
): Promise<string> {
  const target = path.join(repositoryRoot, relativePath);
  await writeFile(target, changed, "utf8");
  const patch = await git(
    ["diff", "--binary", "--no-ext-diff", "--", relativePath],
    repositoryRoot,
  );
  await writeFile(target, original, "utf8");
  if (!patch.trim()) throw new Error(`Fixture patch is empty for ${relativePath}`);
  return patch;
}

function ref(hash: `sha256:${string}`): ArtifactRef {
  return {
    uri: `artifact://sha256/${hash.slice("sha256:".length)}`,
    sha256: hash,
  };
}

function sha1(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: process.env.PATH,
    },
  });
  return result.stdout;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected INT-3a refusal: ${String(value)}`);
}
