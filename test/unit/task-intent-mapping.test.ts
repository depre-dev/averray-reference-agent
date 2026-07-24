import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  agentTaskV1Schema,
  hashTaskIntent,
  serializeTaskIntent,
  taskIntentSchema,
  type AgentTaskV1,
} from "../../packages/schemas/src/index.js";
import {
  buildTaskIntentArtifact,
  mapAgentTaskToTaskIntent,
} from "../../packages/averray-mcp/src/task-intent-mapping.js";

describe("TaskIntent contract", () => {
  it("accepts the v1alpha1 fixture and rejects unknown keys and wrong types", () => {
    const fixture = taskIntentFixture();

    expect(taskIntentSchema.parse(fixture)).toEqual(fixture);
    expect(() => taskIntentSchema.parse({ ...fixture, extra: true })).toThrow();
    expect(() =>
      taskIntentSchema.parse({
        ...fixture,
        spec: {
          ...fixture.spec,
          budgets: {
            ...fixture.spec.budgets,
            model_tokens: "many",
          },
        },
      })
    ).toThrow();
  });
});

describe("AgentTask to TaskIntent mapping", () => {
  it("maps identity, authority, budgets, and snake_case acceptance fields", () => {
    const base = agentTaskFixture();
    const task = agentTaskV1Schema.parse({
      ...base,
      workItemId: "Work Item/001",
      requestedAuthority: {
        ...base.requestedAuthority,
        network: {
          allowlist: ["api.example.test", "artifacts.example.test"],
        },
      },
      acceptance: {
        ...base.acceptance,
        criteria: [
          {
            id: "command",
            type: "command",
            command: "npm test",
            workingDirectory: "packages/schemas",
            required: true,
          },
          {
            id: "search",
            type: "search",
            include: ["packages/**/*.ts"],
            pattern: "TaskIntent",
            expectedMatches: 2,
            required: true,
          },
          {
            id: "baseline",
            type: "baseline_comparison",
            rule: "no_new_failures",
            baselineCommand: "npm test -- --baseline",
            required: true,
          },
          {
            id: "rubric",
            type: "rubric",
            rubric: "The change remains bounded and verifiable.",
            threshold: 0.9,
            judgedDeliverables: ["workspace_patch", "verification_report"],
            borderlineMargin: 0.05,
            required: true,
          },
        ],
      },
    });

    const intent = mapAgentTaskToTaskIntent(task, {
      workspacePath: "/workspaces/task-checkout",
    });

    expect(taskIntentSchema.parse(intent)).toEqual(intent);
    expect(intent.metadata).toEqual({
      id: "work-item-001",
      labels: {
        averray_work_item_id: "Work Item/001",
        correlation_id: task.correlationId,
        task_version: "1",
      },
    });
    expect(intent.spec.objective).toContain(task.proposal.objective);
    expect(intent.spec.objective).toContain(`Title: ${task.proposal.title}`);
    expect(intent.spec.objective).toContain(`Why now: ${task.proposal.whyNow}`);
    expect(intent.spec.context).toEqual({
      workspace: {
        path: "/workspaces/task-checkout",
        revision: task.repository.baseRevision,
      },
      references: [],
    });
    expect(intent.spec.constraints).toEqual({
      allowed_paths: task.repository.allowedPaths,
      forbidden_paths: task.repository.forbiddenPaths,
      network: {
        allow: ["api.example.test", "artifacts.example.test"],
      },
    });
    expect(intent.spec.acceptance).toEqual([
      {
        id: "command",
        type: "command",
        command: "npm test",
        working_directory: "packages/schemas",
        required: true,
      },
      {
        id: "search",
        type: "search",
        include: ["packages/**/*.ts"],
        pattern: "TaskIntent",
        expected_matches: 2,
        required: true,
      },
      {
        id: "baseline",
        type: "baseline_comparison",
        rule: "no_new_failures",
        baseline_command: "npm test -- --baseline",
        required: true,
      },
      {
        id: "rubric",
        type: "rubric",
        rubric: "The change remains bounded and verifiable.",
        threshold: 0.9,
        judged_deliverables: ["workspace_patch", "verification_report"],
        borderline_margin: 0.05,
        required: true,
      },
    ]);
    expect(intent.spec.budgets).toEqual({
      elapsed: `PT${task.budget.elapsedSeconds}S`,
      model_tokens: task.budget.modelTokens,
      tool_calls: task.budget.toolCalls,
      max_children: 1,
      max_concurrent_children: 1,
    });
    expect(intent.spec.approvals).toEqual([]);
    expect(intent.spec.learning).toEqual({
      episode_capture: true,
      memory_write: "none",
      skill_generation: "ineligible",
    });
  });

  it("builds canonical bytes and their matching template hash", async () => {
    const task = agentTaskV1Schema.parse(agentTaskFixture());
    const built = await buildTaskIntentArtifact(task, {
      workspacePath: "/workspaces/task-checkout",
    });

    expect(built.canonicalBytes).toBe(serializeTaskIntent(built.intent));
    expect(await hashTaskIntent(built.intent)).toBe(built.templateHash);
    expect(JSON.parse(built.canonicalBytes)).toEqual(built.intent);
  });
});

function agentTaskFixture(): AgentTaskV1 {
  return JSON.parse(
    readFileSync(
      new URL("../fixtures/agent-integration/agent-task-v1.json", import.meta.url),
      "utf8",
    ),
  ) as AgentTaskV1;
}

function taskIntentFixture(): ReturnType<typeof taskIntentSchema.parse> {
  return taskIntentSchema.parse(
    JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/agent-integration/task-intent-v1alpha1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
}
