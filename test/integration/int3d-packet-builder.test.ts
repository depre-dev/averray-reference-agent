import { execFile } from "node:child_process";
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
  agentTaskV1Schema,
  hashAgentTaskApprovalPayload,
  type AgentTaskV1,
} from "@avg/schemas";
import {
  createFilePrPayloadArtifactPort,
} from "../../services/harness-dispatcher/src/pr-payload-local-ports.js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The committed operator entry points are JavaScript so they can be invoked
// with plain Node after the required workspace build.
// @ts-expect-error The .mjs entry point intentionally has no declaration file.
import {
  INT3D_EXIT,
  runInt3dBuilder,
} from "../../scripts/ops/int3d-build-packet.mjs";
// @ts-expect-error The .mjs entry point intentionally has no declaration file.
import {
  loadAndValidatePacket,
} from "../../scripts/ops/int3c-send.mjs";

const execFileAsync = promisify(execFile);
const PINNED_REPOSITORY = "depre-dev/averray-reference-agent";
const WORK_ITEM_ID = "int3d-one-work-item";
const RUN_ID = "7db95d47-2cca-5572-a198-434723821fba";
const ZERO_HASH = `sha256:${"0".repeat(64)}` as const;
const A_HASH = `sha256:${"a".repeat(64)}` as const;
const C_HASH = `sha256:${"c".repeat(64)}` as const;
const D_HASH = `sha256:${"d".repeat(64)}` as const;
const E_HASH = `sha256:${"e".repeat(64)}` as const;
const FIXED_NOW = new Date("2026-08-03T12:30:00.000Z");
const TOKEN_SENTINEL = "INT3D_TEST_TOKEN_SENTINEL_DO_NOT_USE";

describe.sequential("INT-3d operator packet builder", () => {
  let root: string;
  let repositoryRoot: string;
  let patchArtifactRoot: string;
  let payloadArtifactRoot: string;
  let authorizationPath: string;
  let outputPath: string;
  let baseRevision: string;
  let task: AgentTaskV1;
  let read: ReturnType<typeof terminalRead>;
  let listTasks: ReturnType<typeof vi.fn>;
  let readBinding: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "int3d-builder-"));
    repositoryRoot = path.join(root, "repository");
    patchArtifactRoot = path.join(root, "patch-artifacts");
    payloadArtifactRoot = path.join(root, "payload-artifacts");
    authorizationPath = path.join(root, "authorization.json");
    outputPath = path.join(root, "operator-handoff.json");
    await Promise.all([
      mkdir(path.join(repositoryRoot, "docs"), { recursive: true }),
      mkdir(patchArtifactRoot, { recursive: true }),
      mkdir(payloadArtifactRoot, { recursive: true }),
    ]);
    await git(["init", "--initial-branch=main"], repositoryRoot);
    const documentPath = path.join(repositoryRoot, "docs/int3d.md");
    await writeFile(documentPath, "base\n", "utf8");
    await git(["add", "docs/int3d.md"], repositoryRoot);
    await git([
      "-c",
      "user.name=INT-3d Suite",
      "-c",
      "user.email=int3d@example.invalid",
      "commit",
      "-m",
      "fixture base",
    ], repositoryRoot);
    baseRevision = (await git(["rev-parse", "HEAD"], repositoryRoot)).trim();

    await writeFile(documentPath, "base\npacket builder\n", "utf8");
    const patch = await git(
      ["diff", "--binary", "--no-ext-diff", "--", "docs/int3d.md"],
      repositoryRoot,
    );
    await writeFile(documentPath, "base\n", "utf8");
    const patchRef = await createFilePrPayloadArtifactPort(
      patchArtifactRoot,
    ).write(Buffer.from(patch, "utf8"), "text/x-diff");

    task = await approvedTask(baseRevision);
    read = terminalRead(patchRef);
    listTasks = vi.fn(async () => [task]);
    readBinding = vi.fn(async () => ({
      workItemId: task.workItemId,
      harnessRunId: RUN_ID,
      runManifestRef: ref(D_HASH),
      runManifestHash: D_HASH,
      boundAt: "2026-08-03T12:06:00.000Z",
    }));
    await writeFile(
      authorizationPath,
      `${JSON.stringify(safeAuthorization(), null, 2)}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("builds a packet that the real INT-3c validator accepts", async () => {
    const output = captureOutput();
    const exitCode = await build(output);
    const validated = await loadAndValidatePacket(outputPath);

    expect(exitCode).toBe(INT3D_EXIT.ok);
    expect(output.stderr.text).toBe("");
    expect(output.stdout.text).toContain("INT3D_PACKET_BUILT");
    expect(validated.handoff.workItemId).toBe(WORK_ITEM_ID);
    expect(validated.handoff.generatedAt).toBe(FIXED_NOW.toISOString());
    expect(validated.actuation.canonicalBytes).toBe(
      JSON.parse(await readFile(outputPath, "utf8")).actuation.canonicalBytes,
    );
  });

  it("rejects a payload byte perturbed after canonicalization", async () => {
    const output = captureOutput();
    expect(await build(output)).toBe(INT3D_EXIT.ok);
    const packet = JSON.parse(await readFile(outputPath, "utf8"));
    const originalTitle = packet.actuation.payload.title as string;
    packet.actuation.payload.title = `${originalTitle}!`;
    expect(packet.actuation.payload.title).not.toBe(originalTitle);
    const perturbedPath = path.join(root, "operator-handoff-perturbed.json");
    await writeFile(
      perturbedPath,
      `${JSON.stringify(packet, null, 2)}\n`,
      "utf8",
    );

    await expect(loadAndValidatePacket(perturbedPath)).rejects.toThrow(
      "payload canonical bytes do not match the typed payload",
    );
  });

  it("refuses a non-terminal bound run before packet construction", async () => {
    read = {
      status: {
        ...read.status,
        state: "running",
        outcome: undefined,
      },
      events: read.events.filter((event) => event.type !== "VerificationCompleted"),
      deliverables: [],
    };
    const output = captureOutput();

    expect(await build(output)).toBe(INT3D_EXIT.runNotTerminal);
    expect(output.stderr.text).toContain("INT3D_RUN_NOT_TERMINAL");
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses before argument parsing when the token environment key is set", async () => {
    const output = captureOutput();
    const exitCode = await runInt3dBuilder({
      argv: [],
      env: { GITHUB_INSTALLATION_TOKEN: TOKEN_SENTINEL },
      stdout: output.stdout,
      stderr: output.stderr,
      dependencies: {
        listTasks,
        getRunBinding: readBinding,
      },
    });

    expect(exitCode).toBe(INT3D_EXIT.tokenEnvironment);
    expect(output.stderr.text).toContain("INT3D_TOKEN_ENVIRONMENT_REFUSED");
    expect(output.stderr.text).not.toContain(TOKEN_SENTINEL);
    expect(listTasks).not.toHaveBeenCalled();
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses an authorization token key nested at any depth", async () => {
    await writeFile(
      authorizationPath,
      JSON.stringify({
        ...safeAuthorization(),
        issuance: { response: [{ metadata: { token: TOKEN_SENTINEL } }] },
      }),
      "utf8",
    );
    const output = captureOutput();

    expect(await build(output)).toBe(INT3D_EXIT.authorizationContainsToken);
    expect(output.stderr.text).toContain("INT3D_AUTHORIZATION_CONTAINS_TOKEN");
    expect(output.stderr.text).not.toContain(TOKEN_SENTINEL);
    expect(listTasks).not.toHaveBeenCalled();
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    {
      label: "global HALT",
      halt: { global: true, repositories: [] },
      exit: () => INT3D_EXIT.haltGlobal,
      reason: "INT3D_HALT_GLOBAL",
    },
    {
      label: "repository HALT",
      halt: { global: false, repositories: [PINNED_REPOSITORY] },
      exit: () => INT3D_EXIT.haltRepository,
      reason: "INT3D_HALT_REPOSITORY",
    },
  ])("refuses $label without writing a packet", async (testCase) => {
    const output = captureOutput();

    expect(await build(output, {
      readHaltState: async () => testCase.halt,
    })).toBe(testCase.exit());
    expect(output.stderr.text).toContain(testCase.reason);
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to overwrite an existing packet before reading the store", async () => {
    await writeFile(outputPath, "operator-owned\n", "utf8");
    const output = captureOutput();

    expect(await build(output)).toBe(INT3D_EXIT.outputExists);
    expect(output.stderr.text).toContain("INT3D_OUTPUT_EXISTS");
    expect(await readFile(outputPath, "utf8")).toBe("operator-owned\n");
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("refuses a terminal run whose verification is not eligible", async () => {
    const verification = read.events.find(
      (event) => event.type === "VerificationCompleted",
    );
    expect(verification).toBeDefined();
    if (verification) {
      verification.payload = {
        ...verification.payload,
        passed: false,
        verdict: "failed",
      };
    }
    const output = captureOutput();

    expect(await build(output)).toBe(INT3D_EXIT.handoffIneligible);
    expect(output.stderr.text).toContain("INT3D_HANDOFF_INELIGIBLE");
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the builder structurally outside every GitHub request path", async () => {
    const source = await readFile(
      new URL("../../scripts/ops/int3d-build-packet.mjs", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("pr-payload-github-client");
    expect(source).not.toContain("pr-payload-sender");
    expect(source).not.toMatch(/\bfetch\s*\(/u);
    expect(source).not.toContain("node:http");
    expect(source).not.toContain("node:https");
  });

  async function build(
    output: ReturnType<typeof captureOutput>,
    dependencyOverrides: Record<string, unknown> = {},
  ): Promise<number> {
    return runInt3dBuilder({
      argv: builderArguments(),
      env: { HALT_FILE: path.join(root, "HALT") },
      stdout: output.stdout,
      stderr: output.stderr,
      dependencies: {
        listTasks,
        getRunBinding: readBinding,
        readPort: { readRun: vi.fn(async () => read) },
        now: () => FIXED_NOW,
        readHaltState: async () => ({ global: false, repositories: [] }),
        ...dependencyOverrides,
      },
    });
  }

  function builderArguments(): string[] {
    return [
      "--work-item",
      WORK_ITEM_ID,
      "--repository-root",
      repositoryRoot,
      "--base-ref",
      "main",
      "--patch-artifact-root",
      patchArtifactRoot,
      "--payload-artifact-root",
      payloadArtifactRoot,
      "--authorization",
      authorizationPath,
      "--out",
      outputPath,
    ];
  }
});

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
    workItemId: WORK_ITEM_ID,
    correlationId: "int3d-one-correlation",
    lifecycle: "handoff_ready",
    proposal: {
      ...(fixture.proposal as object),
      title: "Build the verified INT-3d operator packet",
      objective: "Construct the credential-free packet for the verified documentation patch.",
    },
    repository: {
      provider: "github",
      nameWithOwner: PINNED_REPOSITORY,
      baseRevision,
      allowedPaths: ["docs/**"],
      forbiddenPaths: ["src/**", "ops/**"],
    },
    deadline: "2026-08-03T13:00:00.000Z",
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
      actor: { type: "operator", id: "int3d-operator" },
      decidedAt: "2026-08-03T12:05:00.000Z",
      policyVersion: "dispatch-policy-v1",
      policyHash: C_HASH,
      approvedTaskHash: ZERO_HASH,
    },
    timestamps: {
      proposedAt: "2026-08-03T12:00:00.000Z",
      approvedAt: "2026-08-03T12:05:00.000Z",
      runBoundAt: "2026-08-03T12:06:00.000Z",
      terminalAt: "2026-08-03T12:29:59.000Z",
      updatedAt: "2026-08-03T12:30:00.000Z",
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

function terminalRead(patchRef: ReturnType<typeof ref>) {
  return {
    status: {
      runId: RUN_ID,
      state: "completed" as const,
      attempt: 1,
      outcome: "completed" as const,
      egressPolicy: "deny" as const,
      createdAt: "2026-08-03T12:06:00.000Z",
      updatedAt: "2026-08-03T12:29:59.000Z",
    },
    events: [
      {
        seq: 1,
        type: "ContractCompiled",
        payload: { risk_class: "low" },
      },
      {
        seq: 2,
        type: "EnvironmentPrepared",
        payload: { manifest_hash: D_HASH },
      },
      {
        seq: 3,
        type: "VerificationCompleted",
        payload: {
          passed: true,
          verdict: "completed",
          report_ref: ref(E_HASH).uri,
        },
      },
    ],
    deliverables: [
      { deliverableType: "workspace_patch", artifact: patchRef },
      { deliverableType: "change_summary", artifact: ref(A_HASH) },
      { deliverableType: "verification_report", artifact: ref(E_HASH) },
    ],
  };
}

function safeAuthorization() {
  return {
    identity: "ceremony-app#installation-1001",
    repositorySelection: "selected",
    repositories: [PINNED_REPOSITORY],
    permissions: {
      contents: "write",
      pullRequests: "write",
      extraWriteScopes: [],
    },
    expiresAt: "2026-08-03T13:00:00.000Z",
  };
}

function ref(hash: `sha256:${string}`) {
  return {
    uri: `artifact://sha256/${hash.slice("sha256:".length)}`,
    sha256: hash,
  } as const;
}

function captureOutput() {
  const stdout = {
    text: "",
    write(value: string) {
      this.text += value;
      return true;
    },
  };
  const stderr = {
    text: "",
    write(value: string) {
      this.text += value;
      return true;
    },
  };
  return { stdout, stderr };
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      PATH: process.env.PATH,
    },
  });
  return stdout;
}
