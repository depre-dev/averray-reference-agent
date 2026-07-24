import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  agentTaskV1Schema,
  hashTaskIntent,
  taskIntentSchema,
  type AgentTaskV1,
  type PilotProfileManifest,
  type TaskIntent,
} from "../../packages/schemas/src/index.js";
import {
  assertTaskIntentWithinApprovedAuthority,
  AttenuationError,
} from "../../packages/averray-mcp/src/attenuation.js";
import {
  mapAgentTaskToTaskIntent,
} from "../../packages/averray-mcp/src/task-intent-mapping.js";

const CAPABILITIES: PilotProfileManifest["capabilities"] = [
  { id: "fs.read_file", effectClass: "none", delegable: false },
  { id: "fs.write_file", effectClass: "local", delegable: false },
  { id: "fs.list_files", effectClass: "none", delegable: false },
  { id: "shell.run", effectClass: "local", delegable: false },
  { id: "git.status", effectClass: "none", delegable: false },
  { id: "git.diff", effectClass: "none", delegable: false },
  { id: "artifact.put", effectClass: "local", delegable: false },
  { id: "artifact.get", effectClass: "none", delegable: false },
];

describe("pre-dispatch TaskIntent attenuation", () => {
  it("accepts a hash-bound intent inside approved direct-execution authority", async () => {
    const setup = await passingSetup();

    await expect(
      assertTaskIntentWithinApprovedAuthority(
        setup.task,
        setup.intent,
        setup.profile,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a tampered template hash first", async () => {
    const setup = await passingSetup();
    const tampered = {
      ...setup.task,
      intent: {
        ...setup.task.intent,
        templateHash:
          "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
    } as AgentTaskV1;

    await expectReason(tampered, setup.intent, setup.profile, "template_hash_mismatch");
  });

  it("rejects a mismatched profile identity", async () => {
    const setup = await passingSetup();

    await expectReason(
      setup.task,
      setup.intent,
      { ...setup.profile, profileId: "other-profile" },
      "profile_mismatch",
    );
  });

  it("rejects expansion from network deny to an allowlist", async () => {
    const setup = await passingSetup();
    const intent = taskIntentSchema.parse({
      ...setup.intent,
      spec: {
        ...setup.intent.spec,
        constraints: {
          ...setup.intent.spec.constraints,
          network: { allow: ["api.example.test"] },
        },
      },
    });
    const task = await bindTaskToIntent(setup.task, intent);

    await expectReason(task, intent, setup.profile, "network_expanded");
  });

  it("rejects a network allowlist superset", async () => {
    const setup = await passingSetup({
      network: { allowlist: ["api.example.test"] },
    });
    const intent = taskIntentSchema.parse({
      ...setup.intent,
      spec: {
        ...setup.intent.spec,
        constraints: {
          ...setup.intent.spec.constraints,
          network: {
            allow: ["api.example.test", "unapproved.example.test"],
          },
        },
      },
    });
    const task = await bindTaskToIntent(setup.task, intent);

    await expectReason(task, intent, setup.profile, "network_expanded");
  });

  it("rejects paths outside the approved allowlist", async () => {
    const setup = await passingSetup();
    const intent = taskIntentSchema.parse({
      ...setup.intent,
      spec: {
        ...setup.intent.spec,
        constraints: {
          ...setup.intent.spec.constraints,
          allowed_paths: [
            ...setup.intent.spec.constraints.allowed_paths,
            "unapproved/path",
          ],
        },
      },
    });
    const task = await bindTaskToIntent(setup.task, intent);

    await expectReason(task, intent, setup.profile, "path_not_allowed");
  });

  it("rejects narrowing the approved forbidden paths", async () => {
    const setup = await passingSetup();
    const intent = taskIntentSchema.parse({
      ...setup.intent,
      spec: {
        ...setup.intent.spec,
        constraints: {
          ...setup.intent.spec.constraints,
          forbidden_paths: [],
        },
      },
    });
    const task = await bindTaskToIntent(setup.task, intent);

    await expectReason(task, intent, setup.profile, "forbidden_paths_narrowed");
  });

  it("rejects elapsed, model-token, and tool-call budget expansion", async () => {
    const setup = await passingSetup();
    const expandedBudgets: TaskIntent["spec"]["budgets"][] = [
      {
        ...setup.intent.spec.budgets,
        elapsed: `PT${setup.task.budget.elapsedSeconds + 1}S`,
      },
      {
        ...setup.intent.spec.budgets,
        model_tokens: setup.task.budget.modelTokens + 1,
      },
      {
        ...setup.intent.spec.budgets,
        tool_calls: setup.task.budget.toolCalls + 1,
      },
    ];

    for (const budgets of expandedBudgets) {
      const intent = taskIntentSchema.parse({
        ...setup.intent,
        spec: { ...setup.intent.spec, budgets },
      });
      const task = await bindTaskToIntent(setup.task, intent);
      await expectReason(task, intent, setup.profile, "budget_exceeded");
    }
  });

  it("rejects non-zero or delegable child authority", async () => {
    const setup = await passingSetup();
    const expandedAuthorities: AgentTaskV1["requestedAuthority"][] = [
      { ...setup.task.requestedAuthority, maxChildren: 1 },
      { ...setup.task.requestedAuthority, maxConcurrentChildren: 1 },
      {
        ...setup.task.requestedAuthority,
        delegable: true,
      } as unknown as AgentTaskV1["requestedAuthority"],
    ];

    for (const requestedAuthority of expandedAuthorities) {
      const task = {
        ...setup.task,
        requestedAuthority,
      } as AgentTaskV1;
      await expectReason(task, setup.intent, setup.profile, "children_not_zero");
    }
  });

  it("rejects profiles that include planning", async () => {
    const setup = await passingSetup();

    await expectReason(
      setup.task,
      setup.intent,
      {
        ...setup.profile,
        strategies: ["direct_execution", "plan_execute"],
      },
      "profile_not_direct_execution",
    );
  });

  it("rejects delegable profile capabilities", async () => {
    const setup = await passingSetup();
    const capabilities = setup.profile.capabilities.map((capability, index) =>
      index === 0 ? { ...capability, delegable: true } : capability);

    await expectReason(
      setup.task,
      setup.intent,
      { ...setup.profile, capabilities },
      "capability_delegable",
    );
  });

  it("rejects externally effective profile capabilities", async () => {
    const setup = await passingSetup();
    const capabilities: PilotProfileManifest["capabilities"] =
      setup.profile.capabilities.map((capability, index) =>
        index === 0
          ? { ...capability, effectClass: "external_write" }
          : capability);

    await expectReason(
      setup.task,
      setup.intent,
      { ...setup.profile, capabilities },
      "capability_effect_external",
    );
  });

  it("rejects profile capabilities absent from approved grants", async () => {
    const setup = await passingSetup();
    const capabilities: PilotProfileManifest["capabilities"] = [
      ...setup.profile.capabilities,
      { id: "unapproved.capability", effectClass: "local", delegable: false },
    ];

    await expectReason(
      setup.task,
      setup.intent,
      { ...setup.profile, capabilities },
      "capability_not_granted",
    );
  });

  it("rejects an empty profile capability manifest", async () => {
    const setup = await passingSetup();

    await expectReason(
      setup.task,
      setup.intent,
      { ...setup.profile, capabilities: [] },
      "capability_not_granted",
    );
  });
});

async function passingSetup(
  overrides: {
    network?: AgentTaskV1["requestedAuthority"]["network"];
  } = {},
): Promise<{
  task: AgentTaskV1;
  intent: TaskIntent;
  profile: PilotProfileManifest;
}> {
  const base = agentTaskFixture();
  const taskWithAuthority = agentTaskV1Schema.parse({
    ...base,
    requestedAuthority: {
      ...base.requestedAuthority,
      grants: CAPABILITIES.map((capability) => ({
        capabilityId: capability.id,
        resource: base.repository.nameWithOwner,
        constraints: {},
      })),
      network: overrides.network ?? base.requestedAuthority.network,
    },
  });
  const intent = mapAgentTaskToTaskIntent(taskWithAuthority, {
    workspacePath: "/workspaces/task-checkout",
  });
  const task = await bindTaskToIntent(taskWithAuthority, intent);
  return {
    task,
    intent,
    profile: {
      profileId: task.intent.profile,
      strategies: ["direct_execution"],
      capabilities: CAPABILITIES.map((capability) => ({ ...capability })),
    },
  };
}

async function bindTaskToIntent(
  task: AgentTaskV1,
  intent: TaskIntent,
): Promise<AgentTaskV1> {
  const templateHash = await hashTaskIntent(intent);
  return agentTaskV1Schema.parse({
    ...task,
    intent: {
      ...task.intent,
      templateRef: {
        ...task.intent.templateRef,
        uri: `artifact://sha256/${templateHash.slice("sha256:".length)}`,
        sha256: templateHash,
      },
      templateHash,
    },
  });
}

async function expectReason(
  task: AgentTaskV1,
  intent: TaskIntent,
  profile: PilotProfileManifest,
  reason: string,
): Promise<void> {
  await expect(
    assertTaskIntentWithinApprovedAuthority(task, intent, profile),
  ).rejects.toMatchObject({
    name: "AttenuationError",
    reason,
  });
  await assertTaskIntentWithinApprovedAuthority(task, intent, profile).catch((error) => {
    expect(error).toBeInstanceOf(AttenuationError);
  });
}

function agentTaskFixture(): AgentTaskV1 {
  return agentTaskV1Schema.parse(
    JSON.parse(
      readFileSync(
        new URL("../fixtures/agent-integration/agent-task-v1.json", import.meta.url),
        "utf8",
      ),
    ),
  );
}
