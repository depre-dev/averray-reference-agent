import type { TestbedMissionMode } from "./monitor-testbed-missions.js";

export type TestbedMissionEnvironment = "local" | "preview" | "testnet" | "staging" | "mainnet" | "unknown";
export type TestbedMissionMutationMode = "read_only" | "testbed_mutation_allowed";

export interface TestbedMutationBindingInput {
  targetUrl?: string;
  mode?: TestbedMissionMode;
  requestedAllowTestMutations?: boolean;
  configuredEnvironment?: string;
}

export interface TestbedMutationBinding {
  environment: TestbedMissionEnvironment;
  mutationMode: TestbedMissionMutationMode;
  mutationScope: string;
  allowTestMutations: boolean;
  requestedAllowTestMutations: boolean;
  reason: string;
}

const TESTBED_MUTATING_ENVS = new Set<TestbedMissionEnvironment>(["local", "testnet", "staging"]);

export function testbedEnvironmentFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.TESTBED_MISSION_ENVIRONMENT || env.AVERRAY_TESTBED_ENVIRONMENT || env.TEST_WALLET_SIGNER_ENVIRONMENT;
}

export function resolveTestbedMutationBinding(input: TestbedMutationBindingInput = {}): TestbedMutationBinding {
  const requestedAllowTestMutations = input.requestedAllowTestMutations === true;
  const environment = normalizeMissionEnvironment(input.configuredEnvironment)
    ?? inferMissionEnvironment(input.targetUrl);

  if (input.mode === "surface_sweep" || input.mode === "siwe_auth") {
    return readOnlyBinding({
      environment,
      requestedAllowTestMutations,
      reason: `${input.mode} missions are read-only by contract.`,
    });
  }

  if (!requestedAllowTestMutations) {
    return readOnlyBinding({
      environment,
      requestedAllowTestMutations,
      reason: "mission did not request testbed mutations.",
    });
  }

  if (!TESTBED_MUTATING_ENVS.has(environment)) {
    return readOnlyBinding({
      environment,
      requestedAllowTestMutations,
      reason: `testbed mutations denied for ${environment} environment.`,
    });
  }

  return {
    environment,
    mutationMode: "testbed_mutation_allowed",
    mutationScope: "testbed-only page actions that are visibly fake, sandbox, or non-production",
    allowTestMutations: true,
    requestedAllowTestMutations,
    reason: `testbed mutations allowed because environment is ${environment}.`,
  };
}

export function annotateMissionWithMutationBinding<T extends Record<string, unknown>>(
  mission: T,
  binding: TestbedMutationBinding
): T {
  const target = asRecord(mission.target);
  const agentMode = asRecord(mission.agentMode);
  const safety = asRecord(mission.safety);
  const reportSchema = asRecord(mission.reportSchema);
  const originalPrompt = typeof mission.missionPrompt === "string" ? mission.missionPrompt.trim() : "";
  const override = binding.allowTestMutations
    ? `Mutation profile: ${binding.environment} / ${binding.mutationMode}. ${binding.mutationScope}.`
    : `Mutation profile override: ${binding.environment} / ${binding.mutationMode}. ${binding.reason} Stop before every mutation boundary.`;

  return {
    ...mission,
    target: {
      ...target,
      environment: binding.environment,
      mutationMode: binding.mutationMode,
      mutationScope: binding.mutationScope,
    },
    agentMode: {
      ...agentMode,
      mutationMode: binding.allowTestMutations ? "testbed_mutation_allowed" : "stop_before_mutation",
    },
    missionPrompt: originalPrompt
      ? `${originalPrompt}\n\n${override}`
      : override,
    reportSchema: {
      ...reportSchema,
      mutationMode: binding.allowTestMutations ? "testbed_mutation_allowed" : "stop_before_mutation",
      trace: "optional Playwright trace artifact path or URL",
      video: "optional Playwright video artifact path or URL",
      baselineComparison: "optional comparison against the previous completed run for this target/env",
    },
    safety: {
      ...safety,
      browserMissionShouldMutate: binding.allowTestMutations,
      requestedBrowserMissionShouldMutate: binding.requestedAllowTestMutations,
      mutationEnvironment: binding.environment,
      mutationMode: binding.mutationMode,
      allowedMutationScope: binding.mutationScope,
      mutationBindingReason: binding.reason,
    },
  };
}

function readOnlyBinding(input: {
  environment: TestbedMissionEnvironment;
  requestedAllowTestMutations: boolean;
  reason: string;
}): TestbedMutationBinding {
  return {
    environment: input.environment,
    mutationMode: "read_only",
    mutationScope: "none; stop at mutation boundary",
    allowTestMutations: false,
    requestedAllowTestMutations: input.requestedAllowTestMutations,
    reason: input.reason,
  };
}

function normalizeMissionEnvironment(value: string | undefined): TestbedMissionEnvironment | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "local" || normalized === "localhost" || normalized === "dev") return "local";
  if (normalized === "preview" || normalized === "pr" || normalized === "ephemeral") return "preview";
  if (normalized === "testnet" || normalized === "testbed" || normalized === "sandbox") return "testnet";
  if (normalized === "staging" || normalized === "stage") return "staging";
  if (normalized === "mainnet" || normalized === "prod" || normalized === "production") return "mainnet";
  return "unknown";
}

function inferMissionEnvironment(targetUrl: string | undefined): TestbedMissionEnvironment {
  if (!targetUrl) return "unknown";
  try {
    const url = new URL(targetUrl);
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) return "local";
    if (host.includes("testbed") || host.includes("testnet") || host.includes("sandbox")) return "testnet";
    if (host.includes("staging") || host.includes("stage")) return "staging";
    if (host.includes("preview") || host.endsWith(".vercel.app")) return "preview";
    if (host === "averray.com" || host.endsWith(".averray.com")) return "mainnet";
  } catch {
    return "unknown";
  }
  return "unknown";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
