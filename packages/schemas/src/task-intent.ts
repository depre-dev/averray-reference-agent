import { z } from "zod";

import {
  canonicalContractJson,
  hashCanonicalContract,
} from "./agent-contract-hash.js";

const taskIntentIdSchema = z.string().regex(/^[a-z0-9-]+$/);

const taskIntentMetadataSchema = z.object({
  id: taskIntentIdSchema,
  labels: z.record(z.string()),
}).strict();

const taskIntentWorkspaceSchema = z.object({
  path: z.string(),
  revision: z.string(),
}).strict();

const taskIntentReferenceSchema = z.object({
  path: z.string(),
  authority: z.string(),
}).strict();

const taskIntentContextSchema = z.object({
  workspace: taskIntentWorkspaceSchema,
  references: z.array(taskIntentReferenceSchema),
}).strict();

const taskIntentNetworkSchema = z.union([
  z.literal("deny"),
  z.object({
    allow: z.array(z.string()),
  }).strict(),
]);

const taskIntentConstraintsSchema = z.object({
  allowed_paths: z.array(z.string()),
  forbidden_paths: z.array(z.string()),
  network: taskIntentNetworkSchema,
}).strict();

const taskIntentDeliverableSchema = z.object({
  type: z.string(),
  scope: z.string().optional(),
}).strict();

const taskIntentCommandAcceptanceSchema = z.object({
  id: z.string(),
  type: z.literal("command"),
  command: z.string(),
  working_directory: z.string().optional(),
  required: z.boolean(),
}).strict();

const taskIntentSearchAcceptanceSchema = z.object({
  id: z.string(),
  type: z.literal("search"),
  include: z.array(z.string()),
  pattern: z.string(),
  expected_matches: z.number().int().nonnegative().safe(),
  required: z.boolean(),
}).strict();

const taskIntentBaselineAcceptanceSchema = z.object({
  id: z.string(),
  type: z.literal("baseline_comparison"),
  rule: z.literal("no_new_failures"),
  baseline_command: z.string().optional(),
  required: z.boolean(),
}).strict();

const taskIntentRubricAcceptanceSchema = z.object({
  id: z.string(),
  type: z.literal("rubric"),
  rubric: z.string().min(1),
  threshold: z.number().min(0).max(1),
  judged_deliverables: z.array(z.string()).min(1),
  borderline_margin: z.number().min(0).max(1),
  required: z.boolean(),
}).strict();

const taskIntentAcceptanceSchema = z.discriminatedUnion("type", [
  taskIntentCommandAcceptanceSchema,
  taskIntentSearchAcceptanceSchema,
  taskIntentBaselineAcceptanceSchema,
  taskIntentRubricAcceptanceSchema,
]);

const taskIntentApprovalSchema = z.object({
  when: z.string(),
}).strict();

const taskIntentBudgetsSchema = z.object({
  elapsed: z.string(),
  model_tokens: z.number().int().positive().safe(),
  tool_calls: z.number().int().positive().safe(),
  max_children: z.number().int().positive().safe(),
  max_concurrent_children: z.number().int().positive().safe(),
}).strict();

const taskIntentLearningSchema = z.object({
  episode_capture: z.boolean(),
  memory_write: z.enum(["none", "candidate_only"]),
  skill_generation: z.enum(["eligible", "ineligible"]),
}).strict();

const taskIntentSpecSchema = z.object({
  profile: z.string(),
  objective: z.string().min(1),
  deliverables: z.array(taskIntentDeliverableSchema).min(1),
  context: taskIntentContextSchema,
  constraints: taskIntentConstraintsSchema,
  acceptance: z.array(taskIntentAcceptanceSchema),
  approvals: z.array(taskIntentApprovalSchema),
  budgets: taskIntentBudgetsSchema,
  learning: taskIntentLearningSchema,
}).strict();

export const taskIntentSchema = z.object({
  apiVersion: z.literal("harness/v1alpha1"),
  kind: z.literal("TaskIntent"),
  metadata: taskIntentMetadataSchema,
  spec: taskIntentSpecSchema,
}).strict();

export interface PilotProfileManifest {
  profileId: string;
  strategies: string[];
  capabilities: Array<{
    id: string;
    effectClass: "none" | "local" | "external_read" | "external_write";
    delegable: boolean;
  }>;
}

export type TaskIntent = z.infer<typeof taskIntentSchema>;

export function serializeTaskIntent(intent: TaskIntent): string {
  return canonicalContractJson(taskIntentSchema.parse(intent));
}

export async function hashTaskIntent(intent: TaskIntent): Promise<`sha256:${string}`> {
  return hashCanonicalContract(taskIntentSchema.parse(intent));
}
