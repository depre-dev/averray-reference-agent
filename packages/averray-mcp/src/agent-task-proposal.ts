import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { assertNoKillSwitch } from "@avg/mcp-common";
import {
  actorRefSchema,
  agentTaskV1Schema,
  artifactRefSchema,
  canonicalContractJson,
  hashAgentTaskApprovalPayload,
  hashCanonicalContract,
  integrationIdSchema,
  type AcceptanceCriterion,
  type ActorRef,
  type AgentTaskV1,
  type ArtifactRef,
} from "@avg/schemas";

import {
  getAgentTask,
  putAgentTask,
} from "./agent-task-store.js";
import {
  buildTaskIntentArtifact,
} from "./task-intent-mapping.js";
import {
  workspacePathForTask,
} from "./workspace-path.js";

const PLACEHOLDER_HASH =
  `sha256:${"0".repeat(64)}` as const;

export const PILOT_CAPABILITY_IDS = Object.freeze([
  "fs.read_file",
  "fs.write_file",
  "fs.list_files",
  "shell.run",
  "git.status",
  "git.diff",
  "artifact.put",
  "artifact.get",
] as const);

export type AgentTaskRequester = Omit<ActorRef, "type"> & {
  type: "operator" | "hermes" | "averray";
};

export interface ProposeAgentTaskInput {
  workItemId: string;
  taskVersion?: number;
  correlationId: string;
  taskKind: string;
  title: string;
  objective: string;
  whyNow: string;
  requestedBy: AgentTaskRequester;
  repository: {
    nameWithOwner: string;
    baseRevision: string;
    allowedPaths: string[];
    forbiddenPaths: string[];
  };
  profile: string;
  acceptanceCriteria: AcceptanceCriterion[];
  budget: {
    elapsedSeconds: number;
    modelTokens: number;
    toolCalls: number;
    estimatedUsdMicros: number | null;
  };
  deadline: string;
  riskTier?: "low" | "medium";
  selectionReason: string;
}

export type AgentTaskArtifactWriter = (
  bytes: string,
) => Promise<ArtifactRef>;

export interface ProposeAgentTaskDeps {
  policyConfig: unknown;
  policyVersion: string;
  now?: () => Date;
  assertMutationAllowed?: (operation: string) => Promise<void>;
  writeArtifact?: AgentTaskArtifactWriter;
  putTask?: (task: AgentTaskV1) => Promise<AgentTaskV1>;
  environment?: Readonly<Record<string, string | undefined>>;
}

export interface ApproveAgentTaskInput {
  workItemId: string;
  taskVersion: number;
  actor: ActorRef;
}

export interface ApproveAgentTaskDeps {
  now?: () => Date;
  assertMutationAllowed?: (operation: string) => Promise<void>;
  getTask?: (
    workItemId: string,
    taskVersion: number,
  ) => Promise<AgentTaskV1 | undefined>;
  putTask?: (task: AgentTaskV1) => Promise<AgentTaskV1>;
}

export async function dispatchPolicyIdentity(
  config: unknown,
  version: string,
): Promise<{
  policyVersion: string;
  policyHash: `sha256:${string}`;
}> {
  return {
    policyVersion: integrationIdSchema.parse(version),
    policyHash: await hashCanonicalContract(config),
  };
}

export async function proposeAgentTask(
  input: ProposeAgentTaskInput,
  deps: ProposeAgentTaskDeps,
): Promise<AgentTaskV1> {
  await (deps.assertMutationAllowed ?? assertNoKillSwitch)(
    "agent_task_propose",
  );
  const proposedAt = nowIso(deps.now);
  const deadlineMs = Date.parse(input.deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.parse(proposedAt)) {
    throw new Error("AgentTask proposal deadline must be later than now");
  }
  const riskTier = input.riskTier ?? "low";
  if (riskTier !== "low" && riskTier !== "medium") {
    throw new Error("High-risk Harness tasks cannot be proposed");
  }
  const requestedBy = actorRefSchema.parse(input.requestedBy);
  if (
    requestedBy.type !== "operator"
    && requestedBy.type !== "hermes"
    && requestedBy.type !== "averray"
  ) {
    throw new Error(`${requestedBy.type} cannot request an AgentTask`);
  }

  const taskVersion = input.taskVersion ?? 1;
  const policy = await dispatchPolicyIdentity(
    deps.policyConfig,
    deps.policyVersion,
  );
  const verifierPlanBytes = canonicalContractJson(
    input.acceptanceCriteria,
  );
  const verifierPlanHash = await hashCanonicalContract(
    input.acceptanceCriteria,
  );
  const verifierPlanRef = contentAddressedRef(verifierPlanHash);
  const placeholderRef = contentAddressedRef(PLACEHOLDER_HASH);

  const draft = agentTaskV1Schema.parse({
    schemaVersion: 1,
    kind: "agent_task",
    workItemId: input.workItemId,
    taskVersion,
    correlationId: input.correlationId,
    taskKind: input.taskKind,
    lifecycle: "proposed",
    proposal: {
      title: input.title,
      objective: input.objective,
      whyNow: input.whyNow,
      requestedBy,
      createdAt: proposedAt,
      sourceRefs: [],
    },
    repository: {
      provider: "github",
      ...input.repository,
    },
    intent: {
      apiVersion: "harness/v1alpha1",
      profile: input.profile,
      templateRef: placeholderRef,
      templateHash: PLACEHOLDER_HASH,
    },
    acceptance: {
      criteria: input.acceptanceCriteria,
      verifierPlanRef,
      verifierPlanHash,
    },
    risk: {
      tier: riskTier,
      reasons: [input.whyNow],
      irreversible: false,
    },
    requestedAuthority: {
      grants: PILOT_CAPABILITY_IDS.map((capabilityId) => ({
        capabilityId,
        resource: input.repository.nameWithOwner,
        constraints: {},
      })),
      network: "deny",
      maxChildren: 0,
      maxConcurrentChildren: 0,
      delegable: false,
    },
    budget: input.budget,
    deadline: input.deadline,
    executor: {
      kind: "harness",
      selectionReason: input.selectionReason,
    },
    approval: {
      required: "operator",
      status: "pending",
      ...policy,
    },
    timestamps: {
      proposedAt,
      updatedAt: proposedAt,
    },
  });

  const intentArtifact = await buildTaskIntentArtifact(draft, {
    workspacePath: workspacePathForTask(input.workItemId, taskVersion),
  });
  const templateRef = contentAddressedRef(intentArtifact.templateHash);
  const task = agentTaskV1Schema.parse({
    ...draft,
    intent: {
      ...draft.intent,
      templateRef,
      templateHash: intentArtifact.templateHash,
    },
  });

  const writer = deps.writeArtifact
    ?? ((bytes) =>
      writeDispatchArtifact(bytes, deps.environment ?? process.env));
  assertStoredArtifact(
    await writer(verifierPlanBytes),
    verifierPlanRef,
  );
  assertStoredArtifact(
    await writer(intentArtifact.canonicalBytes),
    templateRef,
  );
  return (deps.putTask ?? putAgentTask)(task);
}

export async function approveAgentTask(
  input: ApproveAgentTaskInput,
  deps: ApproveAgentTaskDeps = {},
): Promise<AgentTaskV1> {
  await (deps.assertMutationAllowed ?? assertNoKillSwitch)(
    "agent_task_approve",
  );
  const actor = actorRefSchema.parse(input.actor);
  if (actor.type !== "operator") {
    throw new Error("Only an operator may approve an AgentTask");
  }
  const task = await (deps.getTask ?? getAgentTask)(
    input.workItemId,
    input.taskVersion,
  );
  if (!task) {
    throw new Error("AgentTask approval target was not found");
  }
  if (
    task.lifecycle !== "proposed"
    || task.approval.status !== "pending"
  ) {
    throw new Error(
      "AgentTask approval requires a proposed task with pending approval",
    );
  }
  const decidedAt = nowIso(deps.now);
  if (Date.parse(task.deadline) <= Date.parse(decidedAt)) {
    throw new Error("Expired AgentTasks cannot be approved");
  }

  const approvedTaskHash = await hashAgentTaskApprovalPayload(task);
  const approved = agentTaskV1Schema.parse({
    ...task,
    lifecycle: "approved",
    approval: {
      ...task.approval,
      status: "approved",
      actor,
      decidedAt,
      approvedTaskHash,
    },
    timestamps: {
      ...task.timestamps,
      approvedAt: decidedAt,
      updatedAt: decidedAt,
    },
  });
  return (deps.putTask ?? putAgentTask)(approved);
}

export async function writeDispatchArtifact(
  bytes: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ArtifactRef> {
  const configuredRoot = environment.HARNESS_DISPATCH_ARTIFACT_DIR?.trim();
  if (!configuredRoot) {
    throw new Error("HARNESS_DISPATCH_ARTIFACT_DIR is required");
  }
  const hash = rawSha256(bytes);
  const reference = contentAddressedRef(hash);
  const root = path.resolve(configuredRoot);
  const target = path.join(root, `${hash.slice("sha256:".length)}.json`);
  await mkdir(root, { recursive: true });
  try {
    await writeFile(target, bytes, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(target, "utf8");
    if (existing !== bytes) {
      throw new Error("Content-addressed artifact bytes do not match");
    }
  }
  return reference;
}

function contentAddressedRef(
  hash: `sha256:${string}`,
): ArtifactRef {
  return artifactRefSchema.parse({
    uri: `artifact://sha256/${hash.slice("sha256:".length)}`,
    sha256: hash,
  });
}

function assertStoredArtifact(
  actualInput: ArtifactRef,
  expected: ArtifactRef,
): void {
  const actual = artifactRefSchema.parse(actualInput);
  if (
    actual.uri !== expected.uri
    || actual.sha256 !== expected.sha256
  ) {
    throw new Error(
      "Artifact writer returned a different content address",
    );
  }
}

function rawSha256(bytes: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

function nowIso(now: (() => Date) | undefined): string {
  const value = (now ?? (() => new Date()))();
  if (!Number.isFinite(value.getTime())) {
    throw new Error("AgentTask clock returned an invalid date");
  }
  return value.toISOString();
}
