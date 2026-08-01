import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import { deriveIntendedRunId } from "@avg/averray-mcp/dispatch-claim";
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
  type PrPayloadActuatorDeps,
  type PrPayloadRefusalReason,
} from "../../services/harness-dispatcher/src/pr-payload-actuator.js";
import {
  createFilePrPayloadArtifactPort,
  createLocalGitPrPayloadRepositoryPort,
} from "../../services/harness-dispatcher/src/pr-payload-local-ports.js";

const execFileAsync = promisify(execFile);
const PINNED_REPOSITORY = "depre-dev/averray-reference-agent";
const EXPECTED_CASE_COUNT = 8;
const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const A_HASH = `sha256:${"a".repeat(64)}` as const;
const B_HASH = `sha256:${"b".repeat(64)}` as const;
const C_HASH = `sha256:${"c".repeat(64)}` as const;
const D_HASH = `sha256:${"d".repeat(64)}` as const;
const E_HASH = `sha256:${"e".repeat(64)}` as const;
const RUN_ID = "7db95d47-2cca-5572-a198-434723821fba";

type CeremonyCase =
  | "unverified-handoff"
  | "failed-check"
  | "path-outside-allowed"
  | "base-drift"
  | "halt-active"
  | "eligibility-disagreement"
  | "eligible-clean"
  | "replay-identical";

interface CeremonyEvidence {
  case: CeremonyCase;
  outcome: "refused" | "payload_ready";
  refusalReason?: PrPayloadRefusalReason;
  refusalMessage?: string;
  escalationRequired?: boolean;
  approvedBase?: string;
  observedBase?: string;
  payloadCount: number;
  artifactSha256?: string;
  canonicalSha256?: string;
  replayArtifactSha256?: string;
  replayCanonicalSha256?: string;
}

class Int3aEvidenceError extends Error {}

describe.sequential("INT-3a actuated-handoff payload ceremony", () => {
  let root: string;
  let repositoryRoot: string;
  let inputArtifactRoot: string;
  let outputArtifactRoot: string;
  let evidenceRoot: string;
  let baseRevision: string;
  let validPatch: string;
  let outsidePatch: string;
  let task: AgentTaskV1;
  let run: AgentRunProjectionV1;
  let handoff: VerifiedHandoffV1;
  let validInput: PrPayloadActuationInput;
  let deps: PrPayloadActuatorDeps;
  let cleanArtifactSha256: string;
  let cleanCanonicalSha256: string;
  let cleanCanonicalBytes: string;
  const ceremonyEvidence: CeremonyEvidence[] = [];
  const d3Results: Array<{
    case: CeremonyCase;
    mutation: string;
    observedFailure: string;
  }> = [];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "int3a-suite-"));
    repositoryRoot = path.join(root, "repository");
    inputArtifactRoot = path.join(root, "input-artifacts");
    outputArtifactRoot = path.join(root, "payload-artifacts");
    evidenceRoot = process.env.INT3A_SUITE_EVIDENCE_DIR
      ? path.resolve(process.env.INT3A_SUITE_EVIDENCE_DIR)
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
      writeFile(path.join(repositoryRoot, "docs/stage3a.md"), "base\n", "utf8"),
      writeFile(
        path.join(repositoryRoot, "src/guarded.ts"),
        "export const guarded = true;\n",
        "utf8",
      ),
    ]);
    await git(["add", "docs/stage3a.md", "src/guarded.ts"], repositoryRoot);
    await git([
      "-c",
      "user.name=INT-3a Suite",
      "-c",
      "user.email=int3a@example.invalid",
      "commit",
      "-m",
      "fixture base",
    ], repositoryRoot);
    baseRevision = (await git(["rev-parse", "HEAD"], repositoryRoot)).trim();

    validPatch = await makePatch(
      "docs/stage3a.md",
      "base\nstage 3a payload\n",
      "base\n",
    );
    outsidePatch = await makePatch(
      "src/guarded.ts",
      "export const guarded = false;\n",
      "export const guarded = true;\n",
    );

    const inputArtifacts = createFilePrPayloadArtifactPort(inputArtifactRoot);
    const patchRef = await inputArtifacts.write(
      Buffer.from(validPatch, "utf8"),
      "text/x-diff",
    );
    task = await approvedTask();
    run = completedRun(task);
    handoff = acceptedHandoff(task, run, patchRef);
    validInput = { task, run, handoff };
    deps = {
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
  }, 30_000);

  afterAll(async () => {
    await writeFile(
      path.join(evidenceRoot, "suite-summary.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        executedCases: ceremonyEvidence.length,
        expectedCases: EXPECTED_CASE_COUNT,
        cases: ceremonyEvidence,
        d3: d3Results,
      }, null, 2)}\n`,
      "utf8",
    );
    if (cleanCanonicalBytes) {
      await writeFile(
        path.join(evidenceRoot, "sample-payload.json"),
        `${JSON.stringify(JSON.parse(cleanCanonicalBytes), null, 2)}\n`,
        "utf8",
      );
    }
    if (!process.env.INT3A_SUITE_EVIDENCE_DIR) {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("refuses an unverified handoff by name", async () => {
    const input = cloneInput();
    input.handoff.verification = {
      ...input.handoff.verification,
      verified: false,
      decision: "reject",
    };
    input.handoff.eligibleForPrOpen = false;
    const refusal = await captureRefusal(input);
    const evidence = refusalEvidence("unverified-handoff", refusal);
    recordAndVerify(evidence);
    assertD3Mutation(
      evidence,
      (mutated) => {
        mutated.refusalReason = "handoff_check_not_passed";
      },
      "refusal_reason",
      "replace handoff_unverified with a different refusal",
    );
  });

  it("refuses one failed verification check by name", async () => {
    const input = cloneInput();
    input.handoff.checks[0] = {
      ...input.handoff.checks[0]!,
      status: "failed",
    };
    input.handoff.eligibleForPrOpen = false;
    const refusal = await captureRefusal(input);
    const evidence = refusalEvidence("failed-check", refusal);
    recordAndVerify(evidence);
    assertD3Mutation(
      evidence,
      (mutated) => {
        mutated.refusalReason = "handoff_unverified";
      },
      "refusal_reason",
      "replace handoff_check_not_passed with a different refusal",
    );
  });

  it("refuses a patch path outside allowedPaths and names the path", async () => {
    const inputArtifacts = createFilePrPayloadArtifactPort(inputArtifactRoot);
    const outsideRef = await inputArtifacts.write(
      Buffer.from(outsidePatch, "utf8"),
      "text/x-diff",
    );
    const input = cloneInput();
    input.handoff.deliverables.patchRef = outsideRef;
    const refusal = await captureRefusal(input);
    const evidence = refusalEvidence("path-outside-allowed", refusal);
    recordAndVerify(evidence);
    assertD3Mutation(
      evidence,
      (mutated) => {
        mutated.refusalMessage = "Patch path is outside repository.allowedPaths";
      },
      "refusal_path",
      "erase src/guarded.ts from the recorded refusal",
    );
  });

  it("refuses when the approved base is no longer current", async () => {
    const observedBase = "f".repeat(40);
    const input = cloneInput();
    const refusal = await captureRefusal(input, {
      ...deps,
      repository: {
        ...deps.repository,
        readCurrentBase: async () => ({
          ref: "main",
          revision: observedBase,
        }),
      },
    });
    const evidence = {
      ...refusalEvidence("base-drift", refusal),
      approvedBase: baseRevision,
      observedBase,
    };
    recordAndVerify(evidence);
    assertD3Mutation(
      evidence,
      (mutated) => {
        mutated.observedBase = mutated.approvedBase;
      },
      "base_drift_present",
      "make the recorded current base equal the approved base",
    );
  });

  it("refuses both global and repository HALT before artifact generation", async () => {
    const globalRefusal = await captureRefusal(cloneInput(), {
      ...deps,
      readHaltState: async () => ({ global: true, repositories: [] }),
    });
    expect(globalRefusal).toMatchObject({
      reason: "halt_global",
      message: expect.stringContaining("HALT"),
    });
    const repositoryRefusal = await captureRefusal(cloneInput(), {
      ...deps,
      readHaltState: async () => ({
        global: false,
        repositories: [PINNED_REPOSITORY],
      }),
    });
    const evidence = refusalEvidence("halt-active", repositoryRefusal);
    recordAndVerify(evidence);
    assertD3Mutation(
      evidence,
      (mutated) => {
        mutated.refusalMessage = "Payload generation refused";
      },
      "halt_named",
      "erase HALT from the recorded refusal",
    );
  });

  it("escalates a stored-vs-recomputed eligibility disagreement", async () => {
    const input = cloneInput();
    input.handoff.eligibleForPrOpen = false;
    const refusal = await captureRefusal(input);
    const reverseInput = cloneInput();
    reverseInput.handoff.verification = {
      ...reverseInput.handoff.verification,
      verified: false,
      decision: "reject",
    };
    const reverseRefusal = await captureRefusal(reverseInput);
    expect(reverseRefusal).toMatchObject({
      reason: "eligibility_disagreement",
      escalationRequired: true,
    });
    const evidence = refusalEvidence("eligibility-disagreement", refusal);
    recordAndVerify(evidence);
    assertD3Mutation(
      evidence,
      (mutated) => {
        mutated.escalationRequired = false;
      },
      "eligibility_escalation",
      "clear the required escalation bit",
    );
  });

  it("produces exactly one complete content-addressed payload", async () => {
    const result = await actuatePullRequestPayload(cloneInput(), deps);
    const files = await readdir(outputArtifactRoot);
    expect(files).toHaveLength(1);
    expect(result.payload).toMatchObject({
      repository: PINNED_REPOSITORY,
      base: { ref: "main", revision: baseRevision },
      head: {
        ref: expect.stringMatching(/^harness\/[0-9a-f-]{36}$/),
        treeSha: expect.stringMatching(/^[a-f0-9]{40}$/),
      },
      title: task.proposal.title,
      patch: {
        bytes: validPatch,
        sha256: handoff.deliverables.patchRef?.sha256,
      },
    });
    expect(result.payload.head.ref).toBe(
      `harness/${deriveIntendedRunId(
        task.workItemId,
        task.taskVersion,
        task.approval.approvedTaskHash!,
      )}`,
    );
    const independentlyApplied = await deps.repository.applyPatch({
      repository: PINNED_REPOSITORY,
      baseRevision,
      patch: Buffer.from(validPatch, "utf8"),
    });
    expect(result.payload.head.treeSha).toBe(independentlyApplied.treeSha);
    expect(independentlyApplied.touchedPaths).toEqual(["docs/stage3a.md"]);
    expect(
      await readFile(path.join(outputArtifactRoot, files[0]!), "utf8"),
    ).toBe(result.canonicalBytes);
    expect(files[0]).toBe(result.artifact.sha256.slice("sha256:".length));

    const source = await Promise.all([
      readFile(
        new URL(
          "../../services/harness-dispatcher/src/pr-payload-actuator.ts",
          import.meta.url,
        ),
        "utf8",
      ),
      readFile(
        new URL(
          "../../services/harness-dispatcher/src/pr-payload-local-ports.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ]).then((parts) => parts.join("\n"));
    expect(source).not.toMatch(/@octokit|GITHUB_TOKEN|https?:\/\//);
    expect(source).not.toMatch(/\b(?:fetch|openPullRequest|createPullRequest)\s*\(/);
    expect(source).toContain("shell: false");
    await expect(
      deps.repository.readCurrentBase("someone/else"),
    ).rejects.toMatchObject({ reason: "repository_mismatch" });

    cleanArtifactSha256 = result.artifact.sha256;
    cleanCanonicalBytes = result.canonicalBytes;
    cleanCanonicalSha256 = sha256(result.canonicalBytes);
    const evidence: CeremonyEvidence = {
      case: "eligible-clean",
      outcome: "payload_ready",
      payloadCount: files.length,
      artifactSha256: cleanArtifactSha256,
      canonicalSha256: cleanCanonicalSha256,
    };
    recordAndVerify(evidence);
    assertD3Mutation(
      evidence,
      (mutated) => {
        mutated.payloadCount = 2;
      },
      "payload_count",
      "change exactly one recorded payload to two",
    );
  }, 30_000);

  it("replays the same handoff as one byte-identical payload artifact", async () => {
    const replay = await actuatePullRequestPayload(cloneInput(), deps);
    const files = await readdir(outputArtifactRoot);
    expect(files).toHaveLength(1);
    expect(replay.artifact.sha256).toBe(cleanArtifactSha256);
    expect(replay.canonicalBytes).toBe(cleanCanonicalBytes);
    const evidence: CeremonyEvidence = {
      case: "replay-identical",
      outcome: "payload_ready",
      payloadCount: files.length,
      artifactSha256: cleanArtifactSha256,
      canonicalSha256: cleanCanonicalSha256,
      replayArtifactSha256: replay.artifact.sha256,
      replayCanonicalSha256: sha256(replay.canonicalBytes),
    };
    recordAndVerify(evidence);
    assertD3Mutation(
      evidence,
      (mutated) => {
        mutated.replayCanonicalSha256 = ZERO_HASH;
      },
      "replay_identity",
      "replace the replayed canonical-byte hash",
    );
    expect(ceremonyEvidence).toHaveLength(EXPECTED_CASE_COUNT);
    expect(d3Results).toHaveLength(EXPECTED_CASE_COUNT);
  }, 30_000);

  function cloneInput(): PrPayloadActuationInput {
    return structuredClone(validInput);
  }

  async function captureRefusal(
    input: PrPayloadActuationInput,
    actuationDeps: PrPayloadActuatorDeps = deps,
  ): Promise<PrPayloadActuationError> {
    try {
      await actuatePullRequestPayload(input, actuationDeps);
    } catch (error) {
      expect(error).toBeInstanceOf(PrPayloadActuationError);
      expect(await readdir(outputArtifactRoot)).toHaveLength(0);
      return error as PrPayloadActuationError;
    }
    throw new Error("Expected INT-3a payload actuation to refuse");
  }

  function refusalEvidence(
    caseName: CeremonyCase,
    refusal: PrPayloadActuationError,
  ): CeremonyEvidence {
    return {
      case: caseName,
      outcome: "refused",
      refusalReason: refusal.reason,
      refusalMessage: refusal.message,
      escalationRequired: refusal.escalationRequired,
      payloadCount: 0,
    };
  }

  function recordAndVerify(evidence: CeremonyEvidence): void {
    expect(() => verifyInt3aEvidence(evidence)).not.toThrow();
    ceremonyEvidence.push(evidence);
  }

  function assertD3Mutation(
    evidence: CeremonyEvidence,
    mutate: (value: CeremonyEvidence) => void,
    expectedFailure: string,
    mutation: string,
  ): void {
    const mutated = structuredClone(evidence);
    mutate(mutated);
    let observed = "";
    try {
      verifyInt3aEvidence(mutated);
    } catch (error) {
      expect(error).toBeInstanceOf(Int3aEvidenceError);
      observed = (error as Error).message;
    }
    expect(observed).toContain(expectedFailure);
    d3Results.push({
      case: evidence.case,
      mutation,
      observedFailure: expectedFailure,
    });
  }

  async function approvedTask(): Promise<AgentTaskV1> {
    const fixture = JSON.parse(await readFile(
      new URL(
        "../fixtures/agent-integration/agent-task-v1.json",
        import.meta.url,
      ),
      "utf8",
    )) as Record<string, unknown>;
    const candidate = agentTaskV1Schema.parse({
      ...fixture,
      workItemId: "int3a-one-work-item",
      correlationId: "int3a-one-correlation",
      lifecycle: "handoff_ready",
      proposal: {
        ...(fixture.proposal as object),
        title: "Construct the INT-3a payload artifact",
        objective: "Materialize the verified documentation patch as a deterministic pull-request payload.",
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
        actor: { type: "operator", id: "int3a-operator" },
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
      approval: {
        ...candidate.approval,
        approvedTaskHash,
      },
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
      progress: {
        phase: "completed",
        summary: "Verified patch ready for handoff.",
        completedUnits: 1,
        totalUnits: 1,
      },
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
      verification: {
        status: "passed",
        decisionRef: ref(E_HASH),
        decisionHash: E_HASH,
      },
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
      checks: [{
        name: "format-command",
        status: "passed",
        evidenceRef: ref(B_HASH),
      }],
      verification: {
        verified: true,
        decision: "accept",
        verifier: { type: "verifier", id: "int3a-independent-verifier" },
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
});

function verifyInt3aEvidence(evidence: CeremonyEvidence): void {
  const expectedRefusal: Partial<Record<CeremonyCase, PrPayloadRefusalReason>> = {
    "unverified-handoff": "handoff_unverified",
    "failed-check": "handoff_check_not_passed",
    "path-outside-allowed": "path_not_allowed",
    "base-drift": "base_drift",
    "halt-active": "halt_repository",
    "eligibility-disagreement": "eligibility_disagreement",
  };
  const reason = expectedRefusal[evidence.case];
  if (reason) {
    requireEvidence(evidence.outcome === "refused", "refusal_outcome");
    requireEvidence(evidence.payloadCount === 0, "refusal_payload_count");
    requireEvidence(evidence.refusalReason === reason, "refusal_reason");
  }
  if (evidence.case === "path-outside-allowed") {
    requireEvidence(
      evidence.refusalMessage?.includes("src/guarded.ts") === true,
      "refusal_path",
    );
  }
  if (evidence.case === "base-drift") {
    requireEvidence(
      evidence.approvedBase !== evidence.observedBase,
      "base_drift_present",
    );
  }
  if (evidence.case === "halt-active") {
    requireEvidence(
      evidence.refusalMessage?.includes("HALT") === true,
      "halt_named",
    );
  }
  if (evidence.case === "eligibility-disagreement") {
    requireEvidence(
      evidence.escalationRequired === true,
      "eligibility_escalation",
    );
  }
  if (evidence.case === "eligible-clean") {
    requireEvidence(evidence.outcome === "payload_ready", "payload_outcome");
    requireEvidence(evidence.payloadCount === 1, "payload_count");
    requireEvidence(Boolean(evidence.artifactSha256), "payload_artifact");
    requireEvidence(Boolean(evidence.canonicalSha256), "payload_canonical_bytes");
  }
  if (evidence.case === "replay-identical") {
    requireEvidence(evidence.outcome === "payload_ready", "replay_outcome");
    requireEvidence(evidence.payloadCount === 1, "payload_count");
    requireEvidence(
      evidence.artifactSha256 === evidence.replayArtifactSha256
      && evidence.canonicalSha256 === evidence.replayCanonicalSha256,
      "replay_identity",
    );
  }
}

function requireEvidence(condition: boolean, reason: string): void {
  if (!condition) throw new Int3aEvidenceError(`INT-3a evidence failed: ${reason}`);
}

function ref(hash: `sha256:${string}`): ArtifactRef {
  return {
    uri: `artifact://sha256/${hash.slice("sha256:".length)}`,
    sha256: hash,
  };
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

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
