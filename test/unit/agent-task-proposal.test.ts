import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  approveAgentTask,
  dispatchPolicyIdentity,
  PILOT_CAPABILITY_IDS,
  proposeAgentTask,
  type AgentTaskArtifactWriter,
  type ProposeAgentTaskDeps,
  type ProposeAgentTaskInput,
} from "../../packages/averray-mcp/src/agent-task-proposal.js";
import {
  listDispatchableAgentTasks,
  type AgentTaskStoreQuery,
} from "../../packages/averray-mcp/src/agent-task-store.js";
import {
  buildTaskIntentArtifact,
} from "../../packages/averray-mcp/src/task-intent-mapping.js";
import {
  workspacePathForTask,
} from "../../packages/averray-mcp/src/workspace-path.js";
import {
  agentTaskApprovalHashMatches,
  agentTaskV1Schema,
  canonicalContractJson,
  serializeTaskIntent,
  type AgentTaskV1,
  type ArtifactRef,
} from "../../packages/schemas/src/index.js";
import {
  VETTED_CAPABILITIES,
} from "../../services/harness-dispatcher/src/profile-manifest.js";

const NOW = new Date("2026-07-25T14:00:00.000Z");
const APPROVED_AT = new Date("2026-07-25T14:05:00.000Z");
const POLICY_CONFIG = {
  allowedRepos: ["depre-dev/averray-reference-agent"],
  allowedRiskTiers: ["low", "medium"],
  requireOperatorApproval: true,
};
const CEREMONY_FIXTURES = [
  "docs-fix",
  "add-unit-test",
  "small-refactor",
  "lint-format",
  "lint-format-green",
  "lint-format-red",
] as const;
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true })),
  );
});

describe("AgentTask proposal authoring", () => {
  it("persists a pending, deny-network proposal with pinned audit artifacts and pilot authority", async () => {
    const store = new MemoryTaskStore();
    const artifacts = new MemoryArtifactStore();

    const task = await proposeAgentTask(
      proposalInput(),
      proposalDeps(store, artifacts),
    );

    expect(agentTaskV1Schema.parse(task)).toEqual(task);
    expect(store.get(task.workItemId, task.taskVersion)).toEqual(task);
    expect(task).toMatchObject({
      schemaVersion: 1,
      kind: "agent_task",
      taskVersion: 1,
      lifecycle: "proposed",
      risk: {
        tier: "low",
        irreversible: false,
      },
      requestedAuthority: {
        network: "deny",
        maxChildren: 0,
        maxConcurrentChildren: 0,
        delegable: false,
      },
      executor: {
        kind: "harness",
      },
      approval: {
        required: "operator",
        status: "pending",
        policyVersion: "dispatch-policy-v1",
      },
    });
    expect(task.approval).not.toHaveProperty("approvedTaskHash");
    expect(task.requestedAuthority.grants.map(({ capabilityId }) =>
      capabilityId)).toEqual([...PILOT_CAPABILITY_IDS]);
    expect(task.intent.templateRef.sha256).toBe(task.intent.templateHash);
    expect(task.acceptance.verifierPlanRef.sha256).toBe(
      task.acceptance.verifierPlanHash,
    );
    expect(artifacts.refs).toEqual([
      task.acceptance.verifierPlanRef,
      task.intent.templateRef,
    ]);
  });

  it("maps byte-identical TaskIntents for different valid placeholder hashes", async () => {
    const store = new MemoryTaskStore();
    const task = await proposeAgentTask(
      proposalInput(),
      proposalDeps(store, new MemoryArtifactStore()),
    );
    const firstHash = `sha256:${"1".repeat(64)}` as const;
    const secondHash = `sha256:${"2".repeat(64)}` as const;
    const first = agentTaskV1Schema.parse({
      ...task,
      intent: {
        ...task.intent,
        templateHash: firstHash,
        templateRef: contentRef(firstHash),
      },
    });
    const second = agentTaskV1Schema.parse({
      ...task,
      intent: {
        ...task.intent,
        templateHash: secondHash,
        templateRef: contentRef(secondHash),
      },
    });
    const workspacePath = workspacePathForTask(
      task.workItemId,
      task.taskVersion,
    );

    const firstBytes = serializeTaskIntent(
      (await buildTaskIntentArtifact(first, { workspacePath })).intent,
    );
    const secondBytes = serializeTaskIntent(
      (await buildTaskIntentArtifact(second, { workspacePath })).intent,
    );

    expect(firstBytes).toBe(secondBytes);
    expect(JSON.parse(firstBytes)).not.toHaveProperty(
      "spec.intent.templateHash",
    );
  });

  it("uses an explicit newer task version in the persisted task and workspace identity", async () => {
    const task = await proposeAgentTask({
      ...proposalInput(),
      taskVersion: 2,
    }, proposalDeps(
      new MemoryTaskStore(),
      new MemoryArtifactStore(),
    ));
    const workspacePath = workspacePathForTask(
      task.workItemId,
      task.taskVersion,
    );
    const built = await buildTaskIntentArtifact(task, { workspacePath });

    expect(task.taskVersion).toBe(2);
    expect(built.intent.metadata.labels.task_version).toBe("2");
    expect(built.intent.spec.context.workspace.path).toBe(
      "/var/lib/harness-dispatcher/workspaces/proposal-work-001-v2",
    );
  });

  it("changes the policy hash whenever the bound policy config changes", async () => {
    const first = await dispatchPolicyIdentity(
      POLICY_CONFIG,
      "dispatch-policy-v1",
    );
    const second = await dispatchPolicyIdentity(
      { ...POLICY_CONFIG, allowedRiskTiers: ["low"] },
      "dispatch-policy-v1",
    );

    expect(first.policyVersion).toBe(second.policyVersion);
    expect(first.policyHash).not.toBe(second.policyHash);
  });

  it("writes default artifacts content-addressed and treats identical rewrites as no-ops", async () => {
    const root = await temporaryRoot("agent-task-artifacts-");
    const store = new MemoryTaskStore();
    const deps: ProposeAgentTaskDeps = {
      policyConfig: POLICY_CONFIG,
      policyVersion: "dispatch-policy-v1",
      now: () => NOW,
      assertMutationAllowed: async () => undefined,
      putTask: store.put,
      environment: {
        HARNESS_DISPATCH_ARTIFACT_DIR: root,
      },
    };

    const first = await proposeAgentTask(proposalInput(), deps);
    const second = await proposeAgentTask(proposalInput(), deps);
    const files = (await readdir(root)).sort();

    expect(second).toEqual(first);
    expect(files).toEqual([
      `${first.acceptance.verifierPlanHash.slice("sha256:".length)}.json`,
      `${first.intent.templateHash.slice("sha256:".length)}.json`,
    ].sort());
    await expect(readFile(
      path.join(
        root,
        `${first.acceptance.verifierPlanHash.slice("sha256:".length)}.json`,
      ),
      "utf8",
    )).resolves.toBe(canonicalContractJson(
      proposalInput().acceptanceCriteria,
    ));
  });

  it("refuses high risk and a deadline that is not later than now", async () => {
    const store = new MemoryTaskStore();
    const artifacts = new MemoryArtifactStore();
    const deps = proposalDeps(store, artifacts);

    await expect(proposeAgentTask({
      ...proposalInput(),
      riskTier: "high",
    } as unknown as ProposeAgentTaskInput, deps)).rejects.toThrow(
      "High-risk Harness tasks cannot be proposed",
    );
    await expect(proposeAgentTask({
      ...proposalInput(),
      deadline: NOW.toISOString(),
    }, deps)).rejects.toThrow(
      "deadline must be later than now",
    );
    expect(store.size).toBe(0);
    expect(artifacts.refs).toEqual([]);
  });

  it.each(["harness", "verifier", "dispatcher"] as const)(
    "refuses a requestedBy actor of type %s",
    async (type) => {
      const store = new MemoryTaskStore();
      await expect(proposeAgentTask({
        ...proposalInput(),
        requestedBy: { type, id: `${type}-one` },
      } as unknown as ProposeAgentTaskInput, proposalDeps(
        store,
        new MemoryArtifactStore(),
      ))).rejects.toThrow(`${type} cannot request an AgentTask`);
      expect(store.size).toBe(0);
    },
  );

  it("keeps the proposal capability list identical to the vetted profile registry", () => {
    expect([...PILOT_CAPABILITY_IDS]).toEqual([
      ...VETTED_CAPABILITIES.keys(),
    ]);
  });

  it("honors HALT before proposal or approval persistence", async () => {
    const store = new MemoryTaskStore();
    const halted = async (): Promise<void> => {
      throw new Error("Kill switch active");
    };
    await expect(proposeAgentTask(
      proposalInput(),
      {
        ...proposalDeps(store, new MemoryArtifactStore()),
        assertMutationAllowed: halted,
      },
    )).rejects.toThrow("Kill switch active");
    expect(store.size).toBe(0);

    const proposed = await proposeAgentTask(
      proposalInput(),
      proposalDeps(store, new MemoryArtifactStore()),
    );
    await expect(approveAgentTask({
      workItemId: proposed.workItemId,
      taskVersion: proposed.taskVersion,
      actor: { type: "operator", id: "pilot-operator" },
    }, {
      ...approvalDeps(store),
      assertMutationAllowed: halted,
    })).rejects.toThrow("Kill switch active");
    expect(store.get(
      proposed.workItemId,
      proposed.taskVersion,
    )?.lifecycle).toBe("proposed");
  });
});

describe("explicit operator approval", () => {
  it("hash-binds one task and makes only that task dispatchable", async () => {
    const store = new MemoryTaskStore();
    const proposed = await proposeAgentTask(
      proposalInput(),
      proposalDeps(store, new MemoryArtifactStore()),
    );

    const approved = await approveAgentTask({
      workItemId: proposed.workItemId,
      taskVersion: proposed.taskVersion,
      actor: { type: "operator", id: "pilot-operator" },
    }, approvalDeps(store));

    expect(approved).toMatchObject({
      lifecycle: "approved",
      approval: {
        required: "operator",
        status: "approved",
        actor: { type: "operator", id: "pilot-operator" },
        decidedAt: APPROVED_AT.toISOString(),
        approvedTaskHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      timestamps: {
        approvedAt: APPROVED_AT.toISOString(),
        updatedAt: APPROVED_AT.toISOString(),
      },
    });
    await expect(agentTaskApprovalHashMatches(approved)).resolves.toBe(true);
    await expect(listDispatchableAgentTasks({
      query: store.query,
    })).resolves.toEqual([approved]);
  });

  it("refuses a non-operator, a second approval, and an expired task", async () => {
    const store = new MemoryTaskStore();
    const proposed = await proposeAgentTask(
      proposalInput(),
      proposalDeps(store, new MemoryArtifactStore()),
    );

    await expect(approveAgentTask({
      workItemId: proposed.workItemId,
      taskVersion: proposed.taskVersion,
      actor: { type: "hermes", id: "hermes-one" },
    }, approvalDeps(store))).rejects.toThrow(
      "Only an operator may approve",
    );

    await approveAgentTask({
      workItemId: proposed.workItemId,
      taskVersion: proposed.taskVersion,
      actor: { type: "operator", id: "pilot-operator" },
    }, approvalDeps(store));
    await expect(approveAgentTask({
      workItemId: proposed.workItemId,
      taskVersion: proposed.taskVersion,
      actor: { type: "operator", id: "pilot-operator" },
    }, approvalDeps(store))).rejects.toThrow(
      "requires a proposed task with pending approval",
    );

    const expiringStore = new MemoryTaskStore();
    const expiring = await proposeAgentTask({
      ...proposalInput(),
      workItemId: "expiring-task",
      correlationId: "expiring-task",
      deadline: "2026-07-25T14:01:00.000Z",
    }, proposalDeps(expiringStore, new MemoryArtifactStore()));
    await expect(approveAgentTask({
      workItemId: expiring.workItemId,
      taskVersion: expiring.taskVersion,
      actor: { type: "operator", id: "pilot-operator" },
    }, {
      ...approvalDeps(expiringStore),
      now: () => new Date("2026-07-25T14:01:00.000Z"),
    })).rejects.toThrow("Expired AgentTasks cannot be approved");
  });

  it("invalidates approval after every material proposal field mutation", async () => {
    const store = new MemoryTaskStore();
    const proposed = await proposeAgentTask(
      proposalInput(),
      proposalDeps(store, new MemoryArtifactStore()),
    );
    const approved = await approveAgentTask({
      workItemId: proposed.workItemId,
      taskVersion: proposed.taskVersion,
      actor: { type: "operator", id: "pilot-operator" },
    }, approvalDeps(store));
    const mutations: AgentTaskV1[] = [
      {
        ...approved,
        proposal: {
          ...approved.proposal,
          objective: "A materially different objective.",
        },
      },
      {
        ...approved,
        repository: {
          ...approved.repository,
          allowedPaths: [...approved.repository.allowedPaths, "packages/**"],
        },
      },
      {
        ...approved,
        budget: {
          ...approved.budget,
          elapsedSeconds: approved.budget.elapsedSeconds + 1,
        },
      },
      {
        ...approved,
        requestedAuthority: {
          ...approved.requestedAuthority,
          grants: approved.requestedAuthority.grants.map((grant, index) =>
            index === 0
              ? { ...grant, constraints: { mode: "read_only" } }
              : grant),
        },
      },
      {
        ...approved,
        deadline: "2028-01-01T00:00:00.000Z",
      },
      {
        ...approved,
        intent: {
          ...approved.intent,
          profile: "different-pilot-profile",
        },
      },
    ].map((task) => agentTaskV1Schema.parse(task));

    for (const mutation of mutations) {
      await expect(agentTaskApprovalHashMatches(mutation))
        .resolves.toBe(false);
    }
  });
});

describe("pilot ceremony proposal fixtures", () => {
  it.each(CEREMONY_FIXTURES)(
    "proposes the %s family with the exact dispatcher workspace path",
    async (name) => {
      const input = await ceremonyFixture(name);
      const store = new MemoryTaskStore();
      const task = await proposeAgentTask(
        input,
        proposalDeps(store, new MemoryArtifactStore()),
      );
      const expectedWorkspace = workspacePathForTask(
        task.workItemId,
        task.taskVersion,
      );
      const built = await buildTaskIntentArtifact(task, {
        workspacePath: expectedWorkspace,
      });

      expect(agentTaskV1Schema.parse(task)).toEqual(task);
      expect(task.risk.tier).toBe("low");
      expect(task.requestedAuthority.network).toBe("deny");
      expect(task.repository).toMatchObject({
        nameWithOwner: "depre-dev/averray-reference-agent",
        allowedPaths: ["docs/**", "test/**"],
        forbiddenPaths: expect.arrayContaining([
          "contracts/**",
          "ops/**",
          "scripts/ops/**",
          ".github/**",
        ]),
      });
      expect(built.intent.spec.context.workspace.path).toBe(
        expectedWorkspace,
      );
      expect(built.templateHash).toBe(task.intent.templateHash);
    },
  );


  // Both ceremony scripts APPEND to a tracked file. `git diff --check` inspects
  // only tracked files with unstaged modifications, so a fixture that creates a
  // NEW file makes the criterion vacuous: git never examines the content and the
  // check passes whatever was written. These tests therefore run the real
  // criterion against a real repository rather than asserting on the JSON.
  for (
    const scenario of [
      { fixture: "lint-format-green", mustReject: false },
      { fixture: "lint-format-red", mustReject: true },
    ]
  ) {
    it(`${scenario.fixture}: the real acceptance criterion ${
      scenario.mustReject ? "rejects" : "accepts"
    } what the script writes`, async () => {
      const input = await ceremonyFixture(scenario.fixture);
      expect(input.repository.baseRevision).toMatch(/^[0-9a-f]{40}$/);
      const scriptBytes = await readFile(
        new URL(
          `../fixtures/agent-integration/ceremony/${scenario.fixture}.jsonl`,
          import.meta.url,
        ),
        "utf8",
      );
      const lines = scriptBytes.trimEnd().split("\n");
      expect(lines).toHaveLength(2);

      // Identical fence for both — the written content is the only variable.
      expect(input.acceptanceCriteria).toEqual([{
        id: "format-command",
        type: "command",
        command: "git diff --check",
        required: true,
      }]);
      expect(input.repository.allowedPaths).toEqual(["docs/**", "test/**"]);

      const call = (JSON.parse(lines[0] ?? "{}") as {
        tool_calls?: Array<{ name?: string; arguments?: { command?: string } }>;
      }).tool_calls?.[0];
      expect(call?.name).toBe("shell_run");
      const command = call?.arguments?.command ?? "";
      expect(command).toMatch(/^printf /);
      expect(command).toMatch(/>> (docs|test)\//);

      const target = (/>> (\S+)/.exec(command) ?? [])[1] ?? "";
      expect(target).toMatch(/^(docs|test)\//);

      // PROPERTY 1 — the target must already be TRACKED IN THIS REPOSITORY.
      // `git diff --check` inspects only tracked files with unstaged changes, so
      // appending to a NEW file makes the criterion vacuous: it passes having
      // examined nothing. This must be checked against the real repository; a
      // synthetic one would make every target tracked and prove nothing.
      // `ls-files` works on a shallow checkout, unlike a base-revision lookup.
      expect(() =>
        execFileSync("git", ["ls-files", "--error-unmatch", target], {
          cwd: process.cwd(),
          stdio: "pipe",
        })
      ).not.toThrow();

      // PROPERTY 2 — the appended content produces the expected verdict. A
      // synthetic repository is correct here: the semantics of the content are
      // independent of which file it lands in, and CI checks out shallow so the
      // fixture's base revision is unavailable.
      const workspace = await mkdtemp(path.join(tmpdir(), "int2-criterion-"));
      try {
        const repo = path.join(workspace, "repo");
        await mkdir(path.join(repo, path.dirname(target)), { recursive: true });
        execFileSync("git", ["init", "-q", repo]);
        execFileSync("git", ["-C", repo, "config", "user.email", "ceremony@test"]);
        execFileSync("git", ["-C", repo, "config", "user.name", "ceremony"]);
        await writeFile(path.join(repo, target), "# pre-existing tracked content\n", "utf8");
        execFileSync("git", ["-C", repo, "add", "-A"]);
        execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);

        execFileSync("sh", ["-c", command], { cwd: repo });

        const numstat = execFileSync("git", ["-C", repo, "diff", "--numstat"], { encoding: "utf8" });
        expect(numstat.trim()).not.toBe("");

        let rejected = false;
        let output = "";
        try {
          output = execFileSync("git", ["-C", repo, "diff", "--check"], { encoding: "utf8" });
        } catch (error) {
          rejected = true;
          output = String((error as { stdout?: string }).stdout ?? "");
        }
        expect(rejected).toBe(scenario.mustReject);
        if (scenario.mustReject) {
          expect(output).toMatch(/trailing whitespace/);
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }, 30_000);
  }

});

function proposalInput(): ProposeAgentTaskInput {
  return {
    workItemId: "proposal-work-001",
    correlationId: "proposal-correlation-001",
    taskKind: "unit_test",
    title: "Add a focused unit test",
    objective: "Add one regression test for the approved behavior.",
    whyNow: "The supervised pilot needs a bounded test-only task.",
    requestedBy: {
      type: "operator",
      id: "pilot-operator",
    },
    repository: {
      nameWithOwner: "depre-dev/averray-reference-agent",
      baseRevision: "8b94278578913b7cd7aa1acb276db48613090c7b",
      allowedPaths: ["docs/**", "test/**"],
      forbiddenPaths: [
        "contracts/**",
        "ops/**",
        "scripts/ops/**",
        ".github/**",
      ],
    },
    profile: "coding-change-pilot",
    acceptanceCriteria: [
      {
        id: "test",
        type: "command",
        command: "npm test",
        required: true,
      },
    ],
    budget: {
      elapsedSeconds: 120,
      modelTokens: 10_000,
      toolCalls: 40,
      estimatedUsdMicros: null,
    },
    deadline: "2027-12-31T23:59:59.000Z",
    selectionReason: "A test-only task is bounded and reversible.",
  };
}

function proposalDeps(
  store: MemoryTaskStore,
  artifacts: MemoryArtifactStore,
): ProposeAgentTaskDeps {
  return {
    policyConfig: POLICY_CONFIG,
    policyVersion: "dispatch-policy-v1",
    now: () => NOW,
    assertMutationAllowed: async () => undefined,
    writeArtifact: artifacts.write,
    putTask: store.put,
  };
}

function approvalDeps(
  store: MemoryTaskStore,
): {
  now: () => Date;
  getTask: (
    workItemId: string,
    taskVersion: number,
  ) => Promise<AgentTaskV1 | undefined>;
  putTask: (task: AgentTaskV1) => Promise<AgentTaskV1>;
} {
  return {
    now: () => APPROVED_AT,
    assertMutationAllowed: async () => undefined,
    getTask: store.getTask,
    putTask: store.put,
  };
}

class MemoryArtifactStore {
  readonly refs: ArtifactRef[] = [];
  readonly bytes = new Map<string, string>();

  readonly write: AgentTaskArtifactWriter = async (bytes) => {
    const hash = rawHash(bytes);
    const reference = contentRef(hash);
    this.bytes.set(hash, bytes);
    this.refs.push(reference);
    return reference;
  };
}

class MemoryTaskStore {
  readonly tasks = new Map<string, AgentTaskV1>();

  get size(): number {
    return this.tasks.size;
  }

  get(workItemId: string, taskVersion: number): AgentTaskV1 | undefined {
    return this.tasks.get(taskKey(workItemId, taskVersion));
  }

  readonly getTask = async (
    workItemId: string,
    taskVersion: number,
  ): Promise<AgentTaskV1 | undefined> => {
    const task = this.get(workItemId, taskVersion);
    return task ? structuredClone(task) : undefined;
  };

  readonly put = async (
    input: AgentTaskV1,
  ): Promise<AgentTaskV1> => {
    const task = agentTaskV1Schema.parse(input);
    this.tasks.set(
      taskKey(task.workItemId, task.taskVersion),
      structuredClone(task),
    );
    return structuredClone(task);
  };

  readonly query: AgentTaskStoreQuery = async <T>(
    text: string,
  ): Promise<T[]> => {
    if (!/from agent_tasks/i.test(text)) {
      throw new Error("Unexpected memory store query");
    }
    return [...this.tasks.values()].map((task) => ({
      work_item_id: task.workItemId,
      task_version: task.taskVersion,
      correlation_id: task.correlationId,
      lifecycle: task.lifecycle,
      executor_kind: task.executor.kind,
      approved_task_hash: task.approval.approvedTaskHash ?? null,
      deadline: task.deadline,
      updated_at: task.timestamps.updatedAt,
      task: structuredClone(task),
    }) as T);
  };
}

async function ceremonyFixture(
  name: typeof CEREMONY_FIXTURES[number],
): Promise<ProposeAgentTaskInput> {
  return JSON.parse(await readFile(
    new URL(
      `../fixtures/agent-integration/ceremony/${name}.json`,
      import.meta.url,
    ),
    "utf8",
  )) as ProposeAgentTaskInput;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function rawHash(bytes: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function contentRef(hash: `sha256:${string}`): ArtifactRef {
  return {
    uri: `artifact://sha256/${hash.slice("sha256:".length)}`,
    sha256: hash,
  };
}

function taskKey(workItemId: string, taskVersion: number): string {
  return `${workItemId}@${taskVersion}`;
}
