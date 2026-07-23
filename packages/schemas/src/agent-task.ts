import { z } from "zod";

import {
  acceptanceCriterionSchema,
  actorRefSchema,
  artifactRefSchema,
  capabilityGrantSchema,
  githubPullRequestRefSchema,
  integrationIdSchema,
  integrationTextSchema,
  integrationTimestampSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  sha256Schema,
  uniqueNonEmptyStrings,
} from "./agent-integration-common.js";

export const agentTaskLifecycleSchema = z.enum([
  "proposed",
  "approved",
  "dispatching",
  "running",
  "verifying",
  "handoff_ready",
  "blocked",
  "failed",
  "cancelled",
]);

export const agentTaskRiskTierSchema = z.enum(["low", "medium", "high"]);

export const agentTaskNetworkPolicySchema = z.union([
  z.literal("deny"),
  z.object({
    allowlist: uniqueNonEmptyStrings(200, 1),
  }).strict(),
]);

export const agentTaskExecutorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("harness"),
    selectionReason: integrationTextSchema,
  }).strict(),
  z.object({
    kind: z.literal("direct"),
    directAgent: z.enum(["codex", "claude", "test-writer", "security", "docs"]),
    selectionReason: integrationTextSchema,
  }).strict(),
]);

export const agentTaskBindingsSchema = z.object({
  harnessRunId: integrationIdSchema.optional(),
  runManifestRef: artifactRefSchema.optional(),
  runManifestHash: sha256Schema.optional(),
  averrayJobId: integrationIdSchema.optional(),
  averraySessionId: integrationIdSchema.optional(),
  pullRequest: githubPullRequestRefSchema.optional(),
}).strict().superRefine((bindings, context) => {
  const refPresent = bindings.runManifestRef !== undefined;
  const hashPresent = bindings.runManifestHash !== undefined;
  if (refPresent !== hashPresent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "runManifestRef and runManifestHash must be present together",
      path: ["runManifestRef"],
    });
  }
  if (bindings.runManifestRef && bindings.runManifestHash
      && bindings.runManifestRef.sha256 !== bindings.runManifestHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "run manifest ref hash must match runManifestHash",
      path: ["runManifestHash"],
    });
  }
});

const agentTaskApprovalSchema = z.object({
  required: z.enum(["policy", "operator"]),
  status: z.enum(["pending", "approved", "denied", "expired"]),
  actor: actorRefSchema.optional(),
  decidedAt: integrationTimestampSchema.optional(),
  policyVersion: integrationIdSchema,
  policyHash: sha256Schema,
  approvedTaskHash: sha256Schema.optional(),
}).strict().superRefine((approval, context) => {
  const decided = approval.status === "approved"
    || approval.status === "denied"
    || approval.status === "expired";
  if (decided && (!approval.actor || !approval.decidedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a decided approval requires actor and decidedAt",
      path: ["actor"],
    });
  }
  if (approval.actor) {
    const actorAllowed = approval.required === "operator"
      ? approval.actor.type === "operator"
      : approval.actor.type === "policy" || approval.actor.type === "operator";
    if (!actorAllowed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${approval.required} approval cannot be decided by ${approval.actor.type}`,
        path: ["actor", "type"],
      });
    }
  }
  if (approval.status === "approved") {
    if (approval.approvedTaskHash === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "approvedTaskHash is required for an approved task",
        path: ["approvedTaskHash"],
      });
    }
  } else if (approval.approvedTaskHash !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "approvedTaskHash is allowed only when status is approved",
      path: ["approvedTaskHash"],
    });
  }
});

export const agentTaskV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("agent_task"),
  workItemId: integrationIdSchema,
  taskVersion: positiveSafeIntegerSchema,
  correlationId: integrationIdSchema,
  taskKind: integrationIdSchema,
  lifecycle: agentTaskLifecycleSchema,
  proposal: z.object({
    title: integrationTextSchema,
    objective: integrationTextSchema,
    whyNow: integrationTextSchema,
    requestedBy: actorRefSchema,
    createdAt: integrationTimestampSchema,
    sourceRefs: z.array(artifactRefSchema).max(200),
  }).strict(),
  repository: z.object({
    provider: z.literal("github"),
    nameWithOwner: z.string().regex(/^[^/\s]+\/[^/\s]+$/).max(240),
    baseRevision: integrationIdSchema,
    allowedPaths: uniqueNonEmptyStrings(500),
    forbiddenPaths: uniqueNonEmptyStrings(500),
  }).strict(),
  intent: z.object({
    apiVersion: z.literal("harness/v1alpha1"),
    profile: integrationIdSchema,
    templateRef: artifactRefSchema,
    templateHash: sha256Schema,
  }).strict(),
  acceptance: z.object({
    criteria: z.array(acceptanceCriterionSchema).min(1).max(200),
    verifierPlanRef: artifactRefSchema,
    verifierPlanHash: sha256Schema,
  }).strict(),
  risk: z.object({
    tier: agentTaskRiskTierSchema,
    reasons: z.array(integrationTextSchema).min(1).max(50),
    irreversible: z.boolean(),
  }).strict(),
  requestedAuthority: z.object({
    grants: z.array(capabilityGrantSchema).max(200),
    network: agentTaskNetworkPolicySchema,
    maxChildren: nonNegativeSafeIntegerSchema,
    maxConcurrentChildren: nonNegativeSafeIntegerSchema,
    delegable: z.literal(false),
  }).strict(),
  budget: z.object({
    elapsedSeconds: positiveSafeIntegerSchema,
    modelTokens: positiveSafeIntegerSchema,
    toolCalls: positiveSafeIntegerSchema,
    estimatedUsdMicros: nonNegativeSafeIntegerSchema.nullable(),
  }).strict(),
  deadline: integrationTimestampSchema,
  executor: agentTaskExecutorSchema,
  approval: agentTaskApprovalSchema,
  timestamps: z.object({
    proposedAt: integrationTimestampSchema,
    approvedAt: integrationTimestampSchema.optional(),
    dispatchClaimedAt: integrationTimestampSchema.optional(),
    runBoundAt: integrationTimestampSchema.optional(),
    terminalAt: integrationTimestampSchema.optional(),
    updatedAt: integrationTimestampSchema,
  }).strict(),
  bindings: agentTaskBindingsSchema.optional(),
}).strict().superRefine((task, context) => {
  if (task.intent.templateRef.sha256 !== task.intent.templateHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "TaskIntent ref hash must match templateHash",
      path: ["intent", "templateHash"],
    });
  }
  if (task.acceptance.verifierPlanRef.sha256 !== task.acceptance.verifierPlanHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "verifier plan ref hash must match verifierPlanHash",
      path: ["acceptance", "verifierPlanHash"],
    });
  }
  const allowedPaths = new Set(task.repository.allowedPaths);
  const overlap = task.repository.forbiddenPaths.find((path) => allowedPaths.has(path));
  if (overlap) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `path cannot be both allowed and forbidden: ${overlap}`,
      path: ["repository", "forbiddenPaths"],
    });
  }
  const criterionIds = task.acceptance.criteria.map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "acceptance criterion ids must be unique",
      path: ["acceptance", "criteria"],
    });
  }
  const grantIds = task.requestedAuthority.grants.map((grant) => grant.capabilityId);
  if (new Set(grantIds).size !== grantIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "capability grant ids must be unique",
      path: ["requestedAuthority", "grants"],
    });
  }
  if (!["operator", "hermes", "averray"].includes(task.proposal.requestedBy.type)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${task.proposal.requestedBy.type} cannot request an AgentTask`,
      path: ["proposal", "requestedBy", "type"],
    });
  }
  if (task.requestedAuthority.maxConcurrentChildren > task.requestedAuthority.maxChildren) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "maxConcurrentChildren cannot exceed maxChildren",
      path: ["requestedAuthority", "maxConcurrentChildren"],
    });
  }
  if (task.requestedAuthority.maxChildren !== 0
      || task.requestedAuthority.maxConcurrentChildren !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "AgentTask V1 disables child delegation and requires zero child budgets",
      path: ["requestedAuthority", "maxChildren"],
    });
  }
  const approvalRequired = task.lifecycle !== "proposed" && task.lifecycle !== "cancelled";
  if (approvalRequired && task.approval.status !== "approved") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${task.lifecycle} tasks require approved status`,
      path: ["approval", "status"],
    });
  }
  if (task.approval.status === "approved" && task.timestamps.approvedAt === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "approvedAt is required for an approved task",
      path: ["timestamps", "approvedAt"],
    });
  }
  if (Date.parse(task.deadline) <= Date.parse(task.timestamps.proposedAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "deadline must be after proposedAt",
      path: ["deadline"],
    });
  }
  if (task.lifecycle === "running" && !task.bindings?.harnessRunId
      && task.executor.kind === "harness") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "a running Harness task requires a harnessRunId binding",
      path: ["bindings", "harnessRunId"],
    });
  }
});

export type AgentTaskLifecycle = z.infer<typeof agentTaskLifecycleSchema>;
export type AgentTaskRiskTier = z.infer<typeof agentTaskRiskTierSchema>;
export type AgentTaskNetworkPolicy = z.infer<typeof agentTaskNetworkPolicySchema>;
export type AgentTaskExecutor = z.infer<typeof agentTaskExecutorSchema>;
export type AgentTaskBindings = z.infer<typeof agentTaskBindingsSchema>;
export type AgentTaskV1 = z.infer<typeof agentTaskV1Schema>;
