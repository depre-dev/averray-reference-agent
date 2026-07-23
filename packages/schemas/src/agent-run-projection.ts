import { z } from "zod";

import {
  artifactRefSchema,
  harnessRunStateSchema,
  integrationIdSchema,
  integrationTextSchema,
  integrationTimestampSchema,
  modelBindingMetadataSchema,
  nonNegativeSafeIntegerSchema,
  sha256Schema,
  uniqueNonEmptyStrings,
} from "./agent-integration-common.js";
import {
  agentTaskBindingsSchema,
  agentTaskNetworkPolicySchema,
  agentTaskV1Schema,
  type AgentTaskV1,
} from "./agent-task.js";

const terminalOutcomeSchema = z.enum(["completed", "partial", "failed", "cancelled"]);

export const agentRunProjectionV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("agent_run_projection"),
  workItemId: integrationIdSchema,
  correlationId: integrationIdSchema,
  harnessRunId: integrationIdSchema,
  taskVersion: z.number().int().positive().safe(),
  source: z.object({
    system: z.literal("agent-harness"),
    health: z.enum(["healthy", "stale", "degraded", "unavailable"]),
    observedAt: integrationTimestampSchema,
    sourceUpdatedAt: integrationTimestampSchema.optional(),
    reason: integrationTextSchema.optional(),
  }).strict(),
  heartbeat: z.object({
    status: z.enum(["active", "stale", "terminal", "unknown"]),
    lastEventAt: integrationTimestampSchema.optional(),
    ageSeconds: nonNegativeSafeIntegerSchema.optional(),
  }).strict(),
  run: z.object({
    state: harnessRunStateSchema,
    attempt: nonNegativeSafeIntegerSchema,
    terminal: z.boolean(),
    outcome: terminalOutcomeSchema.optional(),
    reason: integrationTextSchema.optional(),
    lastEventAt: integrationTimestampSchema.optional(),
  }).strict(),
  manifest: z.object({
    ref: artifactRefSchema.optional(),
    hash: sha256Schema,
    profile: integrationIdSchema,
    riskClass: z.enum(["low", "standard", "elevated"]),
    effectiveCapabilities: uniqueNonEmptyStrings(200),
    network: agentTaskNetworkPolicySchema,
    policyHash: sha256Schema,
    verifierHash: sha256Schema,
    modelBindings: z.array(modelBindingMetadataSchema).max(100),
    skillVersions: uniqueNonEmptyStrings(200),
  }).strict(),
  progress: z.object({
    phase: integrationIdSchema,
    summary: integrationTextSchema,
    completedUnits: nonNegativeSafeIntegerSchema.optional(),
    totalUnits: nonNegativeSafeIntegerSchema.optional(),
    blocker: integrationTextSchema.optional(),
  }).strict(),
  budget: z.object({
    elapsedSecondsUsed: nonNegativeSafeIntegerSchema.optional(),
    elapsedSecondsLimit: nonNegativeSafeIntegerSchema.optional(),
    modelTokensUsed: nonNegativeSafeIntegerSchema.optional(),
    modelTokensLimit: nonNegativeSafeIntegerSchema.optional(),
    toolCallsUsed: nonNegativeSafeIntegerSchema.optional(),
    toolCallsLimit: nonNegativeSafeIntegerSchema.optional(),
    estimatedUsdMicrosUsed: nonNegativeSafeIntegerSchema.optional(),
    estimatedUsdMicrosLimit: nonNegativeSafeIntegerSchema.nullable().optional(),
    exhausted: z.boolean(),
  }).strict(),
  artifacts: z.array(artifactRefSchema).max(1_000),
  verification: z.object({
    status: z.enum(["pending", "passed", "failed", "inconclusive"]),
    decisionRef: artifactRefSchema.optional(),
    decisionHash: sha256Schema.optional(),
  }).strict().superRefine((verification, context) => {
    const refPresent = verification.decisionRef !== undefined;
    const hashPresent = verification.decisionHash !== undefined;
    if (refPresent !== hashPresent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "decisionRef and decisionHash must be present together",
        path: ["decisionRef"],
      });
    }
    if (verification.decisionRef && verification.decisionHash
        && verification.decisionRef.sha256 !== verification.decisionHash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "verification decision ref hash must match decisionHash",
        path: ["decisionHash"],
      });
    }
  }).optional(),
  failure: z.object({
    code: integrationIdSchema,
    message: integrationTextSchema,
    retryable: z.boolean(),
  }).strict().optional(),
  bindings: agentTaskBindingsSchema.optional(),
}).strict().superRefine((projection, context) => {
  if (projection.source.health !== "healthy" && !projection.source.reason) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-healthy sources require an explicit reason",
      path: ["source", "reason"],
    });
  }
  if (projection.manifest.ref && projection.manifest.ref.sha256 !== projection.manifest.hash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "manifest ref hash must match manifest hash",
      path: ["manifest", "hash"],
    });
  }
  if (projection.run.terminal !== (projection.run.outcome !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "terminal and outcome must be present together",
      path: ["run", "outcome"],
    });
  }
  if (projection.heartbeat.status === "terminal" && !projection.run.terminal) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "terminal heartbeat requires a terminal run",
      path: ["heartbeat", "status"],
    });
  }
  if (projection.progress.completedUnits !== undefined
      && projection.progress.totalUnits !== undefined
      && projection.progress.completedUnits > projection.progress.totalUnits) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "completedUnits cannot exceed totalUnits",
      path: ["progress", "completedUnits"],
    });
  }
  if (projection.bindings?.harnessRunId
      && projection.bindings.harnessRunId !== projection.harnessRunId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "binding harnessRunId must match projection harnessRunId",
      path: ["bindings", "harnessRunId"],
    });
  }
  if ((projection.run.state === "failed" || projection.run.state === "quarantined")
      && !projection.failure) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${projection.run.state} runs require structured failure details`,
      path: ["failure"],
    });
  }
});

export type AgentRunProjectionV1 = z.infer<typeof agentRunProjectionV1Schema>;

export function assertAgentRunProjectionWithinTask(
  taskInput: AgentTaskV1,
  projectionInput: AgentRunProjectionV1,
): void {
  const task = agentTaskForAuthority(taskInput);
  const projection = agentRunProjectionV1Schema.parse(projectionInput);
  if (projection.workItemId !== task.workItemId
      || projection.correlationId !== task.correlationId
      || projection.taskVersion !== task.taskVersion) {
    throw new Error("run projection identity does not match approved task");
  }
  if (projection.manifest.policyHash !== task.approval.policyHash) {
    throw new Error("run projection policy hash does not match approved task");
  }
  if (task.bindings?.harnessRunId && projection.harnessRunId !== task.bindings.harnessRunId) {
    throw new Error("run projection Harness run id does not match approved task binding");
  }
  if (task.bindings?.runManifestHash
      && projection.manifest.hash !== task.bindings.runManifestHash) {
    throw new Error("run projection manifest hash does not match approved task binding");
  }

  const approvedCapabilities = new Set(
    task.requestedAuthority.grants.map((grant) => grant.capabilityId),
  );
  const expandedCapability = projection.manifest.effectiveCapabilities
    .find((capability) => !approvedCapabilities.has(capability));
  if (expandedCapability) {
    throw new Error(`run projection expands capability: ${expandedCapability}`);
  }
  assertNetworkAttenuated(task.requestedAuthority.network, projection.manifest.network);
  assertBudgetWithinTask(task, projection);
}

function agentTaskForAuthority(task: AgentTaskV1): AgentTaskV1 {
  const parsed = agentTaskV1Schema.parse(task);
  if (parsed.approval.status !== "approved") {
    throw new Error("run projection requires an approved task");
  }
  return parsed;
}

function assertNetworkAttenuated(
  approved: AgentTaskV1["requestedAuthority"]["network"],
  effective: AgentRunProjectionV1["manifest"]["network"],
): void {
  if (approved === "deny") {
    if (effective !== "deny") throw new Error("run projection expands denied network access");
    return;
  }
  if (effective === "deny") return;
  const approvedDestinations = new Set(approved.allowlist);
  const expandedDestination = effective.allowlist
    .find((destination) => !approvedDestinations.has(destination));
  if (expandedDestination) {
    throw new Error(`run projection expands network destination: ${expandedDestination}`);
  }
}

function assertBudgetWithinTask(
  task: AgentTaskV1,
  projection: AgentRunProjectionV1,
): void {
  const limits: Array<[number | null | undefined, number | null]> = [
    [projection.budget.elapsedSecondsLimit, task.budget.elapsedSeconds],
    [projection.budget.modelTokensLimit, task.budget.modelTokens],
    [projection.budget.toolCallsLimit, task.budget.toolCalls],
    [projection.budget.estimatedUsdMicrosLimit, task.budget.estimatedUsdMicros],
  ];
  for (const [effective, approved] of limits) {
    if (effective === undefined) continue;
    if (approved === null && effective !== null) {
      throw new Error("run projection adds a monetary budget where none was approved");
    }
    if (effective !== null && approved !== null && effective > approved) {
      throw new Error("run projection budget exceeds approved task budget");
    }
  }
}
