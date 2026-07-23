import { z } from "zod";

import {
  integrationIdSchema,
  integrationTextSchema,
  integrationTimestampSchema,
} from "./agent-integration-common.js";
import { hermesDecisionRecordV1Schema } from "./hermes-decision-record.js";

export const legacyCodexTaskV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("codex_task"),
  id: integrationIdSchema,
  repo: integrationTextSchema,
  pullRequestNumber: z.number().int().positive().safe().optional(),
  agent: integrationIdSchema.optional(),
  correlationId: integrationIdSchema.optional(),
  title: integrationTextSchema.optional(),
  prompt: integrationTextSchema,
  reason: integrationTextSchema.optional(),
  requester: integrationIdSchema.optional(),
  riskTier: z.enum(["high", "low"]).optional(),
  routingReason: integrationTextSchema.optional(),
  status: z.enum(["proposed", "approved", "running", "completed", "failed", "cancelled"]),
  createdAt: integrationTimestampSchema,
  updatedAt: integrationTimestampSchema,
  approvedAt: integrationTimestampSchema.optional(),
  startedAt: integrationTimestampSchema.optional(),
  completedAt: integrationTimestampSchema.optional(),
  failedAt: integrationTimestampSchema.optional(),
  cancelledAt: integrationTimestampSchema.optional(),
  decisionRecord: hermesDecisionRecordV1Schema.optional(),
}).passthrough();

export interface LegacyAgentTaskCompatibilityView {
  sourceVersion: 1;
  sourceKind: "codex_task";
  workItemId: string;
  correlationId?: string;
  repository: string;
  pullRequestNumber?: number;
  objective: string;
  requestedBy?: string;
  executor: {
    kind: "direct";
    directAgent: string;
  };
  legacyRiskTier: "low" | "high" | "unknown";
  lifecycle: "proposed" | "approved" | "running" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  nonDispatchable: true;
  missingRequiredAgentTaskFields: Array<
    | "taskVersion"
    | "taskKind"
    | "taskIntentRef"
    | "immutableAcceptance"
    | "typedGrants"
    | "budget"
    | "deadline"
    | "approvalPolicyHash"
  >;
}

export function parseLegacyCodexTask(value: unknown): LegacyCodexTaskV1 {
  return legacyCodexTaskV1Schema.parse(value);
}

export function toLegacyAgentTaskCompatibilityView(
  input: unknown,
): LegacyAgentTaskCompatibilityView {
  const task = parseLegacyCodexTask(input);
  return {
    sourceVersion: 1,
    sourceKind: "codex_task",
    workItemId: task.id,
    ...(task.correlationId ? { correlationId: task.correlationId } : {}),
    repository: task.repo,
    ...(task.pullRequestNumber ? { pullRequestNumber: task.pullRequestNumber } : {}),
    objective: task.prompt,
    ...(task.requester ? { requestedBy: task.requester } : {}),
    executor: {
      kind: "direct",
      directAgent: task.agent ?? "codex",
    },
    legacyRiskTier: task.riskTier ?? "unknown",
    lifecycle: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    nonDispatchable: true,
    missingRequiredAgentTaskFields: [
      "taskVersion",
      "taskKind",
      "taskIntentRef",
      "immutableAcceptance",
      "typedGrants",
      "budget",
      "deadline",
      "approvalPolicyHash",
    ],
  };
}

export type LegacyCodexTaskV1 = z.infer<typeof legacyCodexTaskV1Schema>;
