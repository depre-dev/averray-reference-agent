import {
  hashTaskIntent,
  serializeTaskIntent,
  taskIntentSchema,
  type AgentTaskV1,
  type TaskIntent,
} from "@avg/schemas";

export interface TaskIntentMappingOptions {
  workspacePath: string;
}

export interface TaskIntentArtifact {
  intent: TaskIntent;
  canonicalBytes: string;
  templateHash: `sha256:${string}`;
}

export function mapAgentTaskToTaskIntent(
  task: AgentTaskV1,
  options: TaskIntentMappingOptions,
): TaskIntent {
  return taskIntentSchema.parse({
    apiVersion: "harness/v1alpha1",
    kind: "TaskIntent",
    metadata: {
      id: slugWorkItemId(task.workItemId),
      labels: {
        averray_work_item_id: task.workItemId,
        correlation_id: task.correlationId,
        task_version: String(task.taskVersion),
      },
    },
    spec: {
      profile: task.intent.profile,
      objective: [
        task.proposal.objective,
        `Title: ${task.proposal.title}`,
        `Why now: ${task.proposal.whyNow}`,
      ].join("\n\n"),
      deliverables: [
        { type: "workspace_patch" },
        { type: "verification_report" },
        { type: "change_summary" },
      ],
      context: {
        workspace: {
          path: options.workspacePath,
          revision: task.repository.baseRevision,
        },
        references: [],
      },
      constraints: {
        allowed_paths: [...task.repository.allowedPaths],
        forbidden_paths: [...task.repository.forbiddenPaths],
        network: task.requestedAuthority.network === "deny"
          ? "deny"
          : { allow: [...task.requestedAuthority.network.allowlist] },
      },
      acceptance: task.acceptance.criteria.map(mapAcceptanceCriterion),
      approvals: [],
      budgets: {
        elapsed: `PT${task.budget.elapsedSeconds}S`,
        model_tokens: task.budget.modelTokens,
        tool_calls: task.budget.toolCalls,
        // Zero-child authority is enforced structurally by a direct-execution-only profile.
        // The TaskIntent contract requires these numeric fields to be positive.
        max_children: 1,
        max_concurrent_children: 1,
      },
      learning: {
        episode_capture: true,
        memory_write: "none",
        skill_generation: "ineligible",
      },
    },
  });
}

export async function buildTaskIntentArtifact(
  task: AgentTaskV1,
  options: TaskIntentMappingOptions,
): Promise<TaskIntentArtifact> {
  const intent = mapAgentTaskToTaskIntent(task, options);
  const canonicalBytes = serializeTaskIntent(intent);
  const templateHash = await hashTaskIntent(intent);
  return { intent, canonicalBytes, templateHash };
}

function mapAcceptanceCriterion(
  criterion: AgentTaskV1["acceptance"]["criteria"][number],
): TaskIntent["spec"]["acceptance"][number] {
  switch (criterion.type) {
    case "command":
      return {
        id: criterion.id,
        type: criterion.type,
        command: criterion.command,
        ...(criterion.workingDirectory
          ? { working_directory: criterion.workingDirectory }
          : {}),
        required: criterion.required,
      };
    case "search":
      return {
        id: criterion.id,
        type: criterion.type,
        include: [...criterion.include],
        pattern: criterion.pattern,
        expected_matches: criterion.expectedMatches,
        required: criterion.required,
      };
    case "baseline_comparison":
      return {
        id: criterion.id,
        type: criterion.type,
        rule: criterion.rule,
        ...(criterion.baselineCommand
          ? { baseline_command: criterion.baselineCommand }
          : {}),
        required: criterion.required,
      };
    case "rubric":
      return {
        id: criterion.id,
        type: criterion.type,
        rubric: criterion.rubric,
        threshold: criterion.threshold,
        judged_deliverables: [...criterion.judgedDeliverables],
        borderline_margin: criterion.borderlineMargin,
        required: criterion.required,
      };
  }
}

function slugWorkItemId(workItemId: string): string {
  return workItemId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
