import { z } from "zod";

import {
  actorRefSchema,
  artifactRefSchema,
  integrationIdSchema,
  integrationTextSchema,
  integrationTimestampSchema,
  mutationRefSchema,
  sha256Schema,
} from "./agent-integration-common.js";
import { agentTaskRiskTierSchema } from "./agent-task.js";

export const hermesDecisionRecordV1Schema = z.object({
  schemaVersion: z.literal(1),
  recordType: z.literal("hermes_decision_record"),
  id: integrationIdSchema,
  kind: z.enum(["routing", "auto_approval", "escalation", "anomaly_pause", "away_digest"]),
  subject: z.object({
    type: z.enum(["task", "card", "repo", "pr", "mission", "digest", "autopilot_session"]),
    id: integrationIdSchema,
    repo: integrationTextSchema.optional(),
    pullRequestNumber: z.number().int().positive().safe().optional(),
  }).strict(),
  decision: integrationTextSchema,
  reasons: z.array(integrationTextSchema).min(1).max(50),
  inputs: z.record(z.unknown()),
  outcome: z.object({
    summary: integrationTextSchema,
    waitingNext: integrationTextSchema.optional(),
    changed: z.array(integrationTextSchema).max(200).optional(),
  }).strict(),
  safety: z.object({
    readOnly: z.boolean(),
    mutates: z.boolean(),
    mutatesGithub: z.boolean().optional(),
    mutatesAverray: z.boolean().optional(),
    editsWikipedia: z.boolean().optional(),
  }).strict(),
  generatedAt: integrationTimestampSchema,
}).strict();

export const hermesDecisionTypeV2Schema = z.enum([
  "task_proposal",
  "risk_classification",
  "executor_selection",
  "dispatch_approval",
  "dispatch_refusal",
  "anomaly_pause",
  "handoff",
  "escalation",
  "away_digest",
]);

export const hermesDecisionRecordV2Schema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("hermes_decision"),
  decisionId: integrationIdSchema,
  correlationId: integrationIdSchema,
  workItemId: integrationIdSchema.optional(),
  decisionType: hermesDecisionTypeV2Schema,
  proposal: z.object({
    what: integrationTextSchema,
    why: z.array(integrationTextSchema).min(1).max(50),
    whyNow: integrationTextSchema.optional(),
    evidenceRefs: z.array(artifactRefSchema).max(500),
  }).strict(),
  inputs: z.array(z.object({
    name: integrationIdSchema,
    ref: artifactRefSchema.optional(),
    hash: sha256Schema.optional(),
    observedAt: integrationTimestampSchema.optional(),
  }).strict().superRefine((input, context) => {
    if (input.ref && input.hash && input.ref.sha256 !== input.hash) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "input ref hash must match declared hash",
        path: ["hash"],
      });
    }
  })).max(500),
  routing: z.discriminatedUnion("executor", [
    z.object({
      executor: z.literal("harness"),
      modelProvider: integrationIdSchema.optional(),
      modelRef: integrationTextSchema.optional(),
      reason: integrationTextSchema,
      scorecardRef: artifactRefSchema.optional(),
    }).strict(),
    z.object({
      executor: z.literal("direct"),
      directAgent: z.enum(["codex", "claude", "test-writer", "security", "docs"]),
      modelProvider: integrationIdSchema.optional(),
      modelRef: integrationTextSchema.optional(),
      reason: integrationTextSchema,
      scorecardRef: artifactRefSchema.optional(),
    }).strict(),
  ]).optional(),
  risk: z.object({
    tier: agentTaskRiskTierSchema,
    reasons: z.array(integrationTextSchema).min(1).max(50),
    irreversible: z.boolean(),
  }).strict(),
  approval: z.object({
    required: z.enum(["policy", "operator"]),
    decision: z.enum(["pending", "approved", "denied", "expired", "not_applicable"]),
    actor: actorRefSchema.optional(),
    policyVersion: integrationIdSchema,
    policyHash: sha256Schema,
    decidedAt: integrationTimestampSchema.optional(),
  }).strict().superRefine((approval, context) => {
    const decided = approval.decision === "approved"
      || approval.decision === "denied"
      || approval.decision === "expired";
    if (decided && (!approval.actor || !approval.decidedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "decided approval requires actor and decidedAt",
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
  }),
  effects: z.object({
    mutates: z.boolean(),
    mutations: z.array(mutationRefSchema).max(500),
    authorityChanged: z.boolean(),
    budgetChanged: z.boolean(),
  }).strict(),
  next: z.object({
    action: integrationTextSchema,
    owner: z.enum(["operator", "hermes", "dispatcher", "harness", "verifier", "averray"]),
    dueAt: integrationTimestampSchema.optional(),
    blockedBy: z.array(integrationTextSchema).max(200).optional(),
  }).strict(),
  generatedAt: integrationTimestampSchema,
}).strict().superRefine((record, context) => {
  if (!record.effects.mutates
      && (record.effects.mutations.length > 0
        || record.effects.authorityChanged
        || record.effects.budgetChanged)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "non-mutating decisions cannot declare mutations or authority/budget changes",
      path: ["effects", "mutates"],
    });
  }
  if (record.effects.mutates && record.effects.mutations.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "mutating decisions must identify at least one mutation",
      path: ["effects", "mutations"],
    });
  }
});

export const hermesDecisionRecordSchema = z.union([
  hermesDecisionRecordV1Schema,
  hermesDecisionRecordV2Schema,
]);

export interface HermesDecisionCompatibilityView {
  sourceVersion: 1 | 2;
  decisionId: string;
  decisionType: string;
  correlationId?: string;
  workItemId?: string;
  why: string[];
  approvalDecision: string;
  mutates: boolean;
  nextAction?: string;
  generatedAt: string;
  legacy: boolean;
}

export function parseHermesDecisionRecord(value: unknown): HermesDecisionRecord {
  return hermesDecisionRecordSchema.parse(value);
}

export function toHermesDecisionCompatibilityView(
  input: unknown,
): HermesDecisionCompatibilityView {
  const record = parseHermesDecisionRecord(input);
  if (record.schemaVersion === 1) {
    return {
      sourceVersion: 1,
      decisionId: record.id,
      decisionType: record.kind,
      why: record.reasons,
      approvalDecision: record.decision,
      mutates: record.safety.mutates,
      ...(record.outcome.waitingNext ? { nextAction: record.outcome.waitingNext } : {}),
      generatedAt: record.generatedAt,
      legacy: true,
    };
  }
  return {
    sourceVersion: 2,
    decisionId: record.decisionId,
    decisionType: record.decisionType,
    correlationId: record.correlationId,
    ...(record.workItemId ? { workItemId: record.workItemId } : {}),
    why: record.proposal.why,
    approvalDecision: record.approval.decision,
    mutates: record.effects.mutates,
    nextAction: record.next.action,
    generatedAt: record.generatedAt,
    legacy: false,
  };
}

export type HermesDecisionRecordV1 = z.infer<typeof hermesDecisionRecordV1Schema>;
export type HermesDecisionRecordV2 = z.infer<typeof hermesDecisionRecordV2Schema>;
export type HermesDecisionRecord = z.infer<typeof hermesDecisionRecordSchema>;
