import { z } from "zod";

import {
  actorRefSchema,
  artifactRefSchema,
  githubPullRequestRefSchema,
  integrationIdSchema,
  integrationTextSchema,
  integrationTimestampSchema,
  sha256Schema,
} from "./agent-integration-common.js";
import {
  agentRunProjectionV1Schema,
  assertAgentRunProjectionWithinTask,
  type AgentRunProjectionV1,
} from "./agent-run-projection.js";
import { agentTaskApprovalHashMatches } from "./agent-contract-hash.js";
import { agentTaskV1Schema, type AgentTaskV1 } from "./agent-task.js";

export const verifiedHandoffV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("verified_handoff"),
  workItemId: integrationIdSchema,
  correlationId: integrationIdSchema,
  harnessRunId: integrationIdSchema,
  taskVersion: z.number().int().positive().safe(),
  taskHash: sha256Schema,
  taskIntentRef: artifactRefSchema,
  taskIntentHash: sha256Schema,
  runManifestRef: artifactRefSchema,
  runManifestHash: sha256Schema,
  outcome: z.enum(["completed", "partial", "failed"]),
  deliverables: z.object({
    patchRef: artifactRefSchema.optional(),
    commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    summaryRef: artifactRefSchema,
    structuredSubmissionRef: artifactRefSchema,
    artifacts: z.array(artifactRefSchema).max(1_000),
  }).strict(),
  checks: z.array(z.object({
    name: integrationTextSchema,
    commandHash: sha256Schema.optional(),
    status: z.enum(["passed", "failed", "skipped"]),
    evidenceRef: artifactRefSchema,
  }).strict()).min(1).max(500),
  verification: z.object({
    verified: z.boolean(),
    decision: z.enum(["accept", "reject", "inconclusive"]),
    verifier: actorRefSchema,
    planHash: sha256Schema,
    decisionRef: artifactRefSchema,
    decisionHash: sha256Schema,
    evidenceRefs: z.array(artifactRefSchema).min(1).max(1_000),
    verifiedAt: integrationTimestampSchema,
  }).strict(),
  openQuestions: z.array(z.string().trim().min(1).max(8_000)).max(200),
  eligibleForPrOpen: z.boolean(),
  pullRequest: githubPullRequestRefSchema.optional(),
  generatedAt: integrationTimestampSchema,
}).strict().superRefine((handoff, context) => {
  const hashBindings: Array<{
    ref: { sha256: string };
    hash: string;
    path: Array<string | number>;
    label: string;
  }> = [
    {
      ref: handoff.taskIntentRef,
      hash: handoff.taskIntentHash,
      path: ["taskIntentHash"],
      label: "TaskIntent",
    },
    {
      ref: handoff.runManifestRef,
      hash: handoff.runManifestHash,
      path: ["runManifestHash"],
      label: "run manifest",
    },
    {
      ref: handoff.verification.decisionRef,
      hash: handoff.verification.decisionHash,
      path: ["verification", "decisionHash"],
      label: "verification decision",
    },
  ];
  for (const binding of hashBindings) {
    if (binding.ref.sha256 !== binding.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${binding.label} ref hash must match its declared hash`,
        path: binding.path,
      });
    }
  }
  if (handoff.verification.verifier.type !== "verifier") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "verification actor must have verifier type",
      path: ["verification", "verifier", "type"],
    });
  }
  if (handoff.verification.verified !== (handoff.verification.decision === "accept")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "verified must be true exactly when the verifier decision is accept",
      path: ["verification", "verified"],
    });
  }
  if (handoff.eligibleForPrOpen) {
    if (handoff.outcome !== "completed") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PR-open eligibility requires completed outcome",
        path: ["eligibleForPrOpen"],
      });
    }
    if (!handoff.verification.verified) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PR-open eligibility requires verified acceptance",
        path: ["eligibleForPrOpen"],
      });
    }
    if (handoff.checks.some((check) => check.status !== "passed")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "PR-open eligibility requires every recorded check to pass",
        path: ["checks"],
      });
    }
  }
});

export type VerifiedHandoffV1 = z.infer<typeof verifiedHandoffV1Schema>;

export async function assertVerifiedHandoffMatchesTaskAndRun(
  taskInput: AgentTaskV1,
  projectionInput: AgentRunProjectionV1,
  handoffInput: VerifiedHandoffV1,
): Promise<void> {
  const task = agentTaskV1Schema.parse(taskInput);
  const projection = agentRunProjectionV1Schema.parse(projectionInput);
  const handoff = verifiedHandoffV1Schema.parse(handoffInput);

  assertAgentRunProjectionWithinTask(task, projection);
  if (!await agentTaskApprovalHashMatches(task)) {
    throw new Error("verified handoff requires an exact approved task hash");
  }
  if (handoff.workItemId !== task.workItemId
      || handoff.correlationId !== task.correlationId
      || handoff.taskVersion !== task.taskVersion
      || handoff.harnessRunId !== projection.harnessRunId) {
    throw new Error("verified handoff identity does not match task and run");
  }
  if (handoff.taskHash !== task.approval.approvedTaskHash) {
    throw new Error("verified handoff task hash does not match approved task");
  }
  if (handoff.taskIntentHash !== task.intent.templateHash) {
    throw new Error("verified handoff TaskIntent hash does not match approved task");
  }
  if (handoff.runManifestHash !== projection.manifest.hash) {
    throw new Error("verified handoff manifest hash does not match run projection");
  }
  if (handoff.verification.planHash !== task.acceptance.verifierPlanHash) {
    throw new Error("verified handoff verifier plan does not match approved task");
  }
  if (projection.verification?.decisionHash
      && handoff.verification.decisionHash !== projection.verification.decisionHash) {
    throw new Error("verified handoff decision does not match run projection");
  }
  if (handoff.eligibleForPrOpen) {
    if (projection.run.outcome !== "completed" || projection.verification?.status !== "passed") {
      throw new Error("PR-open handoff requires a completed run and passed verification projection");
    }
  }
}
