import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canonicalContractJson,
  pullRequestPayloadV1Schema,
  verifiedHandoffV1Schema,
} from "@avg/schemas";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  FakeGitHubClient,
  FAKE_GITHUB_REPOSITORY,
} from "../helpers/fake-github-client.js";

// The committed operator entry point is JavaScript so it can be invoked with
// plain Node after the required workspace build.
// @ts-expect-error The .mjs entry point intentionally has no declaration file.
import {
  INT3C_EXIT,
  runInt3cDriver,
} from "../../scripts/ops/int3c-send.mjs";

const TOKEN_SENTINEL = "INT3C_TEST_TOKEN_SENTINEL_DO_NOT_USE";
const BASE_REVISION = "a".repeat(40);

describe.sequential("INT-3c operator driver", () => {
  let root: string;
  let handoffPath: string;
  let evidencePath: string;
  let packet: Awaited<ReturnType<typeof operatorPacket>>;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "int3c-driver-"));
    handoffPath = path.join(root, "handoff.json");
    evidencePath = path.join(root, "evidence.json");
    packet = await operatorPacket();
    await writeFile(handoffPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("runs send end-to-end through the shared fake without leaking the token", async () => {
    const fakeGitHub = new FakeGitHubClient(BASE_REVISION);
    const output = captureOutput();
    let clientConfig: unknown;
    const exitCode = await runInt3cDriver({
      argv: sendArguments(),
      env: driverEnvironment(),
      stdout: output.stdout,
      stderr: output.stderr,
      dependencies: {
        createGitHubClient(config: unknown) {
          clientConfig = structuredClone(config);
          return fakeGitHub;
        },
      },
    });

    const evidenceBytes = await readFile(evidencePath, "utf8");
    expect(exitCode).toBe(INT3C_EXIT.ok);
    expect(fakeGitHub.createCalls).toBe(1);
    expect(clientConfig).toMatchObject({
      repository: FAKE_GITHUB_REPOSITORY,
      installationToken: TOKEN_SENTINEL,
      issuedAuthorization: packet.issuedAuthorization,
    });
    expect(output.stdout.text).toContain("INT3C_SEND_OPENED");
    expect(output.stderr.text).toBe("");
    expect(output.stdout.text).not.toContain(TOKEN_SENTINEL);
    expect(output.stderr.text).not.toContain(TOKEN_SENTINEL);
    expect(evidenceBytes).not.toContain(TOKEN_SENTINEL);
    expect(JSON.parse(evidenceBytes)).toEqual({
      githubAppInstallationIdentity: "ceremony-app#installation-1001",
      repository: FAKE_GITHUB_REPOSITORY,
      repositorySelection: "selected",
      permissions: {
        contents: "write",
        pullRequests: "write",
      },
      extraWriteScopes: [],
      liveBaseSha: BASE_REVISION,
      derivedHeadRef: packet.actuation.payload.head.ref,
      outcome: "opened",
      pullRequestNumber: 1,
      headCommitSha: "e".repeat(40),
      payloadArtifactHash: packet.actuation.artifact.sha256,
      remoteHeadTreeMatchesPayload: true,
    });
  });

  it("keeps preflight read-only and imports no send operation on its path", async () => {
    const fakeGitHub = new FakeGitHubClient(BASE_REVISION);
    const output = captureOutput();
    const exitCode = await runInt3cDriver({
      argv: preflightArguments(),
      env: driverEnvironment(),
      stdout: output.stdout,
      stderr: output.stderr,
      dependencies: {
        createGitHubClient: () => fakeGitHub,
      },
    });

    expect(exitCode).toBe(INT3C_EXIT.ok);
    expect(fakeGitHub.materializeCalls).toBe(0);
    expect(fakeGitHub.createCalls).toBe(0);
    expect(fakeGitHub.pullRequests).toHaveLength(0);
    expect(JSON.parse(await readFile(evidencePath, "utf8"))).toMatchObject({
      outcome: "ready",
      liveBaseSha: BASE_REVISION,
    });
    const preflightSource = await readFile(
      new URL("../../scripts/ops/int3c-preflight.mjs", import.meta.url),
      "utf8",
    );
    expect(preflightSource).not.toContain("sendPullRequestPayload");
  });

  it.each([
    {
      label: "missing token",
      argv: () => preflightArguments(),
      env: () => ({ HALT_FILE: path.join(root, "HALT") }),
      expectedExit: () => INT3C_EXIT.tokenUnavailable,
      expectedMessage: "INT3C_TOKEN_UNAVAILABLE",
      mutate: () => undefined,
      halt: undefined,
    },
    {
      label: "missing confirmation",
      argv: () => sendArguments().slice(0, -2),
      env: () => driverEnvironment(),
      expectedExit: () => INT3C_EXIT.confirmationRequired,
      expectedMessage: "INT3C_CONFIRMATION_REQUIRED",
      mutate: () => undefined,
      halt: undefined,
    },
    {
      label: "mismatched confirmation",
      argv: () => sendArguments().map(
        (value, index, values) => values[index - 1] === "--confirm"
          ? "depre-dev/other"
          : value,
      ),
      env: () => driverEnvironment(),
      expectedExit: () => INT3C_EXIT.confirmationRequired,
      expectedMessage: "INT3C_CONFIRMATION_REQUIRED",
      mutate: () => undefined,
      halt: undefined,
    },
    {
      label: "ineligible handoff",
      argv: () => preflightArguments(),
      env: () => driverEnvironment(),
      expectedExit: () => INT3C_EXIT.handoffIneligible,
      expectedMessage: "INT3C_HANDOFF_INELIGIBLE",
      mutate: () => {
        packet.handoff.eligibleForPrOpen = false;
      },
      halt: undefined,
    },
    {
      label: "global HALT",
      argv: () => preflightArguments(),
      env: () => driverEnvironment(),
      expectedExit: () => INT3C_EXIT.haltGlobal,
      expectedMessage: "INT3C_HALT_GLOBAL",
      mutate: () => undefined,
      halt: { global: true, repositories: [] },
    },
    {
      label: "repository HALT",
      argv: () => preflightArguments(),
      env: () => driverEnvironment(),
      expectedExit: () => INT3C_EXIT.haltRepository,
      expectedMessage: "INT3C_HALT_REPOSITORY",
      mutate: () => undefined,
      halt: { global: false, repositories: [FAKE_GITHUB_REPOSITORY] },
    },
  ])("refuses $label before any GitHub call", async (testCase) => {
    testCase.mutate();
    await writeFile(handoffPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
    const fakeGitHub = new FakeGitHubClient(BASE_REVISION);
    const output = captureOutput();
    const exitCode = await runInt3cDriver({
      argv: testCase.argv(),
      env: testCase.env(),
      stdout: output.stdout,
      stderr: output.stderr,
      dependencies: {
        createGitHubClient: () => fakeGitHub,
        ...(testCase.halt
          ? { readHaltState: async () => testCase.halt }
          : {}),
      },
    });

    expect(exitCode).toBe(testCase.expectedExit());
    expect(output.stderr.text).toContain(testCase.expectedMessage);
    expect(fakeGitHub.remoteCalls).toBe(0);
    await expect(readFile(evidencePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  function sendArguments() {
    return [
      "send",
      "--handoff",
      handoffPath,
      "--repo",
      FAKE_GITHUB_REPOSITORY,
      "--evidence",
      evidencePath,
      "--confirm",
      FAKE_GITHUB_REPOSITORY,
    ];
  }

  function preflightArguments() {
    return [
      "preflight",
      "--handoff",
      handoffPath,
      "--repo",
      FAKE_GITHUB_REPOSITORY,
      "--evidence",
      evidencePath,
    ];
  }

  function driverEnvironment() {
    return {
      GITHUB_INSTALLATION_TOKEN: TOKEN_SENTINEL,
      HALT_FILE: path.join(root, "HALT"),
    };
  }
});

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

async function operatorPacket() {
  const fixture = JSON.parse(await readFile(
    new URL(
      "../fixtures/agent-integration/verified-handoff-v1.json",
      import.meta.url,
    ),
    "utf8",
  ));
  const handoff = verifiedHandoffV1Schema.parse(fixture);
  const patchRef = handoff.deliverables.patchRef!;
  const payload = pullRequestPayloadV1Schema.parse({
    schemaVersion: 1,
    kind: "pull_request_payload",
    repository: FAKE_GITHUB_REPOSITORY,
    base: {
      ref: "main",
      revision: BASE_REVISION,
    },
    head: {
      ref: "harness/7db95d47-2cca-5572-a198-434723821fba",
      treeSha: "b".repeat(40),
    },
    title: "INT-3c operator driver fixture",
    body: "A verified, deterministic pull-request payload.",
    patch: {
      ref: patchRef,
      sha256: patchRef.sha256,
      bytes: "diff --git a/docs/example.md b/docs/example.md\n",
    },
    source: {
      workItemId: handoff.workItemId,
      taskVersion: handoff.taskVersion,
      approvedTaskHash: handoff.taskHash,
      harnessRunId: handoff.harnessRunId,
      verificationDecisionHash: handoff.verification.decisionHash,
    },
  });
  const canonicalBytes = canonicalContractJson(payload);
  const digest = createHash("sha256").update(canonicalBytes, "utf8").digest("hex");
  return {
    schemaVersion: 1,
    kind: "int3c_operator_handoff",
    handoff,
    actuation: {
      artifact: {
        uri: `artifact://sha256/${digest}`,
        sha256: `sha256:${digest}`,
        mediaType: "application/vnd.averray.pull-request-payload.v1+json",
        sizeBytes: Buffer.byteLength(canonicalBytes, "utf8"),
      },
      payload,
      canonicalBytes,
    },
    issuedAuthorization: {
      identity: "ceremony-app#installation-1001",
      repositorySelection: "selected",
      permissions: {
        contents: "write",
        pullRequests: "write",
        extraWriteScopes: [],
      },
    },
  } as const;
}
