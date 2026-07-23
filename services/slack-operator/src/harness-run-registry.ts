import { readFile, stat } from "node:fs/promises";

import {
  agentRunManifestProjectionSchema,
  githubPullRequestRefSchema,
  integrationIdSchema,
  integrationTextSchema,
  integrationTimestampSchema,
  nonNegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
} from "@avg/schemas";
import { z } from "zod";

const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_PILOT_BINDINGS = 100;

const harnessProjectionBudgetSchema = z.object({
  elapsedSecondsLimit: positiveSafeIntegerSchema.optional(),
  modelTokensLimit: positiveSafeIntegerSchema.optional(),
  toolCallsLimit: positiveSafeIntegerSchema.optional(),
  estimatedUsdMicrosLimit: nonNegativeSafeIntegerSchema.nullable().optional(),
}).strict();

export const harnessRunBindingSchema = z.object({
  workItemId: integrationIdSchema,
  correlationId: integrationIdSchema,
  harnessRunId: z.string().uuid(),
  taskVersion: positiveSafeIntegerSchema,
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/).max(240),
  title: integrationTextSchema,
  summary: integrationTextSchema.optional(),
  registeredAt: integrationTimestampSchema,
  staleAfterSeconds: positiveSafeIntegerSchema.max(86_400).default(300),
  manifest: agentRunManifestProjectionSchema,
  budget: harnessProjectionBudgetSchema,
  averrayJobId: integrationIdSchema.optional(),
  averraySessionId: integrationIdSchema.optional(),
  pullRequest: githubPullRequestRefSchema.optional(),
}).strict().superRefine((binding, context) => {
  const roles = new Set<string>();
  for (let index = 0; index < binding.manifest.modelBindings.length; index += 1) {
    const role = binding.manifest.modelBindings[index]!.role;
    if (roles.has(role)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate model binding role: ${role}`,
        path: ["manifest", "modelBindings", index, "role"],
      });
    }
    roles.add(role);
  }
});

export const harnessRunRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("harness_run_registry"),
  bindings: z.array(harnessRunBindingSchema).max(MAX_PILOT_BINDINGS),
}).strict().superRefine((registry, context) => {
  for (const field of ["workItemId", "correlationId", "harnessRunId"] as const) {
    const seen = new Set<string>();
    for (let index = 0; index < registry.bindings.length; index += 1) {
      const value = registry.bindings[index]![field];
      if (seen.has(value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate ${field}: ${value}`,
          path: ["bindings", index, field],
        });
      }
      seen.add(value);
    }
  }
});

export type HarnessRunBinding = z.infer<typeof harnessRunBindingSchema>;
export type HarnessRunRegistry = z.infer<typeof harnessRunRegistrySchema>;

export class HarnessRunRegistryError extends Error {
  constructor(
    readonly code:
      | "registry_missing"
      | "registry_too_large"
      | "registry_read_failed"
      | "registry_invalid_json"
      | "registry_invalid"
      | "registry_secret_like_value",
    message: string,
  ) {
    super(message);
    this.name = "HarnessRunRegistryError";
  }
}

export function harnessProjectionEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment.HARNESS_PROJECTION_ENABLED?.trim().toLowerCase() ?? "false";
  return value === "1" || value === "true";
}

export function harnessProjectionReadTimeoutMs(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = environment.HARNESS_PROJECTION_READ_TIMEOUT_MS ?? "5000";
  if (!/^[0-9]+$/.test(raw)) return 5_000;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return 5_000;
  return Math.max(250, Math.min(30_000, parsed));
}

export function parseHarnessRunRegistry(input: unknown): HarnessRunRegistry {
  const secretPath = firstSecretLikePath(input);
  if (secretPath) {
    throw new HarnessRunRegistryError(
      "registry_secret_like_value",
      `Harness pilot registry contains a secret-like value at ${secretPath}`,
    );
  }
  const parsed = harnessRunRegistrySchema.safeParse(input);
  if (!parsed.success) {
    throw new HarnessRunRegistryError(
      "registry_invalid",
      `Harness pilot registry is invalid: ${parsed.error.issues[0]?.message ?? "schema validation failed"}`,
    );
  }
  return parsed.data;
}

export async function loadHarnessRunRegistry(registryPath: string): Promise<HarnessRunRegistry> {
  const normalizedPath = registryPath.trim();
  if (!normalizedPath) {
    throw new HarnessRunRegistryError(
      "registry_missing",
      "HARNESS_PROJECTION_BINDINGS_PATH is required when Harness projection is enabled",
    );
  }

  try {
    const info = await stat(normalizedPath);
    if (!info.isFile()) {
      throw new HarnessRunRegistryError("registry_read_failed", "Harness pilot registry path is not a file");
    }
    if (info.size > MAX_REGISTRY_BYTES) {
      throw new HarnessRunRegistryError(
        "registry_too_large",
        `Harness pilot registry exceeds ${MAX_REGISTRY_BYTES} bytes`,
      );
    }
  } catch (error) {
    if (error instanceof HarnessRunRegistryError) throw error;
    throw new HarnessRunRegistryError("registry_read_failed", "Harness pilot registry could not be read");
  }

  let raw: string;
  try {
    raw = await readFile(normalizedPath, "utf8");
  } catch {
    throw new HarnessRunRegistryError("registry_read_failed", "Harness pilot registry could not be read");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_REGISTRY_BYTES) {
    throw new HarnessRunRegistryError(
      "registry_too_large",
      `Harness pilot registry exceeds ${MAX_REGISTRY_BYTES} bytes`,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new HarnessRunRegistryError("registry_invalid_json", "Harness pilot registry is not valid JSON");
  }
  return parseHarnessRunRegistry(decoded);
}

function firstSecretLikePath(input: unknown): string | undefined {
  const stack: Array<{ value: unknown; path: string }> = [{ value: input, path: "$" }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (Array.isArray(current.value)) {
      current.value.forEach((value, index) => stack.push({ value, path: `${current.path}[${index}]` }));
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
      const path = `${current.path}.${key}`;
      const normalizedKey = key.replace(/[-_]/g, "").toLowerCase();
      if ([
        "secret",
        "token",
        "password",
        "privatekey",
        "apikey",
        "databaseurl",
        "dsn",
        "authtoken",
        "accesstoken",
        "refreshtoken",
      ].includes(normalizedKey)) {
        return path;
      }
      if (typeof value === "string" && isSecretLikeString(value)) return path;
      stack.push({ value, path });
    }
  }
  return undefined;
}

function isSecretLikeString(value: string): boolean {
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value)
    || /^Bearer\s+\S+/i.test(value)
    || /^(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}$/.test(value)
    || /^0x[a-fA-F0-9]{64}$/.test(value);
}
