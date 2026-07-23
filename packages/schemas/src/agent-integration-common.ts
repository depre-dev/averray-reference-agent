import { z } from "zod";

export const integrationIdSchema = z.string().trim().min(1).max(240);
export const integrationTextSchema = z.string().trim().min(1).max(8_000);
export const integrationTimestampSchema = z.string().datetime({ offset: true });
export const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
export const positiveSafeIntegerSchema = z.number().int().positive().safe();

export const actorRefSchema = z.object({
  type: z.enum([
    "operator",
    "hermes",
    "policy",
    "dispatcher",
    "harness",
    "verifier",
    "averray",
    "github",
  ]),
  id: integrationIdSchema,
}).strict();

export const artifactRefSchema = z.object({
  uri: z.string().trim().min(1).max(2_048),
  sha256: sha256Schema,
  mediaType: z.string().trim().min(1).max(240).optional(),
  sizeBytes: nonNegativeSafeIntegerSchema.optional(),
}).strict();

const capabilityConstraintValueSchema = z.union([
  z.string().max(2_000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(2_000)).max(200),
]);

export const capabilityGrantSchema = z.object({
  capabilityId: integrationIdSchema,
  resource: integrationTextSchema,
  constraints: z.record(capabilityConstraintValueSchema),
  expiresAt: integrationTimestampSchema.optional(),
}).strict();

const commandAcceptanceCriterionSchema = z.object({
  id: integrationIdSchema,
  type: z.literal("command"),
  command: integrationTextSchema,
  workingDirectory: z.string().trim().min(1).max(2_048).optional(),
  required: z.boolean(),
}).strict();

const searchAcceptanceCriterionSchema = z.object({
  id: integrationIdSchema,
  type: z.literal("search"),
  include: uniqueNonEmptyStrings(200),
  pattern: integrationTextSchema,
  expectedMatches: nonNegativeSafeIntegerSchema,
  required: z.boolean(),
}).strict();

const baselineComparisonAcceptanceCriterionSchema = z.object({
  id: integrationIdSchema,
  type: z.literal("baseline_comparison"),
  rule: z.literal("no_new_failures"),
  baselineCommand: integrationTextSchema.optional(),
  required: z.boolean(),
}).strict();

const rubricAcceptanceCriterionSchema = z.object({
  id: integrationIdSchema,
  type: z.literal("rubric"),
  rubric: integrationTextSchema,
  threshold: z.number().min(0).max(1),
  judgedDeliverables: uniqueNonEmptyStrings(200),
  borderlineMargin: z.number().min(0).max(1),
  required: z.boolean(),
}).strict();

export const acceptanceCriterionSchema = z.discriminatedUnion("type", [
  commandAcceptanceCriterionSchema,
  searchAcceptanceCriterionSchema,
  baselineComparisonAcceptanceCriterionSchema,
  rubricAcceptanceCriterionSchema,
]);

export const modelBindingMetadataSchema = z.object({
  role: integrationIdSchema,
  adapter: integrationIdSchema,
  provider: integrationIdSchema,
  modelRef: integrationTextSchema,
  profileHash: sha256Schema,
  judgeIndependence: integrationTextSchema.optional(),
}).strict();

export const mutationRefSchema = z.object({
  system: z.enum(["agent-task", "agent-harness", "github", "averray", "policy"]),
  action: integrationIdSchema,
  target: integrationTextSchema,
  idempotencyKey: integrationTextSchema.optional(),
  resultRef: artifactRefSchema.optional(),
}).strict();

export const harnessRunStateSchema = z.enum([
  "accepted",
  "contract_compiled",
  "environment_preparing",
  "environment_ready",
  "strategy_selected",
  "executing",
  "verifying",
  "repairing",
  "replanning",
  "approval_required",
  "suspended",
  "finalizing",
  "completed",
  "partial",
  "failed",
  "cancel_requested",
  "compensating",
  "cancelled",
  "quarantined",
  "learning_queued",
  "learning_processed",
]);

export const githubPullRequestRefSchema = z.object({
  repository: integrationTextSchema,
  number: positiveSafeIntegerSchema,
  headSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict();

export function uniqueNonEmptyStrings(maxItems: number, minItems = 0) {
  return z.array(integrationTextSchema)
    .min(minItems)
    .max(maxItems)
    .refine((values) => new Set(values).size === values.length, "values must be unique");
}

export type ActorRef = z.infer<typeof actorRefSchema>;
export type ArtifactRef = z.infer<typeof artifactRefSchema>;
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type ModelBindingMetadata = z.infer<typeof modelBindingMetadataSchema>;
export type MutationRef = z.infer<typeof mutationRefSchema>;
export type HarnessRunState = z.infer<typeof harnessRunStateSchema>;
export type GithubPullRequestRef = z.infer<typeof githubPullRequestRefSchema>;
