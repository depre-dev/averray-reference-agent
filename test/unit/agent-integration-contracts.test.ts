import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  agentRunProjectionV1Schema,
  agentTaskApprovalHashMatches,
  agentTaskV1Schema,
  assertAgentRunProjectionWithinTask,
  assertVerifiedHandoffMatchesTaskAndRun,
  canonicalContractJson,
  hashAgentTaskApprovalPayload,
  hashCanonicalContract,
  hermesDecisionRecordV2Schema,
  parseHermesDecisionRecord,
  parseLegacyCodexTask,
  toHermesDecisionCompatibilityView,
  toLegacyAgentTaskCompatibilityView,
  verifiedHandoffV1Schema,
  type AgentTaskV1,
} from "../../packages/schemas/src/index.js";

describe("INT-0 agent integration contracts", () => {
  it("accepts every published current-version fixture", () => {
    const cases = [
      [agentTaskV1Schema, fixture("agent-task-v1.json")],
      [agentRunProjectionV1Schema, fixture("agent-run-projection-v1.json")],
      [verifiedHandoffV1Schema, fixture("verified-handoff-v1.json")],
      [hermesDecisionRecordV2Schema, fixture("hermes-decision-v2.json")],
    ] as const;
    for (const [schema, input] of cases) {
      const parsed = schema.parse(input);
      expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });

  it("rejects unknown versions and undeclared fields", () => {
    const task = fixtureRecord("agent-task-v1.json");
    expect(() => agentTaskV1Schema.parse({ ...task, schemaVersion: 2 })).toThrow();
    expect(() => agentTaskV1Schema.parse({ ...task, undeclaredAuthority: true })).toThrow();

    const decision = fixtureRecord("hermes-decision-v2.json");
    expect(() => parseHermesDecisionRecord({ ...decision, schemaVersion: 3 })).toThrow();
  });

  it("rejects inconsistent hashes, duplicate authority, and child delegation", () => {
    const task = fixtureRecord("agent-task-v1.json");
    expect(() => agentTaskV1Schema.parse({
      ...task,
      intent: {
        ...(task.intent as Record<string, unknown>),
        templateHash: hash("9"),
      },
    })).toThrow(/TaskIntent ref hash/);

    const requestedAuthority = task.requestedAuthority as Record<string, unknown>;
    expect(() => agentTaskV1Schema.parse({
      ...task,
      requestedAuthority: {
        ...requestedAuthority,
        delegable: true,
      },
    })).toThrow();
    expect(() => agentTaskV1Schema.parse({
      ...task,
      requestedAuthority: {
        ...requestedAuthority,
        maxChildren: 1,
        maxConcurrentChildren: 1,
      },
    })).toThrow(/zero child budgets/);
    expect(() => agentTaskV1Schema.parse({
      ...task,
      requestedAuthority: {
        ...requestedAuthority,
        grants: [
          ...requestedAuthority.grants as unknown[],
          ...(requestedAuthority.grants as unknown[]),
        ],
      },
    })).toThrow(/capability grant ids must be unique/);
  });

  it("keeps request and approval authority out of executor and verifier roles", async () => {
    const task = fixtureRecord("agent-task-v1.json");
    expect(() => agentTaskV1Schema.parse({
      ...task,
      proposal: {
        ...(task.proposal as Record<string, unknown>),
        requestedBy: { type: "harness", id: "executor" },
      },
    })).toThrow(/cannot request/);

    const approved = await approvedTask();
    expect(() => agentTaskV1Schema.parse({
      ...approved,
      approval: {
        ...approved.approval,
        actor: { type: "harness", id: "executor" },
      },
    })).toThrow(/cannot be decided/);
  });
});

describe("canonical contract hashing and approval binding", () => {
  it("serializes recursively by code-unit key order and hashes deterministically", async () => {
    expect(canonicalContractJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe('{"a":{"c":3,"d":4},"b":2}');
    await expect(hashCanonicalContract({ b: 2, a: 1 })).resolves.toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
    await expect(hashCanonicalContract({ a: 1, b: 2 })).resolves.toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });

  it("rejects values that cannot have an unambiguous authorization hash", () => {
    expect(() => canonicalContractJson({ missing: undefined })).toThrow(/undefined field/);
    expect(() => canonicalContractJson({ invalid: Number.NaN })).toThrow(/non-finite/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalContractJson(cyclic)).toThrow(/cyclic/);
  });

  it("binds approval to immutable task content and invalidates material edits", async () => {
    const task = await approvedTask();
    await expect(agentTaskApprovalHashMatches(task)).resolves.toBe(true);

    const changed = agentTaskV1Schema.parse({
      ...task,
      proposal: {
        ...task.proposal,
        objective: "A materially different objective.",
      },
    });
    await expect(agentTaskApprovalHashMatches(changed)).resolves.toBe(false);
  });

  it("does not treat lifecycle bookkeeping as approved task content", async () => {
    const proposed = agentTaskV1Schema.parse(fixture("agent-task-v1.json"));
    const approved = await approvedTask();
    await expect(hashAgentTaskApprovalPayload(proposed)).resolves.toBe(
      await hashAgentTaskApprovalPayload(approved),
    );
  });
});

describe("task-to-run authority attenuation", () => {
  it("accepts an identity-matched projection within approved grants and budgets", async () => {
    const task = await approvedTask();
    const projection = agentRunProjectionV1Schema.parse(fixture("agent-run-projection-v1.json"));
    expect(() => assertAgentRunProjectionWithinTask(task, projection)).not.toThrow();
  });

  it("rejects capability, network, budget, policy, and identity expansion", async () => {
    const task = await approvedTask();
    const base = agentRunProjectionV1Schema.parse(fixture("agent-run-projection-v1.json"));

    const capabilityExpansion = agentRunProjectionV1Schema.parse({
      ...base,
      manifest: {
        ...base.manifest,
        effectiveCapabilities: ["fs.write_file", "shell.run"],
      },
    });
    expect(() => assertAgentRunProjectionWithinTask(task, capabilityExpansion))
      .toThrow(/expands capability/);

    const networkExpansion = agentRunProjectionV1Schema.parse({
      ...base,
      manifest: {
        ...base.manifest,
        network: { allowlist: ["example.com"] },
      },
    });
    expect(() => assertAgentRunProjectionWithinTask(task, networkExpansion))
      .toThrow(/network access/);

    const budgetExpansion = agentRunProjectionV1Schema.parse({
      ...base,
      budget: {
        ...base.budget,
        toolCallsLimit: task.budget.toolCalls + 1,
      },
    });
    expect(() => assertAgentRunProjectionWithinTask(task, budgetExpansion))
      .toThrow(/budget exceeds/);

    const policyMismatch = agentRunProjectionV1Schema.parse({
      ...base,
      manifest: {
        ...base.manifest,
        policyHash: hash("9"),
      },
    });
    expect(() => assertAgentRunProjectionWithinTask(task, policyMismatch))
      .toThrow(/policy hash/);

    const identityMismatch = agentRunProjectionV1Schema.parse({
      ...base,
      workItemId: "work-other",
    });
    expect(() => assertAgentRunProjectionWithinTask(task, identityMismatch))
      .toThrow(/identity/);
  });

  it("requires degraded and failed projections to explain themselves", () => {
    const base = agentRunProjectionV1Schema.parse(fixture("agent-run-projection-v1.json"));
    expect(() => agentRunProjectionV1Schema.parse({
      ...base,
      source: {
        ...base.source,
        health: "unavailable",
      },
    })).toThrow(/explicit reason/);
    expect(() => agentRunProjectionV1Schema.parse({
      ...base,
      heartbeat: { ...base.heartbeat, status: "terminal" },
      run: {
        ...base.run,
        state: "failed",
        terminal: true,
        outcome: "failed",
      },
    })).toThrow(/structured failure details/);
  });
});

describe("verified handoff eligibility", () => {
  it("accepts a completed independently verified handoff with all checks passed", () => {
    const handoff = verifiedHandoffV1Schema.parse(fixture("verified-handoff-v1.json"));
    expect(handoff.eligibleForPrOpen).toBe(true);
    expect(handoff.verification.verifier.type).toBe("verifier");
  });

  it("never permits failed checks, rejected verification, or a non-verifier to open a PR", () => {
    const handoff = fixtureRecord("verified-handoff-v1.json");
    expect(() => verifiedHandoffV1Schema.parse({
      ...handoff,
      checks: [{
        ...(handoff.checks as Array<Record<string, unknown>>)[0],
        status: "failed",
      }],
    })).toThrow(/every recorded check/);

    expect(() => verifiedHandoffV1Schema.parse({
      ...handoff,
      verification: {
        ...(handoff.verification as Record<string, unknown>),
        verified: false,
        decision: "reject",
      },
    })).toThrow(/verified acceptance/);

    expect(() => verifiedHandoffV1Schema.parse({
      ...handoff,
      verification: {
        ...(handoff.verification as Record<string, unknown>),
        verifier: { type: "harness", id: "executor" },
      },
    })).toThrow(/verifier type/);
  });

  it("binds an eligible handoff to the exact approved task, run, manifest, and verifier plan", async () => {
    const task = await approvedTask();
    const running = agentRunProjectionV1Schema.parse(fixture("agent-run-projection-v1.json"));
    const handoffFixture = fixtureRecord("verified-handoff-v1.json");
    const handoffDecisionHash = (
      (handoffFixture.verification as Record<string, unknown>).decisionHash
    ) as string;
    const handoffDecisionRef = (
      (handoffFixture.verification as Record<string, unknown>).decisionRef
    ) as Record<string, unknown>;
    const completed = agentRunProjectionV1Schema.parse({
      ...running,
      heartbeat: {
        ...running.heartbeat,
        status: "terminal",
      },
      run: {
        ...running.run,
        state: "completed",
        terminal: true,
        outcome: "completed",
      },
      verification: {
        status: "passed",
        decisionRef: handoffDecisionRef,
        decisionHash: handoffDecisionHash,
      },
    });
    const handoff = verifiedHandoffV1Schema.parse({
      ...handoffFixture,
      taskHash: task.approval.approvedTaskHash,
    });

    await expect(
      assertVerifiedHandoffMatchesTaskAndRun(task, completed, handoff),
    ).resolves.toBeUndefined();

    const wrongManifest = verifiedHandoffV1Schema.parse({
      ...handoff,
      runManifestRef: {
        ...handoff.runManifestRef,
        sha256: hash("9"),
      },
      runManifestHash: hash("9"),
    });
    await expect(
      assertVerifiedHandoffMatchesTaskAndRun(task, completed, wrongManifest),
    ).rejects.toThrow(/manifest hash/);
  });
});

describe("legacy read compatibility", () => {
  it("reads V1 Hermes decisions without rewriting them", () => {
    const input = fixture("legacy-hermes-decision-v1.json");
    const parsed = parseHermesDecisionRecord(input);
    const view = toHermesDecisionCompatibilityView(input);

    expect(parsed).toEqual(input);
    expect(view).toMatchObject({
      sourceVersion: 1,
      decisionType: "routing",
      approvalDecision: "routed to codex",
      mutates: false,
      legacy: true,
    });
  });

  it("reads legacy codex_task records conservatively and keeps them non-dispatchable", () => {
    const input = fixture("legacy-codex-task-v1.json");
    const parsed = parseLegacyCodexTask(input);
    const view = toLegacyAgentTaskCompatibilityView(input);

    expect(parsed.progressMessage).toBe(
      "Historical fields are preserved by the compatibility reader.",
    );
    expect(view).toMatchObject({
      workItemId: "codex-task-owner-repo-new-legacy",
      executor: { kind: "direct", directAgent: "codex" },
      legacyRiskTier: "unknown",
      nonDispatchable: true,
    });
    expect(view.missingRequiredAgentTaskFields).toContain("taskIntentRef");
    expect(view.missingRequiredAgentTaskFields).toContain("approvalPolicyHash");
  });

  it("rejects malformed legacy records instead of manufacturing missing identity", () => {
    const legacy = fixtureRecord("legacy-codex-task-v1.json");
    expect(() => parseLegacyCodexTask({ ...legacy, id: "" })).toThrow();
    expect(() => parseLegacyCodexTask({ ...legacy, schemaVersion: 2 })).toThrow();
  });

  it("makes mutation truth explicit in V2 decisions", () => {
    const decision = fixtureRecord("hermes-decision-v2.json");
    expect(() => hermesDecisionRecordV2Schema.parse({
      ...decision,
      effects: {
        mutates: false,
        mutations: [{
          system: "github",
          action: "open_pr",
          target: "owner/repo",
        }],
        authorityChanged: false,
        budgetChanged: false,
      },
    })).toThrow(/non-mutating decisions/);
  });
});

async function approvedTask(): Promise<AgentTaskV1> {
  const proposed = agentTaskV1Schema.parse(fixture("agent-task-v1.json"));
  const approvedTaskHash = await hashAgentTaskApprovalPayload(proposed);
  return agentTaskV1Schema.parse({
    ...proposed,
    lifecycle: "approved",
    approval: {
      ...proposed.approval,
      status: "approved",
      actor: { type: "operator", id: "operator-one" },
      decidedAt: "2026-07-23T12:01:00.000Z",
      approvedTaskHash,
    },
    timestamps: {
      ...proposed.timestamps,
      approvedAt: "2026-07-23T12:01:00.000Z",
      updatedAt: "2026-07-23T12:01:00.000Z",
    },
  });
}

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/agent-integration/${name}`, import.meta.url), "utf8"),
  ) as unknown;
}

function fixtureRecord(name: string): Record<string, unknown> {
  return fixture(name) as Record<string, unknown>;
}

function hash(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
