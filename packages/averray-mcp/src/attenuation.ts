import {
  hashTaskIntent,
  type AgentTaskV1,
  type PilotProfileManifest,
  type TaskIntent,
} from "@avg/schemas";

export class AttenuationError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "AttenuationError";
  }
}

export async function assertTaskIntentWithinApprovedAuthority(
  task: AgentTaskV1,
  intent: TaskIntent,
  profile: PilotProfileManifest,
): Promise<void> {
  let intentHash: `sha256:${string}`;
  try {
    intentHash = await hashTaskIntent(intent);
  } catch {
    fail("template_hash_mismatch", "TaskIntent cannot be hashed as a valid contract");
  }
  if (intentHash !== task.intent.templateHash) {
    fail("template_hash_mismatch", "TaskIntent hash does not match the approved template hash");
  }

  if (
    intent.spec.profile !== task.intent.profile
    || intent.spec.profile !== profile.profileId
  ) {
    fail("profile_mismatch", "TaskIntent, AgentTask, and profile identities must match");
  }

  assertNetworkWithinTask(task, intent);
  assertPathsWithinTask(task, intent);
  assertBudgetWithinTask(task, intent);

  const authority = task.requestedAuthority;
  if (
    authority.maxChildren !== 0
    || authority.maxConcurrentChildren !== 0
    || authority.delegable !== false
  ) {
    fail("children_not_zero", "Approved authority must disable children and delegation");
  }

  if (
    !Array.isArray(profile.strategies)
    || profile.strategies.length !== 1
    || profile.strategies[0] !== "direct_execution"
  ) {
    fail(
      "profile_not_direct_execution",
      "The approved profile must use direct execution only",
    );
  }

  if (!Array.isArray(profile.capabilities) || profile.capabilities.length === 0) {
    fail(
      "capability_not_granted",
      "The approved profile must declare a non-empty capability manifest",
    );
  }

  const delegableCapability = profile.capabilities.find((capability) => capability.delegable);
  if (delegableCapability) {
    fail(
      "capability_delegable",
      `Profile capability is delegable: ${delegableCapability.id}`,
    );
  }

  const externalCapability = profile.capabilities.find(
    (capability) =>
      capability.effectClass !== "none" && capability.effectClass !== "local",
  );
  if (externalCapability) {
    fail(
      "capability_effect_external",
      `Profile capability has an external effect class: ${externalCapability.id}`,
    );
  }

  const approvedCapabilities = new Set(
    authority.grants.map((grant) => grant.capabilityId),
  );
  const unapprovedCapability = profile.capabilities.find(
    (capability) => !approvedCapabilities.has(capability.id),
  );
  if (unapprovedCapability) {
    fail(
      "capability_not_granted",
      `Profile capability is not present in the approved grants: ${unapprovedCapability.id}`,
    );
  }
}

function assertNetworkWithinTask(task: AgentTaskV1, intent: TaskIntent): void {
  const approved = task.requestedAuthority.network;
  const requested = intent.spec.constraints.network;
  if (approved === "deny") {
    if (requested !== "deny") {
      fail("network_expanded", "A deny network policy cannot be expanded");
    }
    return;
  }
  if (requested === "deny") return;

  const approvedDestinations = new Set(approved.allowlist);
  const expandedDestination = requested.allow.find(
    (destination) => !approvedDestinations.has(destination),
  );
  if (expandedDestination) {
    fail(
      "network_expanded",
      `TaskIntent network destination is not approved: ${expandedDestination}`,
    );
  }
}

function assertPathsWithinTask(task: AgentTaskV1, intent: TaskIntent): void {
  const approvedAllowedPaths = new Set(task.repository.allowedPaths);
  const outsideAllowedPaths = intent.spec.constraints.allowed_paths.find(
    (path) => !approvedAllowedPaths.has(path),
  );
  if (outsideAllowedPaths) {
    fail("path_not_allowed", `TaskIntent path is not approved: ${outsideAllowedPaths}`);
  }

  const requestedForbiddenPaths = new Set(intent.spec.constraints.forbidden_paths);
  const removedForbiddenPath = task.repository.forbiddenPaths.find(
    (path) => !requestedForbiddenPaths.has(path),
  );
  if (removedForbiddenPath) {
    fail(
      "forbidden_paths_narrowed",
      `TaskIntent removed an approved forbidden path: ${removedForbiddenPath}`,
    );
  }

  const conflictingPath = intent.spec.constraints.allowed_paths.find(
    (path) => requestedForbiddenPaths.has(path),
  );
  if (conflictingPath) {
    fail("path_not_allowed", `TaskIntent path is also forbidden: ${conflictingPath}`);
  }
}

function assertBudgetWithinTask(task: AgentTaskV1, intent: TaskIntent): void {
  const elapsedMatch = /^PT(\d+)S$/.exec(intent.spec.budgets.elapsed);
  const elapsedSeconds = elapsedMatch ? Number(elapsedMatch[1]) : Number.NaN;
  if (
    !Number.isSafeInteger(elapsedSeconds)
    || elapsedSeconds > task.budget.elapsedSeconds
    || intent.spec.budgets.model_tokens > task.budget.modelTokens
    || intent.spec.budgets.tool_calls > task.budget.toolCalls
  ) {
    fail("budget_exceeded", "TaskIntent budget exceeds the approved AgentTask budget");
  }
}

function fail(reason: string, message: string): never {
  throw new AttenuationError(reason, message);
}
