import { z } from "zod";

import {
  artifactRefSchema,
  integrationIdSchema,
  integrationTextSchema,
  sha256Schema,
} from "./agent-integration-common.js";

const gitObjectIdSchema = z.string().regex(/^[a-f0-9]{40}$/);
const gitRefSchema = z.string()
  .trim()
  .min(1)
  .max(240)
  .refine(isSafeGitRef, "invalid Git ref");

/**
 * The immutable INT-3a artifact. It is deliberately richer than GitHub's
 * create-PR request: the refs are paired with the exact base revision, patched
 * tree, and patch bytes that a later actuator would have to materialize.
 */
export const pullRequestPayloadV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("pull_request_payload"),
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).max(240),
  base: z.object({
    ref: gitRefSchema,
    revision: gitObjectIdSchema,
  }).strict(),
  head: z.object({
    ref: gitRefSchema,
    treeSha: gitObjectIdSchema,
  }).strict(),
  title: integrationTextSchema,
  body: z.string().trim().min(1).max(65_536),
  patch: z.object({
    ref: artifactRefSchema,
    sha256: sha256Schema,
    bytes: z.string().max(10_000_000),
  }).strict(),
  source: z.object({
    workItemId: integrationIdSchema,
    taskVersion: z.number().int().positive().safe(),
    approvedTaskHash: sha256Schema,
    harnessRunId: integrationIdSchema,
    verificationDecisionHash: sha256Schema,
  }).strict(),
}).strict().superRefine((payload, context) => {
  if (payload.patch.ref.sha256 !== payload.patch.sha256) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "patch ref hash must match the declared patch hash",
      path: ["patch", "sha256"],
    });
  }
});

export type PullRequestPayloadV1 = z.infer<
  typeof pullRequestPayloadV1Schema
>;

function isSafeGitRef(value: string): boolean {
  const components = value.split("/");
  return value !== "@"
    && !value.startsWith("/")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("..")
    && !value.includes("@{")
    && !value.includes("//")
    && !components.some(
      (component) => component.startsWith(".") || component.endsWith(".lock"),
    )
    && ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20
        || code === 0x7f
        || "~^:?*[\\".includes(character);
    });
}
